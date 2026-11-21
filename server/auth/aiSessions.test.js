import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createHmac, randomBytes } from 'node:crypto'
import express from 'express'
import { createBrokerClient } from './brokerClient.js'
import { createAiAuth } from './aiSessions.js'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createIdentityRepository } from '../persistence/identityRepository.js'
import { errorHandler } from '../http/errorHandler.js'

/**
 * The per-person sign-in with the real broker client, the real session code, the real repository and a real socket, against a pretend
 * NUMZLAB (`numzlab`) that issues codes, signs statements and answers status checks the way numzlab-auth does.
 */

const SECRET = 's'.repeat(43)
const ORIGIN = 'https://lab.test'
const quiet = { error() {}, warn() {}, info() {}, log() {} }
const SUB = 'a1b2c3d4e5f6'
const SUB2 = 'b2c3d4e5f6a1'

function pretendNumzlab(clock) {
  const state = {
    users: new Map([
      [SUB, { status: 'active', role: 'viewer', email: 'a@example.com', name: 'Ada' }],
      [SUB2, { status: 'active', role: 'admin', email: 'b@example.com', name: 'Bo' }]
    ]),
    codes: new Map(), // code -> sub
    down: false,
    lookups: 0,
    exchanged: []
  }
  const sign = (claims) => {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
  }
  const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) })
  state.issue = (sub) => {
    const code = randomBytes(24).toString('base64url')
    state.codes.set(code, sub)
    return code
  }
  state.fetch = async (url, init) => {
    if (state.down) throw new Error('connect ECONNREFUSED')
    const path = new URL(url).pathname
    if (path === '/auth/broker/token') {
      const body = JSON.parse(init.body)
      state.exchanged.push(body)
      if (body.client_secret !== SECRET) return reply(401, { error: 'invalid_client' })
      const sub = state.codes.get(body.code)
      state.codes.delete(body.code)
      const user = state.users.get(sub)
      if (!user) return reply(400, { error: 'invalid_grant' })
      if (user.status !== 'active') return reply(400, { error: 'invalid_grant' })
      const now = Math.floor(clock() / 1000)
      return reply(200, {
        assertion: sign({ iss: 'numzlab-auth', aud: 'numz-ai', sub, email: user.email, name: user.name, role: user.role, permissions: ['ai.use'], status: 'active', iat: now, exp: now + 120, jti: randomBytes(8).toString('hex') }),
        expires_in: 120
      })
    }
    const m = path.match(/^\/auth\/broker\/user\/([0-9a-f]{12})$/)
    if (m) {
      state.lookups++
      const user = state.users.get(m[1])
      if (!user) return reply(404, { error: 'not found' })
      return reply(200, { sub: m[1], status: user.status, role: user.role, permissions: user.status === 'active' ? ['ai.use'] : [], updated: 1 })
    }
    return reply(404, {})
  }
  return state
}

