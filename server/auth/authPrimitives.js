import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The security plumbing that assistantAuth.js (the assistant access code) and meetingAuth.js (the meeting launch
 * session) both need, written once. Internal to server/auth: nothing outside it imports this.
 *
 * It holds mechanics only. Everything that decides WHO is let in stays in the module that owns the credential:
 * which secret, how the signing key is derived from it, the cookie's name and path, how long it lives, how many
 * wrong codes are allowed, what a refusal says. Each module passes those in. That keeps the two credentials
 * separate on purpose: they have different keys, so a token from one is never valid for the other.
 *
 * What is NOT here, deliberately:
 *   - meeting tickets and bearer tokens (meetingAuth.js only: a different format, and bound to a meeting);
 *   - any user or provider login. A login with an identity provider (Google, say) is a different kind of
 *     credential: it should be built on its own terms, and may borrow readCookie / isHttps / secretsEqual /
 *     sessionCookieHeader if they fit, but not createSignedSession, which is a stateless, non-revocable cookie
 *     keyed from one shared secret.
 */

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest()

/** Constant-time comparison (digests give equal lengths for timingSafeEqual). */
export function secretsEqual(candidate, expected) {
  return timingSafeEqual(digest(candidate), digest(expected))
}

export function readCookie(req, name) {
  const header = req.headers?.cookie
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

export function isHttps(req) {
  if (req.secure) return true
  const forwarded = String(req.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  return forwarded === 'https'
}

/** The JSON refusal both APIs use: { error, code, requestId }. A module that needs a challenge header adds it first. */
export function sendAuthError(res, req, status, code, message) {
  return res.status(status).json({ error: message, code, requestId: req.id })
}

/** A Set-Cookie value: HttpOnly and SameSite=Strict always, Secure when the request came in over HTTPS. */
export function sessionCookieHeader(req, { name, value, path, maxAge }) {
  const flags = [`Path=${path}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`]
  if (isHttps(req)) flags.push('Secure')
  return `${name}=${value}; ${flags.join('; ')}`
}

/**
 * A stateless session token: `<version>.<expiresAtSeconds>.<hmac-sha256 hex of "<version>.<expiresAtSeconds>">`.
 * It carries nothing but its own expiry. `key` is the caller's: whoever knows the secret the key was derived
 * from can mint and verify, and changing that secret voids every token.
 *
 * verify() is false for anything that is not exactly this format, for a different version, for an expiry that is
 * not a plain integer, for an expiry that has passed (at the second it is reached), and for a wrong signature.
 */
export function createSignedSession({ key, version, nowSeconds, ttlSeconds }) {
  const sign = (payload) => createHmac('sha256', key).update(payload).digest('hex')
  return {
    mint() {
      const expires = nowSeconds() + ttlSeconds
      return { token: `${version}.${expires}.${sign(`${version}.${expires}`)}`, expires }
    },
    verify(token) {
      const parts = typeof token === 'string' ? token.split('.') : []
      if (parts.length !== 3 || parts[0] !== version) return false
      const expires = Number.parseInt(parts[1], 10)
      if (!Number.isFinite(expires) || String(expires) !== parts[1] || expires <= nowSeconds()) return false
      const expected = sign(`${version}.${expires}`)
      // Compared as digests, not as buffers of the two strings: a client can send bytes 0x80-0xFF, which are as
      // many characters as a real signature but twice the bytes, and timingSafeEqual throws on unequal lengths.
      return secretsEqual(parts[2], expected)
    }
  }
}

/**
 * Counts wrong attempts across ALL callers (not per address: the server sits behind a proxy). `limit` failures
 * inside `windowMs` lock it, and each failure stops counting `windowMs` after it happened. Only wrong attempts
 * are recorded; a right one never counts.
 */
export function createFailureThrottle({ limit, windowMs, clock }) {
  let failures = [] // timestamps (ms), oldest first
  function prune() {
    const now = clock()
    failures = failures.filter((at) => now - at < windowMs)
  }
  return {
    isLocked() {
      prune()
      return failures.length >= limit
    },
    /** Whole seconds until the oldest counted failure ages out, at least 1. Meaningful while isLocked(). */
    retryAfterSeconds() {
      return Math.max(1, Math.ceil((failures[0] + windowMs - clock()) / 1000))
    },
    record() {
      failures.push(clock())
    }
  }
}
