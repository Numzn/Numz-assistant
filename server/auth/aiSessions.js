import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { BrokerRefused, BrokerUnavailable, pkcePair } from './brokerClient.js'
import { can, personIdentity } from './identity.js'
import { createOriginGuard } from './originGuard.js'
import { isKnownRole } from './rolePolicy.js'
import { readCookie, sendAuthError as deny } from './authPrimitives.js'

/**
 * NUMZ AI's own sign-in and sessions (the NUMZLAB identity broker proves who a person is; everything after that is ours).
 *
 *   Independent   a session here is a row in OUR database behind OUR cookie. NUMZLAB's cookie is never read, forwarded or relied on, so
 *                 signing out of one never signs out of the other, and NUMZ AI works with no NUMZLAB dashboard session at all.
 *   Cookie        __Secure-numzai_session, HttpOnly, Secure, SameSite=Lax, Path = the app's base path (/ai): it is never sent to any
 *                 other part of the site. 256 random bits; only their SHA-256 is stored.
 *   Lifetime      absolute (default 8 h) and idle (default 60 min); a login always makes a NEW session.
 *   Revocation    the person's NUMZLAB status is re-checked at most every `revalidateS` seconds (default 60) while they use the app. A
 *                 suspended or removed person loses every session and open socket at the next check. If NUMZLAB cannot be reached the
 *                 last answer stands for `graceS` seconds (default 10 min), then access stops: it never fails open.
 *   Identity      only `req.identity`, built here from the session row. Nothing in a header, query or body can name a user.
 */

const SESSION_TOUCH_EVERY_S = 15
const LOGIN_RATE = { limit: 30, windowMs: 15 * 60_000 }
const NEXT_OK = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]{0,512}$/

