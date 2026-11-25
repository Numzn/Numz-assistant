import { withBase } from '../../core/apiPaths.js'

/**
 * The page's view of what the assistant remembers about the person (server/routes/assistantMemory.js), under the person's own sign-in. Every
 * method returns the server's JSON; a refusal throws an Error with a message fit to show.
 */
const BASE = withBase('/api/v1/assistant/memory')

export function createAssistantMemoryApi({ fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  async function request(path = '', init = {}) {
    let res
    try {
      res = await fetchFn(`${BASE}${path}`, { credentials: 'same-origin', ...init })
    } catch {
      throw new Error('The server could not be reached.')
    }
    if (res.status === 204) return null
    const text = await res.text()
    let body = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = {}
    }
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
    return body
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const e = encodeURIComponent
  return {
    list: () => request(''),
    add: (text, kind) => request('', json('POST', kind ? { text, kind } : { text })),
    change: (id, patch) => request(`/${e(id)}`, json('PATCH', patch)),
    remove: async (id) => (await request(`/${e(id)}`, { method: 'DELETE' }), true),
    removeAll: () => request('?confirm=all', { method: 'DELETE' })
  }
}