async function rig({ basePath = '/ai', secure = true, allowed = null, idleS = 3600, maxS = 8 * 3600, revalidateS = 60, graceS = 600 } = {}) {
  let nowMs = Date.UTC(2026, 10, 21, 12, 0, 0)
  const clock = () => nowMs
  const database = createDatabase({ filename: ':memory:' })
  const repo = createIdentityRepository(database, { clock })
  const numzlab = pretendNumzlab(clock)
  const broker = createBrokerClient({
    brokerUrl: 'http://numzlab.test:18792',
    authorizeBase: ORIGIN,
    clientId: 'numz-ai',
    clientSecret: SECRET,
    redirectUri: `${ORIGIN}${basePath}/auth/callback`,
    fetchFn: numzlab.fetch,
    clock
  })
  const auth = createAiAuth({
    repo,
    broker,
    config: { publicOrigin: ORIGIN, basePath, secure, idleS, maxS, revalidateS, graceS, allowedExternalIds: allowed },
    clock,
    logger: quiet
  })
  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use('/auth', auth.browserRouter())
  app.use('/api/v1/assistant/auth', auth.jsonRouter())
  app.get('/api/echo', auth.requireSession('chat'), (req, res) => res.json({ user: req.identity.userId, role: req.identity.role, email: req.identity.email }))
  app.post('/api/echo', auth.requireSession('chat'), (req, res) => res.json({ ok: true }))
  app.get('/api/admin', auth.requireSession('ai.admin'), (_req, res) => res.json({ ok: true }))
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  function browser() {
    const jar = new Map()
    const api = {
      jar,
      cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v.value}`).join('; '),
      async call(path, { method = 'GET', headers = {}, body, origin = ORIGIN, csrf = undefined, noCookies = false } = {}) {
        const h = { ...headers }
        if (!noCookies && jar.size) h.cookie = api.cookieHeader()
        if (origin) h.origin = origin
        if (csrf) h['x-csrf-token'] = csrf
        if (body !== undefined) h['content-type'] = 'application/json'
        const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
        const raw = res.headers.getSetCookie?.() ?? []
        for (const line of raw) {
          const [pair, ...attrs] = line.split('; ')
          const eq = pair.indexOf('=')
          const name = pair.slice(0, eq)
          const value = pair.slice(eq + 1)
          if (attrs.some((a) => /^Max-Age=0$/i.test(a)) || !value) jar.delete(name)
          else jar.set(name, { value, attrs, line })
        }
        const text = await res.text()
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          /* not json */
        }
        return { status: res.status, headers: res.headers, json, text, setCookies: raw }
      },
      /** The whole sign-in as a browser does it: start, (NUMZLAB signs the person in), come back with a code. */
      async signIn(sub = SUB, { next } = {}) {
        const start = await api.call(`/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`)
        assert.equal(start.status, 302, start.text)
        const to = new URL(start.headers.get('location'))
        const code = numzlab.issue(sub)
        const back = await api.call(`/auth/callback?code=${code}&state=${to.searchParams.get('state')}`)
        return { start, to, back, code }
      },
      async status() {
        return (await api.call('/api/v1/assistant/auth/status')).json
      }
    }
    return api
  }

  return {
    auth,
    repo,
    database,
    numzlab,
    broker,
    base,
    browser,
    advance: (seconds) => {
      nowMs += seconds * 1000
    },
    now: () => nowMs,
    close: () => new Promise((resolve) => server.close(resolve)).then(() => auth.stop())
  }
}

test('signing in: the person is sent to NUMZLAB with a one-time state, and comes back with their own session', async () => {
  const r = await rig()
  try {
    const b = r.browser()
    const { start, to, back } = await b.signIn(SUB)
    assert.equal(`${to.origin}${to.pathname}`, `${ORIGIN}/auth/broker/authorize`)
    assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/ai/auth/callback`)
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256')
    // the in-flight record: sealed, on its own narrow path, short-lived
    const oauth = start.setCookies.find((c) => c.startsWith('__Secure-numzai_oauth='))
    assert.match(oauth, /; Path=\/ai\/auth; /)
    assert.match(oauth, /HttpOnly/)
    assert.match(oauth, /Max-Age=600/)
    assert.match(oauth, /SameSite=Lax/)
    assert.match(oauth, /; Secure/)

    assert.equal(back.status, 302)
    assert.equal(back.headers.get('location'), '/ai/')
    const session = back.setCookies.find((c) => c.startsWith('__Secure-numzai_session='))
    assert.ok(session, 'the session cookie is set')
    for (const part of ['Path=/ai', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=28800']) assert.ok(session.split('; ').includes(part), part)
    assert.ok(!/Domain=/i.test(session), 'host-only: it is never shared with another host')
    assert.ok(back.setCookies.some((c) => c.startsWith('__Secure-numzai_oauth=;') && /Max-Age=0/.test(c)), 'the in-flight record is cleared')
    assert.match(session.split('; ')[0].split('=')[1], /^[A-Za-z0-9_-]{40,}$/, 'a long random value')

    const echo = await b.call('/api/echo')
    assert.deepEqual(echo.json, { user: r.repo.getUserByExternal(SUB).id, role: 'viewer', email: 'a@example.com' })
    assert.notEqual(echo.json.user, SUB, 'NUMZ AI has its own id for the person; the NUMZLAB id is the key it is found by')
    assert.equal(echo.headers.get('cache-control'), 'no-store')
  } finally {
    await r.close()
  }
})

