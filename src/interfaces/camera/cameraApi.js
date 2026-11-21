/**
 * The browser's view of the Smart Camera routes (server/routes/camera.js), all under the assistant's own sign-in:
 *
 *   createSession()                   -> { sessionId, visionConfigured, limits: { maxReads, maxImageBytes } }
 *   read(sessionId, image, options)   -> { status: 'new' | 'duplicate' | 'not-a-question' | 'unclear', ... }
 *   answer(sessionId, body, options)  -> { status: 'answered', questionId, answer, markdown }
 *   clear(sessionId)                  -> true: the session, and the conversation saved from it, are gone
 *
 * `image` is { bytes, mimeType }: sent as the request body as it is, never as text, never kept.
 */

const BASE = '/api/v1/assistant/camera'

// Refusals that retrying cannot change: say so at once instead of asking again.
const PERMANENT = new Set([
  'vision-not-configured',
  'session-limit',
  'image-too-large',
  'invalid-image',
  'assistant-auth-required',
  'assistant-auth-misconfigured',
  'forbidden'
])

export class CameraApiError extends Error {
  constructor(message, { status = 0, code = 'network', retryAfterMs = 0 } = {}) {
    super(message)
    this.name = 'CameraApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }

  /** Worth trying again: the network dropped, the server is busy or failing, or it asked us to wait. */
  get transient() {
    return !PERMANENT.has(this.code) && (this.status === 0 || this.status === 429 || this.status >= 500)
  }
}

export function createCameraApi({ fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  async function request(path, init) {
    let res
    try {
      res = await fetchFn(`${BASE}${path}`, { credentials: 'same-origin', ...init })
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      throw new CameraApiError(err?.message || 'Network error', { status: 0, code: 'network' })
    }
    if (res.status === 204) return null
    const text = await res.text()
    let body = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = {}
    }
    if (!res.ok) {
      const retryAfter = Number.parseInt(res.headers?.get?.('retry-after') ?? '', 10)
      throw new CameraApiError(body.error || `Request failed (${res.status})`, {
        status: res.status,
        code: typeof body.code === 'string' ? body.code : 'request-error',
        retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0
      })
    }
    return body
  }

  const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  return {
    createSession: () => request('/sessions', { method: 'POST', ...json({}) }),

    read: (sessionId, image, { signal } = {}) =>
      request(`/sessions/${encodeURIComponent(sessionId)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': image.mimeType },
        body: image.bytes,
        signal
      }),

    answer: (sessionId, body, { signal } = {}) =>
      request(`/sessions/${encodeURIComponent(sessionId)}/answer`, { method: 'POST', ...json(body), signal }),

    async clear(sessionId) {
      await request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      return true
    }
  }
}
