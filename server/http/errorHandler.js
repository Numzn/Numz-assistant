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
 *  - 4xx: the message and a stable machine code are returned. Stacks never are.
 *  - 503: the message is returned (configuration problems are meant to be actionable).
 */
export function errorHandler({ logger = console } = {}) {
  return (err, req, res, _next) => {
    const status = Number.isInteger(err?.statusCode)
      ? err.statusCode
      : Number.isInteger(err?.status)
        ? err.status
        : 500

    if (status >= 500) {
      logger.error(`[api] ${status} ${req.method} ${req.path} requestId=${req.id}`, err)
      return res.status(500).json({ error: 'Internal Server Error', code: 'internal-error', requestId: req.id })
    }

    const exposable = err.expose === true || status < 500 || status === 503
    const message = exposable && err.message ? err.message : 'Request failed'
    const code =
      typeof err.code === 'string' && /^[a-z0-9-]{1,64}$/.test(err.code) ? err.code : DEFAULT_CODES[status] ?? 'request-error'
    logger.warn(`[api] ${status} ${req.method} ${req.path}: ${code}`)
    return res.status(status).json({ error: message, code, requestId: req.id })
  }
}