test('the session secret is never stored, only its hash; and the audit trail holds no secret, cookie or code', async () => {
  const r = await rig()
  try {
    const b = r.browser()
    const { code, back } = await b.signIn(SUB)
    const secret = b.jar.get('__Secure-numzai_session').value
    const rows = JSON.stringify(r.database.prepare('SELECT * FROM ai_sessions').all()) + JSON.stringify(r.database.prepare('SELECT * FROM ai_audit').all()) + JSON.stringify(r.database.prepare('SELECT * FROM ai_users').all())
    assert.ok(!rows.includes(secret))
    assert.ok(!rows.includes(code))
    assert.ok(!rows.includes(SECRET))
    assert.ok(rows.includes(r.repo.sha256(secret)), 'the hash is what is kept')
    assert.ok(r.repo.listAudit(50).some((e) => e.event === 'auth.login_ok'))
    assert.ok(back.status === 302)
  } finally {
    await r.close()
  }
})

test('a request with no session, a forged one or a hostile cookie is simply signed out', async () => {
  const r = await rig()
  try {
    const b = r.browser()
    const none = await b.call('/api/echo')
    assert.equal(none.status, 401)
    assert.equal(none.json.code, 'session-required')
    assert.equal(none.headers.get('www-authenticate'), 'Cookie')
    for (const cookie of ['__Secure-numzai_session=nope', '__Secure-numzai_session=' + 'A'.repeat(43), '__Secure-numzai_session=' + 'x'.repeat(5000), '__Secure-numzai_session=;;;=', `__Secure-numzai_session=${'%00'.repeat(10)}`]) {
      const res = await fetch(`${r.base}/api/echo`, { headers: { cookie } })
      assert.equal(res.status, 401, cookie.slice(0, 40))
    }
    // NUMZLAB's own cookie is not ours and means nothing here
    const dashboard = await fetch(`${r.base}/api/echo`, { headers: { cookie: '__Host-nl_session=anything; nl_session=anything' } })
    assert.equal(dashboard.status, 401)
    // identity can only come from the session: headers claiming one are ignored
    const claim = await fetch(`${r.base}/api/echo`, { headers: { 'x-auth-user': 'a@example.com', 'x-auth-role': 'admin', 'x-auth-id': SUB, authorization: 'Bearer x' } })
    assert.equal(claim.status, 401)
  } finally {
    await r.close()
  }
})

test('the return address after sign-in can only be a page of this app', async () => {
  const r = await rig()
  try {
    for (const [asked, landed] of [
      ['/ai/history.html', '/ai/history.html'],
      ['/ai/camera.html?x=1', '/ai/camera.html?x=1'],
      ['https://evil.example/', '/ai/'],
      ['//evil.example/', '/ai/'],
      ['/ai/../auth/x', '/ai/'],
      ['/elsewhere', '/ai/'],
      ['/ai/auth/login', '/ai/'],
      ['/aix', '/ai/'],
      ['javascript:alert(1)', '/ai/'],
      ['/ai/\r\nSet-Cookie: x=1', '/ai/'],
      ['/ai/' + 'a'.repeat(600), '/ai/']
    ]) {
      const b = r.browser()
      const { back } = await b.signIn(SUB, { next: asked })
      assert.equal(back.headers.get('location'), landed, asked.slice(0, 40))
    }
  } finally {
    await r.close()
  }
})

