/**
 * NUMZ AI is served under a base path (/ai/) on the shared site. The reverse proxy passes the path through untouched and the app
 * takes the prefix off itself, so the same build answers at its own address (/) and under /ai/, and nothing depends on the proxy
 * rewriting anything. `/ai` (no slash) is sent to `/ai/` so relative links resolve.
 */
export function normalizeBasePath(value) {
  const raw = String(value ?? '').trim()
  if (!raw || raw === '/') return ''
  if (!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(raw.replace(/\/+$/, ''))) throw new Error(`PUBLIC_BASE_PATH must look like /ai, not "${raw}"`)
  return raw.replace(/\/+$/, '')
}

export function stripBasePath(base) {
  if (!base) return (_req, _res, next) => next()
  return (req, res, next) => {
    const url = req.url
    if (url === base || url.startsWith(`${base}?`)) return res.redirect(308, `${base}/${url.slice(base.length)}`)
    if (url.startsWith(`${base}/`)) req.url = url.slice(base.length) || '/'
    next()
  }
}
