import { withBase } from '../../core/apiPaths.js'

/**
 * The page's view of the screenshot routes (server/routes/screenshots.js), under the assistant's own sign-in:
 *
 *   attach(conversationId, { bytes, mimeType }, { question, id, signal }) -> { id, status: 'analyzing', pictureKept, ... }
 *                                 `id` (a UUID the page chooses) lets it cancel or delete a screenshot whose answer it never saw
 *   get(id)                       -> { status: 'analyzing' | 'ready' | 'failed' | 'cancelled', analysis?, error?, retryable?, pictureKept }
 *   cancel(id) / retry(id)        -> the same shape
 *   ask(id, question)             -> { answer }                     (while the server still holds the picture)
 *   remove(id, conversationId)    -> true: the picture and the screenshot's messages are gone
 *
 * The picture goes as the request body itself, never as text.
 */

const BASE = withBase('/api/v1/assistant/screenshots')

export class ScreenshotApiError extends Error {
  constructor(message, { status = 0, code = 'network', retryAfterMs = 0 } = {}) {
    super(message)
    this.name = 'ScreenshotApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }

  /** Worth trying again: the network dropped, the server is busy or failing, or it asked us to wait. */
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

export function createScreenshotApi({ fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  async function request(path, init) {
    let res
    try {
      res = await fetchFn(`${BASE}${path}`, { credentials: 'same-origin', ...init })
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      throw new ScreenshotApiError('The server could not be reached.', { status: 0, code: 'network' })
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
      throw new ScreenshotApiError(body.error || `Request failed (${res.status})`, {
        status: res.status,
        code: typeof body.code === 'string' ? body.code : 'request-error',
        retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0
      })
    }
    return body
  }

  const id = (value) => encodeURIComponent(value)

  return {
    attach: (conversationId, image, { question = '', id: shotId = '', signal } = {}) =>
      request(`?conversation=${id(conversationId)}`, {
        method: 'POST',
        headers: { 'Content-Type': image.mimeType, ...(shotId ? { 'X-Screenshot-Id': shotId } : {}), ...(question ? { 'X-Screenshot-Question': encodeURIComponent(question) } : {}) },
        body: image.bytes,
        signal
      }),
    get: (shotId, { signal } = {}) => request(`/${id(shotId)}`, { method: 'GET', signal }),
    cancel: (shotId) => request(`/${id(shotId)}/cancel`, { method: 'POST' }),
    retry: (shotId) => request(`/${id(shotId)}/retry`, { method: 'POST' }),
    ask: (shotId, question) => request(`/${id(shotId)}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) }),
    async remove(shotId, conversationId = '') {
      await request(`/${id(shotId)}${conversationId ? `?conversation=${id(conversationId)}` : ''}`, { method: 'DELETE' })
      return true
    }
  }
}