test('a sign-in that does not hold together comes back to the app with a generic reason, and no session', async () => {
  const r = await rig()
  try {
    const expectFail = async (label, run, reason = 'failed') => {
      const b = r.browser()
      const res = await run(b)
      assert.equal(res.status, 302, label)
      assert.equal(res.headers.get('location'), `/ai/?auth=${reason}`, label)
      assert.ok(!b.jar.has('__Secure-numzai_session'), `${label}: no session`)
    }
    // no sign-in in progress (no sealed cookie)
    await expectFail('no state cookie', (b) => b.call('/auth/callback?code=abc&state=def'))
    // the wrong state
    await expectFail('wrong state', async (b) => {
      await b.call('/auth/login')
      return b.call(`/auth/callback?code=${r.numzlab.issue(SUB)}&state=not-the-state`)
    })
    // a state cookie altered in flight
    await expectFail('altered state cookie', async (b) => {
      const start = await b.call('/auth/login')
      const state = new URL(start.headers.get('location')).searchParams.get('state')
      const current = b.jar.get('__Secure-numzai_oauth')
      b.jar.set('__Secure-numzai_oauth', { ...current, value: `${current.value.slice(0, 5)}X${current.value.slice(6)}` })
      return b.call(`/auth/callback?code=${r.numzlab.issue(SUB)}&state=${state}`)
    })
    // a state cookie used a second time
    await expectFail('replayed state', async (b) => {
      const start = await b.call('/auth/login')
      const state = new URL(start.headers.get('location')).searchParams.get('state')
      const kept = { ...b.jar.get('__Secure-numzai_oauth') }
      const first = await b.call(`/auth/callback?code=${r.numzlab.issue(SUB)}&state=${state}`)
      assert.equal(first.headers.get('location'), '/ai/')
      b.jar.clear()
      b.jar.set('__Secure-numzai_oauth', kept) // the same sealed state, offered again
      return b.call(`/auth/callback?code=${r.numzlab.issue(SUB2)}&state=${state}`)
    })
    // no code
    await expectFail('no code', async (b) => {
      const start = await b.call('/auth/login')
      return b.call(`/auth/callback?state=${new URL(start.headers.get('location')).searchParams.get('state')}`)
    })
    // a code NUMZLAB refuses
    await expectFail('refused code', async (b) => {
      const start = await b.call('/auth/login')
      return b.call(`/auth/callback?code=${'z'.repeat(30)}&state=${new URL(start.headers.get('location')).searchParams.get('state')}`)
    })
    // a person NUMZLAB did not approve
    r.numzlab.users.get(SUB).status = 'suspended'
    await expectFail('suspended at NUMZLAB', async (b) => {
      const start = await b.call('/auth/login')
      return b.call(`/auth/callback?code=${r.numzlab.issue(SUB)}&state=${new URL(start.headers.get('location')).searchParams.get('state')}`)
    })
    r.numzlab.users.get(SUB).status = 'active'
    // NUMZLAB cancelled / denied / failed
    await expectFail('denied', async (b) => {
      const start = await b.call('/auth/login')
      return b.call(`/auth/callback?error=access_denied&state=${new URL(start.headers.get('location')).searchParams.get('state')}`)
    }, 'denied')
    await expectFail('upstream trouble', async (b) => {
      const start = await b.call('/auth/login')
      return b.call(`/auth/callback?error=temporarily_unavailable&state=${new URL(start.headers.get('location')).searchParams.get('state')}`)
    }, 'unavailable')
    // NUMZLAB cannot be reached
    r.numzlab.down = true
    await expectFail('service down', async (b) => {
      const start = await b.call('/auth/login')
      return b.call(`/auth/callback?code=${r.numzlab.issue(SUB)}&state=${new URL(start.headers.get('location')).searchParams.get('state')}`)
    }, 'unavailable')
    r.numzlab.down = false
    assert.equal(r.database.prepare('SELECT COUNT(*) AS n FROM ai_sessions').get().n, 1, 'only the one deliberate sign-in made a session')
  } finally {
    await r.close()
  }
})

test('a staged roll-out: only the NUMZLAB ids on the list may sign in', async () => {
  const r = await rig({ allowed: new Set([SUB]) })
  try {
    const owner = r.browser()
    assert.equal((await owner.signIn(SUB)).back.headers.get('location'), '/ai/')
    const other = r.browser()
    const refused = await other.signIn(SUB2)
    assert.equal(refused.back.headers.get('location'), '/ai/?auth=denied')
    assert.ok(!other.jar.has('__Secure-numzai_session'))
    assert.equal(r.repo.getUserByExternal(SUB2), null, 'a person who is not let in leaves no record')
  } finally {
    await r.close()
  }
})

