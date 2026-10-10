/**
 * The browser's view of saved conversations: list, open, delete one, delete all. These are the routes in
 * server/routes/assistant.js; nothing here is invented.
 */

const BASE = '/api/v1/assistant/conversations'

export class HistoryApiError extends Error {
  constructor(message, { status = 0, code = 'network' } = {}) {
    super(message)
    this.name = 'HistoryApiError'
    this.status = status
    this.code = code
  }
}

export function createHistoryApi({ fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  async function request(url, init) {
    let res
    try {
      res = await fetchFn(url, init)
    } catch (err) {
      throw new HistoryApiError(err?.message || 'Network error', { status: 0, code: 'network' })
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
      throw new HistoryApiError(body.error || `Request failed (${res.status})`, {
        status: res.status,
        code: res.status === 404 ? 'not-found' : 'request-error'
      })
    }
    return body
  }

  return {
    /** -> { enabled, total, conversations: [{ id, title, createdAt, updatedAt, messageCount }] } */
    list({ limit = 50, offset = 0 } = {}) {
      return request(`${BASE}?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`, { method: 'GET' })
    },

    /** -> { id, title, createdAt, updatedAt, messages: [{ role, content, createdAt }] } */
    get(id) {
      return request(`${BASE}/${encodeURIComponent(id)}`, { method: 'GET' })
    },

    async remove(id) {
      await request(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
      return true
    },

    /** -> { deleted }. The server refuses without the explicit confirmation this sends. */
    removeAll() {
      return request(`${BASE}?confirm=all`, { method: 'DELETE' })
    }
  }
}
