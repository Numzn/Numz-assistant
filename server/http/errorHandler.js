const DEFAULT_CODES = {
  400: 'bad-request',
  401: 'auth-required',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  409: 'conflict',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  422: 'unprocessable-entity'
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not Found', code: 'not-found', requestId: req.id })
}

/**
 * Converts any thrown error into a JSON response.
 *  - 5xx: the full error (stack included) is logged server-side; the client gets a generic message.
 *  - 5xx from one of our own domain errors (`expose === true`, e.g. "notes provider failed", "not configured"):
 *    the declared status, message and stable code are returned. They are written to be shown, and a caller
 *    that could only see "500" could not tell a retry from a configuration problem.
 *  - 4xx: the message and a stable machine code are returned. Stacks never are.
 */
export function errorHandler({ logger = console } = {}) {
  return (err, req, res, _next) => {
    const status = Number.isInteger(err?.statusCode)
      ? err.statusCode
      : Number.isInteger(err?.status)
        ? err.status
        : 500

    if (status >= 500 && err?.expose !== true) {
      logger.error(`[api] ${status} ${req.method} ${req.path} requestId=${req.id}`, err)
      return res.status(500).json({ error: 'Internal Server Error', code: 'internal-error', requestId: req.id })
    }

    const exposable = err.expose === true || status < 500
    const message = exposable && err.message ? err.message : 'Request failed'
    const code =
      typeof err.code === 'string' && /^[a-z0-9-]{1,64}$/.test(err.code) ? err.code : DEFAULT_CODES[status] ?? 'request-error'
    logger.warn(`[api] ${status} ${req.method} ${req.path}: ${code}`)
    const body = { error: message, code, requestId: req.id }
    // Structured facts a caller can act on (set only by our own domain errors, never by a thrown stack).
    if (err.expose === true && err.details && typeof err.details === 'object') body.details = err.details
    return res.status(status).json(body)
  }
}