test('the session ends by idle time and by total time, and a later sign-in is a new session', async () => {
  const r = await rig({ idleS: 600, maxS: 3600 })
  try {
    const b = r.browser()
    await b.signIn(SUB)
    assert.equal((await b.call('/api/echo')).status, 200)
    r.advance(599)
    assert.equal((await b.call('/api/echo')).status, 200, 'still inside the idle window (and this request is activity)')
    r.advance(599)
    assert.equal((await b.call('/api/echo')).status, 200)
    r.advance(601)
    const idle = await b.call('/api/echo')
    assert.equal(idle.status, 401)
    assert.equal(idle.json.code, 'session-expired')
    // the status route is a poll: it must not keep a session alive
    const c = r.browser()
    await c.signIn(SUB)
    for (let i = 0; i < 5; i++) {
      r.advance(300)
      await c.status()
    }
    assert.equal((await c.call('/api/echo')).status, 401, 'polling the status did not count as use')
    // total lifetime, however busy the person is
    const d = r.browser()
    await d.signIn(SUB)
    for (let i = 0; i < 7; i++) {
      r.advance(500)
      assert.equal((await d.call('/api/echo')).status, 200)
    }
    r.advance(500)
    assert.equal((await d.call('/api/echo')).json.code, 'session-expired', 'one hour is the most, however busy')
    const first = await b.signIn(SUB)
    assert.equal(first.back.headers.get('location'), '/ai/')
    assert.equal((await b.call('/api/echo')).status, 200)
  } finally {
    await r.close()
  }
})

test('a state-changing request needs the session\'s CSRF token and our own origin; reading does not', async () => {
  const r = await rig()
  try {
    const b = r.browser()
    await b.signIn(SUB)
    const { csrf } = await b.status()
    assert.match(csrf, /^[A-Za-z0-9_-]{20,}$/)
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {} })).json.code, 'csrf-refused', 'no token')
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {}, csrf: 'wrong' })).json.code, 'csrf-refused')
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {}, csrf, origin: 'https://evil.example' })).json.code, 'origin-refused')
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {}, csrf, origin: ORIGIN.replace('https', 'http') })).json.code, 'origin-refused')
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {}, csrf, origin: null, headers: { 'sec-fetch-site': 'cross-site' } })).json.code, 'origin-refused')
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {}, csrf, origin: null, headers: { 'sec-fetch-site': 'same-site' } })).json.code, 'origin-refused', 'a sibling site is not us')
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {}, csrf, origin: null })).json.code, 'origin-refused', 'no origin and no fetch metadata: not proven')
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {}, csrf, origin: ORIGIN })).status, 200)
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {}, csrf, origin: null, headers: { 'sec-fetch-site': 'same-origin' } })).status, 200)
    // another session's token is no good
    const other = r.browser()
    await other.signIn(SUB2)
    assert.equal((await b.call('/api/echo', { method: 'POST', body: {}, csrf: (await other.status()).csrf })).json.code, 'csrf-refused')
    // reads need neither
    assert.equal((await b.call('/api/echo', { origin: 'https://evil.example' })).status, 200)
    assert.ok(r.repo.listAudit(50).some((e) => e.event === 'csrf.refused') && r.repo.listAudit(50).some((e) => e.event === 'origin.refused'))
  } finally {
    await r.close()
  }
})

test('capabilities: an administrator gets the admin routes, a viewer a plain 403', async () => {
  const r = await rig()
  try {
    const viewer = r.browser()
    await viewer.signIn(SUB)
    assert.equal((await viewer.call('/api/admin')).status, 403)
    const admin = r.browser()
    await admin.signIn(SUB2)
    assert.equal((await admin.call('/api/admin')).status, 200)
    const status = await admin.status()
    assert.ok(status.user.capabilities.includes('ai.admin'))
    assert.ok(!(await viewer.status()).user.capabilities.includes('ai.admin'))
  } finally {
    await r.close()
  }
})

