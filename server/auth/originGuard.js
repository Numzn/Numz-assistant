import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Where a request may come from. NUMZ AI is served from one origin (PUBLIC_ORIGIN, e.g. https://lab.numz.site) and nothing else is
 * ever a legitimate caller of its API, so:
 *
 *   state-changing requests (POST, PUT, PATCH, DELETE) need the session's own CSRF token in `X-CSRF-Token` AND must be same-origin:
 *       `Origin` equal to PUBLIC_ORIGIN, or, when the browser sent no Origin, `Sec-Fetch-Site: same-origin | none`;
 *   WebSocket upgrades (which carry the cookie but no custom headers) need an `Origin` equal to PUBLIC_ORIGIN, always.
 *
 * The session cookie being SameSite=Lax is a third layer, not the only one.
 */

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])
const digest = (value) => createHash('sha256').update(String(value)).digest()
const same = (a, b) => timingSafeEqual(digest(a), digest(b))

export function createOriginGuard({ publicOrigin }) {
  if (!publicOrigin) throw new Error('The origin guard needs PUBLIC_ORIGIN')
  const allowed = publicOrigin.replace(/\/+$/, '')

  function originAllowed(req) {
    const origin = req.headers?.origin
    if (typeof origin === 'string') return origin === allowed
    const site = req.headers?.['sec-fetch-site']
    return site === 'same-origin' || site === 'none'
  }

  return {
    originAllowed,
    /** WebSocket upgrades: the Origin header must be present and ours. */
    websocketOriginAllowed: (req) => typeof req.headers?.origin === 'string' && req.headers.origin === allowed,
    /** null when the request may proceed, else the reason code. */
    check(req, csrf) {
      if (SAFE.has(String(req.method).toUpperCase())) return null
      if (!originAllowed(req)) return 'origin-refused'
      const token = req.headers?.['x-csrf-token']
      if (typeof token !== 'string' || !token || !csrf || !same(token, csrf)) return 'csrf-refused'
      return null
    }
  }
}