export function createAiAuth({ repo, broker, config = {}, clock = Date.now, logger = console, meter = null }) {
  const cfg = {
    publicOrigin: '',
    basePath: '', // '/ai' when served under /ai/, else ''
    idleS: 3600,
    maxS: 8 * 3600,
    revalidateS: 60,
    graceS: 600,
    secure: true,
    allowedExternalIds: null, // a Set: only these NUMZLAB user ids may sign in (a staged roll-out); null = everyone NUMZLAB approves
    ...config
  }
  const guard = createOriginGuard({ publicOrigin: cfg.publicOrigin })
  const sessionName = cfg.secure ? '__Secure-numzai_session' : 'numzai_session'
  const oauthName = cfg.secure ? '__Secure-numzai_oauth' : 'numzai_oauth'
  const sessionPath = cfg.basePath || '/'
  const oauthPath = `${cfg.basePath}/auth`
  const nowS = () => Math.floor(clock() / 1000)

  const inflight = new Map() // user id -> pending revalidation
  const touched = new Map() // id_hash -> last write (s)
  const sockets = new Map() // user id -> Set<{ ws, idHash }>
  const logins = new Map() // ip -> timestamps
  let unavailableLogged = 0
  let timer = null

  const audit = (event, fields = {}) => {
    try {
      repo.audit({ event, ...fields })
    } catch (err) {
      logger.error('[ai-auth] audit failed', err?.message ?? err)
    }
  }

  const cookie = (name, value, { path, maxAge }) =>
    `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.secure ? '; Secure' : ''}`

  function limited(ip) {
    const now = clock()
    const stamps = (logins.get(ip) ?? []).filter((t) => now - t < LOGIN_RATE.windowMs)
    if (stamps.length >= LOGIN_RATE.limit) return true
    stamps.push(now)
    logins.set(ip, stamps)
    if (logins.size > 5000) logins.clear()
    return false
  }

  function safeNext(value) {
    const fallback = `${cfg.basePath}/`
    if (typeof value !== 'string' || !NEXT_OK.test(value) || value.startsWith('//')) return fallback
    const inApp = cfg.basePath ? value === cfg.basePath || value.startsWith(`${cfg.basePath}/`) || value.startsWith(`${cfg.basePath}?`) : true
    if (!inApp || value.includes('/auth/') || value.startsWith(`${cfg.basePath}/auth`)) return fallback
    return value
  }

  // ---- sockets -------------------------------------------------------------------------------------------------
  function trackSocket(identity, ws, idHash) {
    const set = sockets.get(identity.userId) ?? new Set()
    const entry = { ws, idHash }
    set.add(entry)
    sockets.set(identity.userId, set)
    ws.once?.('close', () => {
      set.delete(entry)
      if (!set.size) sockets.delete(identity.userId)
    })
    return entry
  }

  function closeSockets(userId, code = 4401, reason = 'access-revoked', only = null) {
    for (const entry of [...(sockets.get(userId) ?? [])]) {
      if (only && entry.idHash !== only) continue
      try {
        entry.ws.close(code, reason)
      } catch {
        /* already gone */
      }
    }
  }

  function revokeUser(userId, reason) {
    repo.setUserStatus(userId, 'revoked')
    const sessions = repo.revokeUserSessions(userId, reason)
    closeSockets(userId, 4401, 'access-revoked')
    audit('identity.revoked', { userId, detail: { reason, sessions } })
    return sessions
  }

  // ---- is this person still approved? ---------------------------------------------------------------------------
  async function verify(row, age) {
    try {
      const found = await broker.lookupUser(row.external_id)
      if (found.status !== 'active' || !found.permissions.includes('ai.use') || !isKnownRole(found.role)) {
        revokeUser(row.user_id, found.status === 'active' ? 'permission-removed' : `account-${found.status}`)
        return { ok: false, status: 401, code: 'access-revoked', message: 'Your access to NUMZ AI has ended.' }
      }
      repo.markVerified(row.user_id, found.role)
      return { ok: true, role: found.role }
    } catch (err) {
      if (age <= cfg.graceS) {
        if (clock() - unavailableLogged > 60_000) {
          unavailableLogged = clock()
          audit('identity.unavailable', { userId: row.user_id, detail: { graceLeftS: Math.round(cfg.graceS - age), why: err?.name ?? 'error' } })
        }
        return { ok: true, role: row.role }
      }
      return { ok: false, status: 503, code: 'identity-unavailable', message: 'NUMZ AI cannot confirm your access right now. Try again shortly.' }
    }
  }

  function ensureFresh(row) {
    const age = (clock() - (Date.parse(row.last_verified_at) || 0)) / 1000
    if (age < cfg.revalidateS) return Promise.resolve({ ok: true, role: row.role })
    let pending = inflight.get(row.user_id)
    if (!pending) {
      pending = verify(row, age).finally(() => inflight.delete(row.user_id))
      inflight.set(row.user_id, pending)
    }
    return pending
  }

  // ---- the session behind a request ------------------------------------------------------------------------------
  const failure = (status, code, message) => ({ ok: false, status, code, message })

  async function authenticate(req, { touch = true } = {}) {
    const secret = readCookie(req, sessionName)
    if (!secret) return failure(401, 'session-required', 'Sign in to use NUMZ AI.')
    const row = repo.findSession(secret)
    if (!row) return failure(401, 'session-required', 'Sign in to use NUMZ AI.')
    const now = nowS()
    if (row.status !== 'active') return failure(401, 'access-revoked', 'Your access to NUMZ AI has ended.')
    if (row.revoked_at) return failure(401, 'session-expired', 'Your session has ended. Sign in again.')
    if (row.expires_at <= now || row.last_activity_at + cfg.idleS <= now) return failure(401, 'session-expired', 'Your session has ended. Sign in again.')
    const fresh = await ensureFresh(row)
    if (!fresh.ok) return fresh
    if (touch && now - (touched.get(row.id_hash) ?? 0) >= SESSION_TOUCH_EVERY_S) {
      repo.touch(row.id_hash)
      touched.set(row.id_hash, now)
      if (touched.size > 10_000) touched.clear()
    }
    const identity = personIdentity({ ...row, id: row.user_id, role: fresh.role }, { ref: row.id_hash.slice(0, 8), csrf: row.csrf })
    return { ok: true, identity, idHash: row.id_hash, expiresAt: row.expires_at, idleUntil: Math.max(row.last_activity_at, touched.get(row.id_hash) ?? 0) + cfg.idleS }
  }

  /**
   * Express middleware: only a signed-in person with `capability` gets through. State-changing requests also need their CSRF token and
   * a same-origin request. Sets req.identity (the ONLY source of "who").
   */
  function requireSession(capability = null, { touch = true, csrf = true } = {}) {
    return async (req, res, next) => {
      try {
        const result = await authenticate(req, { touch })
        res.set('Cache-Control', 'no-store')
        if (!result.ok) {
          if (result.status === 401) res.set('WWW-Authenticate', 'Cookie')
          return deny(res, req, result.status, result.code, result.message)
        }
        if (capability && !can(result.identity, capability)) {
          audit('authz.denied', { userId: result.identity.userId, sessionRef: result.identity.sessionRef, ip: req.ip, requestId: req.id, detail: { capability } })
          return deny(res, req, 403, 'forbidden', 'You are not allowed to do that.')
        }
        if (csrf) {
          const problem = guard.check(req, result.identity.csrf)
          if (problem) {
            audit(problem === 'origin-refused' ? 'origin.refused' : 'csrf.refused', { userId: result.identity.userId, sessionRef: result.identity.sessionRef, ip: req.ip, requestId: req.id, detail: { method: req.method } })
            return deny(res, req, 403, problem, 'That request was not accepted.')
          }
        }
        req.identity = result.identity
        req.idHash = result.idHash
        next()
      } catch (err) {
        next(err)
      }
    }
  }

  /** A WebSocket upgrade: same rules, but the Origin must be present and ours. { ok, identity, idHash } or { ok: false, status, code }. */
  async function authorizeUpgrade(req, capability = null) {
    if (!guard.websocketOriginAllowed(req)) {
      audit('ws.refused', { ip: req.socket?.remoteAddress ?? null, detail: { why: 'origin' } })
      return { ok: false, status: 403, code: 'origin-refused' }
    }
    const result = await authenticate(req, { touch: false })
    if (!result.ok) {
      audit('ws.refused', { ip: req.socket?.remoteAddress ?? null, detail: { why: result.code } })
      return { ok: false, status: result.status, code: result.code }
    }
    if (capability && !can(result.identity, capability)) return { ok: false, status: 403, code: 'forbidden' }
    return { ok: true, identity: result.identity, idHash: result.idHash }
  }

  function touchSession(idHash) {
    const now = nowS()
    if (now - (touched.get(idHash) ?? 0) >= SESSION_TOUCH_EVERY_S) {
      repo.touch(idHash)
      touched.set(idHash, now)
    }
  }

  // ---- browser routes: /auth/login, /auth/callback ------------------------------------------------------------------
  function browserRouter() {
    const router = Router()

    router.get('/login', (req, res) => {
      if (limited(req.ip)) {
        audit('rate.limited', { ip: req.ip, requestId: req.id, detail: { route: 'login' } })
        return res.status(429).type('text/plain').send('Too many attempts. Wait a few minutes.')
      }
      const { verifier, challenge } = pkcePair()
      const state = randomBytes(18).toString('base64url')
      const sealed = broker.sealState({ state, verifier, next: safeNext(String(req.query.next ?? '')), exp: nowS() + 600 })
      audit('auth.login_start', { ip: req.ip, requestId: req.id })
      res.set('Cache-Control', 'no-store')
      res.set('Set-Cookie', cookie(oauthName, sealed, { path: oauthPath, maxAge: 600 }))
      res.redirect(302, broker.authorizeUrl({ state, challenge }))
    })

    router.get('/callback', async (req, res) => {
      const clearOauth = cookie(oauthName, '', { path: oauthPath, maxAge: 0 })
      const back = (result) => {
        res.set('Cache-Control', 'no-store')
        res.set('Set-Cookie', clearOauth)
        res.redirect(302, `${cfg.basePath}/?auth=${result}`)
      }
      if (limited(req.ip)) {
        audit('rate.limited', { ip: req.ip, requestId: req.id, detail: { route: 'callback' } })
        return back('failed')
      }
      const saved = broker.openState(readCookie(req, oauthName))
      const { code, state, error } = req.query
      if (!saved) {
        audit('auth.login_refused', { ip: req.ip, requestId: req.id, detail: { why: 'state' } })
        return back('failed')
      }
      if (typeof state !== 'string' || state !== saved.state) {
        audit('auth.login_refused', { ip: req.ip, requestId: req.id, detail: { why: 'state-mismatch' } })
        return back('failed')
      }
      if (typeof error === 'string') {
        audit('auth.login_denied', { ip: req.ip, requestId: req.id, detail: { why: error === 'access_denied' ? 'denied' : 'upstream' } })
        return back(error === 'access_denied' ? 'denied' : 'unavailable')
      }
      if (typeof code !== 'string' || !code) return back('failed')

      let claims
      try {
        claims = await broker.exchange({ code, verifier: saved.verifier })
      } catch (err) {
        const unavailable = err instanceof BrokerUnavailable
        audit(unavailable ? 'auth.login_unavailable' : 'auth.login_refused', { ip: req.ip, requestId: req.id, detail: { why: err instanceof BrokerRefused ? err.code : 'unavailable' } })
        return back(unavailable ? 'unavailable' : 'failed')
      }
      if (cfg.allowedExternalIds && !cfg.allowedExternalIds.has(claims.sub)) {
        audit('auth.login_denied', { ip: req.ip, requestId: req.id, detail: { why: 'not-in-rollout' } })
        return back('denied')
      }
      if (!isKnownRole(claims.role)) {
        audit('auth.login_refused', { ip: req.ip, requestId: req.id, detail: { why: 'role' } })
        return back('failed')
      }
      const user = repo.upsertUser({ externalId: claims.sub, email: claims.email, name: claims.name, role: claims.role })
      const session = repo.createSession({ userId: user.id, ttlSeconds: cfg.maxS, ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '') })
      audit('auth.login_ok', { userId: user.id, sessionRef: session.ref, ip: req.ip, requestId: req.id, detail: { role: user.role } })
      res.set('Cache-Control', 'no-store')
      res.set('Set-Cookie', [cookie(sessionName, session.secret, { path: sessionPath, maxAge: cfg.maxS }), clearOauth])
      res.redirect(302, safeNext(saved.next))
    })

    return router
  }

  // ---- JSON routes: /api/v1/assistant/auth/* ---------------------------------------------------------------------------
  function jsonRouter() {
    const router = Router()
    const loginUrl = `${cfg.basePath}/auth/login`

    router.get('/status', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store')
        const result = await authenticate(req, { touch: false })
        if (!result.ok) {
          return res.json({ mode: 'broker', required: true, misconfigured: false, authenticated: false, reason: result.code, loginUrl })
        }
        const { identity } = result
        res.json({
          mode: 'broker',
          required: true,
          misconfigured: false,
          authenticated: true,
          loginUrl,
          csrf: identity.csrf,
          user: { id: identity.userId, name: identity.name, email: identity.email, role: identity.role, capabilities: [...identity.capabilities] },
          expiresIn: Math.max(0, result.expiresAt - nowS()),
          idleIn: Math.max(0, result.idleUntil - nowS())
        })
      } catch (err) {
        next(err)
      }
    })

    // The code login does not exist in this mode.
    router.post('/login', (req, res) => deny(res, req, 404, 'login-is-with-google', 'Sign in with Google.'))

    router.post('/logout', async (req, res, next) => {
      try {
        const result = await authenticate(req, { touch: false })
        if (result.ok) {
          const problem = guard.check(req, result.identity.csrf)
          if (problem) return deny(res, req, 403, problem, 'That request was not accepted.')
          repo.revokeSession(result.idHash, 'logout')
          closeSockets(result.identity.userId, 4401, 'signed-out', result.idHash)
          audit('auth.logout', { userId: result.identity.userId, sessionRef: result.identity.sessionRef, ip: req.ip, requestId: req.id })
        }
        res.set('Cache-Control', 'no-store')
        res.set('Set-Cookie', cookie(sessionName, '', { path: sessionPath, maxAge: 0 }))
        res.status(204).end()
      } catch (err) {
        next(err)
      }
    })

    router.get('/sessions', requireSession(null, { touch: false }), (req, res) => {
      res.json({ sessions: repo.listSessions(req.identity.userId).map((s) => ({ ...s, current: s.handle === req.idHash.slice(0, 12) })) })
    })

    router.delete('/sessions/:handle', requireSession(), (req, res) => {
      const handle = String(req.params.handle)
      if (!/^[0-9a-f]{12}$/.test(handle)) return deny(res, req, 400, 'bad-handle', 'That is not a session.')
      const n = repo.revokeSessionByHandle(req.identity.userId, handle, 'revoked by the person')
      if (!n) return deny(res, req, 404, 'not-found', 'No such session.')
      for (const entry of [...(sockets.get(req.identity.userId) ?? [])]) if (entry.idHash.startsWith(handle)) entry.ws.close?.(4401, 'signed-out')
      audit('session.revoked', { userId: req.identity.userId, sessionRef: req.identity.sessionRef, ip: req.ip, requestId: req.id, detail: { by: 'owner' } })
      res.status(204).end()
    })

    return router
  }

  // ---- housekeeping ---------------------------------------------------------------------------------------------------
  async function maintain() {
    try {
      repo.sweep()
      for (const [userId, set] of sockets) {
        for (const entry of [...set]) {
          const row = repo.findSessionByHash(entry.idHash)
          const now = nowS()
          if (!row || row.revoked_at || row.status !== 'active' || row.expires_at <= now || row.last_activity_at + cfg.idleS <= now) {
            entry.ws.close?.(4401, 'session-ended')
            continue
          }
          await ensureFresh(row) // a suspended person's idle socket is closed here, not at their next request
        }
        if (!set.size) sockets.delete(userId)
      }
    } catch (err) {
      logger.error('[ai-auth] maintenance failed', err?.message ?? err)
    }
  }

  return {
    mode: 'broker',
    config: Object.freeze({ ...cfg, allowedExternalIds: cfg.allowedExternalIds ? [...cfg.allowedExternalIds] : null }),
    meter,
    requireSession,
    authorizeUpgrade,
    authenticate,
    browserRouter,
    jsonRouter,
    trackSocket,
    touchSession,
    revokeUser,
    status: () => ({ mode: 'broker', required: true, misconfigured: false }),
    start() {
      if (!timer) {
        timer = setInterval(maintain, 30_000)
        timer.unref?.()
      }
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
    maintain
  }
}