test('suspension at NUMZLAB ends the person\'s access within the re-check time, everywhere at once', async () => {
  const r = await rig({ revalidateS: 60 })
  try {
    const laptop = r.browser()
    const phone = r.browser()
    await laptop.signIn(SUB)
    await phone.signIn(SUB)
    const closed = []
    const fakeSocket = { once() {}, close: (code, reason) => closed.push([code, reason]) }
    const echoed = await laptop.call('/api/echo')
    r.auth.trackSocket({ userId: echoed.json.user }, fakeSocket, 'hash-not-needed')
    const lookups = r.numzlab.lookups

    r.advance(30)
    r.numzlab.users.get(SUB).status = 'suspended'
    assert.equal((await laptop.call('/api/echo')).status, 200, 'inside the re-check window the last answer stands')
    assert.equal(r.numzlab.lookups, lookups)

    r.advance(40) // past 60 s since the last check
    const stopped = await laptop.call('/api/echo')
    assert.equal(stopped.status, 401)
    assert.equal(stopped.json.code, 'access-revoked')
    assert.equal((await phone.call('/api/echo')).json.code, 'access-revoked', 'the other device too')
    assert.deepEqual(closed, [[4401, 'access-revoked']], 'and the open socket is closed')
    assert.equal(r.repo.getUserByExternal(SUB).status, 'revoked')
    assert.equal(r.database.prepare('SELECT COUNT(*) AS n FROM ai_sessions WHERE revoked_at IS NULL').get().n, 0)
    assert.ok(r.repo.listAudit(20).some((e) => e.event === 'identity.revoked'))

    // reinstated at NUMZLAB: a fresh sign-in works, with the same NUMZ AI person (and so the same conversations)
    const id = r.repo.getUserByExternal(SUB).id
    r.numzlab.users.get(SUB).status = 'active'
    await laptop.signIn(SUB)
    assert.equal((await laptop.call('/api/echo')).json.user, id)
  } finally {
    await r.close()
  }
})

test('removal and a missing person at NUMZLAB are the same as suspension; a role change applies at once without signing in again', async () => {
  const r = await rig({ revalidateS: 60 })
  try {
    const b = r.browser()
    await b.signIn(SUB)
    r.advance(61)
    r.numzlab.users.get(SUB).role = 'admin'
    assert.equal((await b.call('/api/admin')).status, 200, 'promoted at NUMZLAB: the admin route opens')
    r.advance(61)
    r.numzlab.users.get(SUB).role = 'viewer'
    assert.equal((await b.call('/api/admin')).status, 403, 'demoted: closed again, still signed in')
    r.advance(61)
    r.numzlab.users.delete(SUB)
    assert.equal((await b.call('/api/echo')).json.code, 'access-revoked')
  } finally {
    await r.close()
  }
})

test('if NUMZLAB cannot be asked the last answer stands for a grace period, then access stops (it never fails open)', async () => {
  const r = await rig({ revalidateS: 60, graceS: 600 })
  try {
    const b = r.browser()
    await b.signIn(SUB)
    r.numzlab.down = true
    r.advance(120)
    assert.equal((await b.call('/api/echo')).status, 200, 'inside the grace period')
    r.advance(400)
    assert.equal((await b.call('/api/echo')).status, 200, 'still inside (about 520 s since the last good answer)')
    r.advance(200)
    const late = await b.call('/api/echo')
    assert.equal(late.status, 503)
    assert.equal(late.json.code, 'identity-unavailable')
    assert.ok(r.repo.listAudit(20).some((e) => e.event === 'identity.unavailable'))
    r.numzlab.down = false
    assert.equal((await b.call('/api/echo')).status, 200, 'and it recovers on its own when NUMZLAB is back')
  } finally {
    await r.close()
  }
})

test('many requests at once cause one re-check, not one each', async () => {
  const r = await rig({ revalidateS: 60 })
  try {
    const b = r.browser()
    await b.signIn(SUB)
    r.advance(90)
    const before = r.numzlab.lookups
    const results = await Promise.all(Array.from({ length: 12 }, () => b.call('/api/echo')))
    assert.ok(results.every((x) => x.status === 200))
    assert.equal(r.numzlab.lookups - before, 1)
  } finally {
    await r.close()
  }
})

