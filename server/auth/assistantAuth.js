import { Router } from 'express'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Access control for the assistant API (/api/v1/assistant/*, its WebSocket, and the DeepSeek probe).
 *
 * One shared access code (ASSISTANT_ACCESS_CODE) that a person types once. It is exchanged for a signed,
 * expiring session cookie (HttpOnly, SameSite=Strict, Secure over HTTPS), so the browser's JavaScript never
 * holds the code, HTTP and WebSocket requests both carry the cookie, and no client code has to attach a token.
 *
 *   - unset: DISABLED. Behaviour is exactly what it was before this existed (open), and a warning says so.
 *   - 12+ characters: ENABLED.
 *   - set but shorter: MISCONFIGURED. Fails closed: every protected route answers 503 until it is fixed.
 *     Silently falling back to "open" on a typo would be the worst outcome for a security setting.
 *
 * The cookie is an HMAC over its own expiry, keyed from the access code. Changing the code signs everyone out.
 * Wrong codes are throttled (10 a minute, counted across all callers, as the meeting launch code is).
 */

export const COOKIE_NAME = 'numz_assistant_session'
export const MIN_CODE_LENGTH = 12
const VERSION = 'v1'
const FAILURE_LIMIT = 10
const FAILURE_WINDOW_MS = 60_000

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest()

/** Constant-time comparison (digests give equal lengths for timingSafeEqual). */
function secretsEqual(candidate, expected) {
  return timingSafeEqual(digest(candidate), digest(expected))
}

function readCookie(req, name) {
  const header = req.headers?.cookie
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

function isHttps(req) {
  if (req.secure) return true
  const forwarded = String(req.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  return forwarded === 'https'
}

function deny(res, req, status, code, message) {
  return res.status(status).json({ error: message, code, requestId: req.id })
}

export function createAssistantAuth({ accessCode = '', ttlSeconds = 12 * 3600, clock = () => Date.now(), logger = console } = {}) {
  const code = typeof accessCode === 'string' ? accessCode.trim() : ''
  const mode = !code ? 'disabled' : code.length >= MIN_CODE_LENGTH ? 'enabled' : 'misconfigured'
  if (mode === 'disabled') {
    logger.warn('[assistant-auth] ASSISTANT_ACCESS_CODE is not set: the assistant API is open to anyone who can reach this server')
  } else if (mode === 'misconfigured') {
    logger.warn(`[assistant-auth] ASSISTANT_ACCESS_CODE must be at least ${MIN_CODE_LENGTH} characters; the assistant API is LOCKED until it is fixed`)
  }

  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : 12 * 3600
  const key = createHmac('sha256', code).update('numz-assistant-session-key-v1').digest()
  const sign = (payload) => createHmac('sha256', key).update(payload).digest('hex')
  const nowSeconds = () => Math.floor(clock() / 1000)
  let failures = []

  function mint() {
    const expires = nowSeconds() + ttl
    return { token: `${VERSION}.${expires}.${sign(`${VERSION}.${expires}`)}`, expires }
  }

  function tokenValid(token) {
    const parts = typeof token === 'string' ? token.split('.') : []
    if (parts.length !== 3 || parts[0] !== VERSION) return false
    const expires = Number.parseInt(parts[1], 10)
    if (!Number.isFinite(expires) || String(expires) !== parts[1] || expires <= nowSeconds()) return false
    const expected = sign(`${VERSION}.${expires}`)
    if (parts[2].length !== expected.length) return false
    return timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))
  }

  function cookie(req, value, maxAge) {
    const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`]
    if (isHttps(req)) flags.push('Secure')
    return `${COOKIE_NAME}=${value}; ${flags.join('; ')}`
  }

  /** { ok: true } or { ok: false, status, code, message }. Used by HTTP routes and by WebSocket upgrades. */
  function check(req) {
    if (mode === 'disabled') return { ok: true }
    if (mode === 'misconfigured') {
      return { ok: false, status: 503, code: 'assistant-auth-misconfigured', message: 'The assistant access code is not set up correctly on the server' }
    }
    if (tokenValid(readCookie(req, COOKIE_NAME))) return { ok: true }
    return { ok: false, status: 401, code: 'assistant-auth-required', message: 'Enter the access code to use the assistant' }
  }

  function throttled() {
    const now = clock()
    failures = failures.filter((at) => now - at < FAILURE_WINDOW_MS)
    return failures.length >= FAILURE_LIMIT
  }

  const status = () => ({ required: mode !== 'disabled', misconfigured: mode === 'misconfigured' })

  return {
    mode,
    status,
    check,

    /** Express middleware: lets the request through, or answers 401 / 503. */
    requireAccess(req, res, next) {
      const result = check(req)
      if (result.ok) return next()
      if (result.status === 401) res.set('WWW-Authenticate', 'Cookie')
      return deny(res, req, result.status, result.code, result.message)
    },

    /** For a WebSocket upgrade: { ok } or { ok: false, status, code }. */
    authorizeUpgrade: (req) => check(req),

    /** Mounted at /api/v1/assistant/auth, outside the protected area: status, login, logout. */
    router() {
      const router = Router()

      router.get('/status', (req, res) => {
        res.json({ ...status(), authenticated: check(req).ok })
      })

      router.post('/login', (req, res) => {
        if (mode === 'disabled') return res.json({ required: false, authenticated: true })
        if (mode === 'misconfigured') return deny(res, req, 503, 'assistant-auth-misconfigured', 'The assistant access code is not set up correctly on the server')
        if (throttled()) {
          res.set('Retry-After', String(Math.ceil(FAILURE_WINDOW_MS / 1000)))
          return deny(res, req, 429, 'too-many-attempts', 'Too many wrong codes; wait a minute and try again')
        }
        const presented = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
        if (!presented || !secretsEqual(presented, code)) {
          failures.push(clock())
          return deny(res, req, 401, 'wrong-code', 'That is not the access code')
        }
        const { token, expires } = mint()
        res.set('Set-Cookie', cookie(req, token, ttl))
        res.set('Cache-Control', 'no-store')
        return res.json({ authenticated: true, expiresAt: new Date(expires * 1000).toISOString() })
      })

      router.post('/logout', (req, res) => {
        res.set('Set-Cookie', cookie(req, '', 0))
        res.status(204).end()
      })

      return router
    }
  }
}