test('sign out ends only this session; the person\'s other devices and NUMZLAB itself are not touched', async () => {
  const r = await rig()
  try {
    const a = r.browser()
    const c = r.browser()
    await a.signIn(SUB)
    await c.signIn(SUB)
    const lookupsBefore = r.numzlab.lookups
    const csrf = (await a.status()).csrf
    assert.equal((await a.call('/api/v1/assistant/auth/logout', { method: 'POST' })).status, 403, 'needs the token')
    const out = await a.call('/api/v1/assistant/auth/logout', { method: 'POST', csrf })
    assert.equal(out.status, 204)
    assert.ok(out.setCookies.some((x) => x.startsWith('__Secure-numzai_session=;') && /Max-Age=0/.test(x) && /Path=\/ai/.test(x)))
    assert.equal((await a.call('/api/echo')).status, 401)
    assert.equal((await c.call('/api/echo')).status, 200, 'the other device is still in')
    assert.equal(r.numzlab.lookups, lookupsBefore, 'NUMZLAB was not asked or told anything')
    // signing out when already out is fine
    assert.equal((await r.browser().call('/api/v1/assistant/auth/logout', { method: 'POST' })).status, 204)
    // the old cookie, replayed, is dead
    const stale = r.browser()
    stale.jar.set('__Secure-numzai_session', { value: 'x' })
    assert.equal((await stale.call('/api/echo')).status, 401)
  } finally {
    await r.close()
  }
})

test('a person can list their own sessions and end one; they cannot touch anybody else\'s', async () => {
  const r = await rig()
  try {
    const a = r.browser()
    const phone = r.browser()
    const other = r.browser()
    await a.signIn(SUB)
    await phone.signIn(SUB)
    await other.signIn(SUB2)
    const { sessions } = (await a.call('/api/v1/assistant/auth/sessions')).json
    assert.equal(sessions.length, 2)
    assert.equal(sessions.filter((s) => s.current).length, 1)
    const theirs = (await other.call('/api/v1/assistant/auth/sessions')).json.sessions[0].handle
    const csrf = (await a.status()).csrf
    const mine = sessions.find((s) => !s.current).handle
    assert.equal((await a.call(`/api/v1/assistant/auth/sessions/${theirs}`, { method: 'DELETE', csrf })).status, 404, 'someone else\'s session is not found')
    assert.equal((await other.call('/api/echo')).status, 200)
    assert.equal((await a.call(`/api/v1/assistant/auth/sessions/${mine}`, { method: 'DELETE', csrf })).status, 204)
    assert.equal((await phone.call('/api/echo')).status, 401)
    assert.equal((await a.call('/api/echo')).status, 200)
    assert.equal((await a.call('/api/v1/assistant/auth/sessions/not-a-handle', { method: 'DELETE', csrf })).status, 400)
  } finally {
    await r.close()
  }
})

test('the status route tells the page what it needs, and never anything about someone else', async () => {
  const r = await rig()
  try {
    const b = r.browser()
    const out = await b.status()
    assert.deepEqual(out, { mode: 'broker', required: true, misconfigured: false, authenticated: false, reason: 'session-required', loginUrl: '/ai/auth/login' })
    await b.signIn(SUB)
    const inn = await b.status()
    assert.equal(inn.authenticated, true)
    assert.deepEqual(Object.keys(inn.user).sort(), ['capabilities', 'email', 'id', 'name', 'role'])
    assert.ok(inn.expiresIn > 0 && inn.idleIn > 0)
    r.advance(4000)
    assert.equal((await b.status()).reason, 'session-expired')
    // the code login that existed before is not a way in here
    assert.equal((await r.browser().call('/api/v1/assistant/auth/login', { method: 'POST', body: { code: 'anything-at-all' } })).status, 404)
  } finally {
    await r.close()
  }
})

test('without a base path (a local run) the cookies use the root, and without HTTPS they carry no Secure prefix', async () => {
  const r = await rig({ basePath: '', secure: false })
  try {
    const b = r.browser()
    const { start, back } = await b.signIn(SUB)
    assert.ok(start.setCookies.some((c) => c.startsWith('numzai_oauth=') && /Path=\/auth;/.test(c)))
    const session = back.setCookies.find((c) => c.startsWith('numzai_session='))
    assert.ok(session && /Path=\/;/.test(session) && !/Secure/.test(session))
    assert.equal(back.headers.get('location'), '/')
    assert.equal((await b.call('/api/echo')).status, 200)
  } finally {
    await r.close()
  }
})

test('sign-in attempts are rate limited per address', async () => {
  const r = await rig()
  try {
    const b = r.browser()
    let last
    for (let i = 0; i < 32; i++) last = await b.call('/auth/login')
    assert.equal(last.status, 429)
    assert.ok(r.repo.listAudit(50).some((e) => e.event === 'rate.limited'))
  } finally {
    await r.close()
  }
})

test('sockets: an upgrade needs our own origin and a live session; the sockets of a revoked person are closed', async () => {
  const r = await rig()
  try {
    const b = r.browser()
    await b.signIn(SUB)
    const request = (extra = {}) => ({ headers: { cookie: b.cookieHeader(), origin: ORIGIN, ...extra }, socket: { remoteAddress: '127.0.0.1' } })
    const ok = await r.auth.authorizeUpgrade(request(), 'chat')
    assert.equal(ok.ok, true)
    assert.equal(ok.identity.role, 'viewer')
    const foreign = await r.auth.authorizeUpgrade(request({ origin: 'https://evil.example' }), 'chat')
    assert.deepEqual([foreign.ok, foreign.status, foreign.code], [false, 403, 'origin-refused'])
    const noOrigin = await r.auth.authorizeUpgrade({ headers: { cookie: b.cookieHeader() }, socket: {} }, 'chat')
    assert.equal(noOrigin.code, 'origin-refused')
    const noCookie = await r.auth.authorizeUpgrade({ headers: { origin: ORIGIN }, socket: {} }, 'chat')
    assert.deepEqual([noCookie.ok, noCookie.status, noCookie.code], [false, 401, 'session-required'])
    const noRight = await r.auth.authorizeUpgrade(request(), 'ai.admin')
    assert.equal(noRight.status, 403)
    assert.ok(r.repo.listAudit(50).some((e) => e.event === 'ws.refused'))

    const closed = []
    r.auth.trackSocket(ok.identity, { once() {}, close: (...args) => closed.push(args) }, ok.idHash)
    r.auth.revokeUser(ok.identity.userId, 'test')
    assert.deepEqual(closed, [[4401, 'access-revoked']])
    assert.equal((await r.auth.authorizeUpgrade(request(), 'chat')).code, 'access-revoked')
  } finally {
    await r.close()
  }
})

test('the maintenance sweep closes sockets whose session has ended, and re-checks the people holding them', async () => {
  const r = await rig({ idleS: 600, revalidateS: 60 })
  try {
    const b = r.browser()
    await b.signIn(SUB)
    const request = { headers: { cookie: b.cookieHeader(), origin: ORIGIN }, socket: {} }
    const verdict = await r.auth.authorizeUpgrade(request, 'chat')
    const closed = []
    r.auth.trackSocket(verdict.identity, { once() {}, close: (...a) => closed.push(a) }, verdict.idHash)
    r.advance(90)
    r.numzlab.users.get(SUB).status = 'suspended'
    await r.auth.maintain()
    assert.deepEqual(closed, [[4401, 'access-revoked']], 'a suspended person with an idle socket is cut off by the sweep, not at their next request')
    const two = r.browser()
    await two.signIn(SUB2)
    const v2 = await r.auth.authorizeUpgrade({ headers: { cookie: two.cookieHeader(), origin: ORIGIN }, socket: {} }, 'chat')
    const closed2 = []
    r.auth.trackSocket(v2.identity, { once() {}, close: (...a) => closed2.push(a) }, v2.idHash)
    r.advance(700)
    await r.auth.maintain()
    assert.deepEqual(closed2, [[4401, 'session-ended']], 'idle for too long')
  } finally {
    await r.close()
  }
})
