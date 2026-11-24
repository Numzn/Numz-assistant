import { withBase } from '../../core/apiPaths.js'

/**
 * The page's view of Academic Intelligence (server/routes/academic*.js), under the assistant's own sign-in. Every method returns the
 * server's JSON; a refusal is an AcademicApiError with the stable `code` the page acts on (restricted-assessment, session-paused,
 * capture-rate-limited, ...), a message fit to show, `details` (such as the offer of a conceptual explanation) and any Retry-After.
 */

const BASE = withBase('/api/v1/assistant/academic')

export class AcademicApiError extends Error {
  constructor(message, { status = 0, code = 'network', retryAfterMs = 0, details = null } = {}) {
    super(message)
    this.name = 'AcademicApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
    this.details = details
  }

  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

/** The events in a piece of an event stream: [{ event, data }], and what was left over (an event that is not complete yet). */
export function parseEvents(buffer) {
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events = []
  for (const block of blocks) {
    const event = block.match(/^event: ?(.*)$/m)?.[1]
    const data = block.match(/^data: ?(.*)$/m)?.[1]
    if (!event) continue
    let parsed = null
    try {
      parsed = data ? JSON.parse(data) : null
    } catch {
      parsed = null
    }
    events.push({ event, data: parsed })
  }
  return { events, rest }
}

export function createAcademicApi({ fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  async function send(path, init) {
    try {
      return await fetchFn(`${BASE}${path}`, { credentials: 'same-origin', ...init })
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      throw new AcademicApiError('The server could not be reached.', { status: 0, code: 'network' })
    }
  }

  /** The JSON of a reply, or the AcademicApiError a refusal is. */
  async function readJson(res) {
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
      throw new AcademicApiError(body.error || `Request failed (${res.status})`, { status: res.status, code: typeof body.code === 'string' ? body.code : 'request-error', retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0, details: body.details ?? null })
    }
    return body
  }

  async function request(path, init = {}) {
    return readJson(await send(path, init))
  }

  /**
   * A request that may be answered as it is written. It asks for an event stream; the server answers with one only when there is an answer to
   * write, and with ordinary JSON otherwise (a refusal, or a question that needs the person's decision first), which is read exactly as
   * `request` reads it. `onEvent({ type, ...data })` hears start, delta and checking; the returned value is the final `result`.
   */
  async function requestLive(path, init = {}, { onEvent = null, signal = undefined } = {}) {
    const res = await send(path, { ...init, signal, headers: { ...(init.headers ?? {}), Accept: 'text/event-stream' } })
    if (!res.ok || !String(res.headers?.get?.('content-type') ?? '').includes('text/event-stream')) return readJson(res)
    let result = null
    let failure = null
    const hear = ({ event, data }) => {
      if (event === 'result') result = data
      else if (event === 'error') failure = new AcademicApiError(data?.error || 'An answer could not be worked out just now. Try again.', { status: data?.status ?? 502, code: typeof data?.code === 'string' ? data.code : 'answer-failed', details: data?.details ?? null })
      else onEvent?.({ type: event, ...(data ?? {}) })
    }
    if (res.body?.getReader) {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseEvents(buffer)
          buffer = parsed.rest
          parsed.events.forEach(hear)
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        throw new AcademicApiError('The connection was lost while the answer was being written.', { status: 0, code: 'network' })
      }
      parseEvents(`${buffer}\n\n`).events.forEach(hear)
    } else {
      parseEvents(`${await res.text()}\n\n`).events.forEach(hear)
    }
    if (failure) throw failure
    if (!result) throw new AcademicApiError('The connection was lost while the answer was being written.', { status: 0, code: 'network' })
    return result
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const e = encodeURIComponent

  return {
    profile: { get: () => request('/profile'), update: (patch) => request('/profile', json('PUT', patch)) },
    courses: {
      list: () => request('/courses'),
      create: (input) => request('/courses', json('POST', input)),
      remove: async (id) => (await request(`/courses/${e(id)}`, { method: 'DELETE' }), true)
    },
    documents: {
      list: (courseId) => request(`/courses/${e(courseId)}/documents`),
      /** The text itself is the body (text/markdown or text/plain): nothing is wrapped in JSON. */
      // `file` (a File) is sent as it is, so that a very large one is streamed from disk and never held in the page's memory; `text` is for a string.
      upload: (courseId, { title, type = 'notes', text, file = null, markdown = false }) =>
        request(`/courses/${e(courseId)}/documents?title=${e(title)}&type=${e(type)}`, { method: 'POST', headers: { 'Content-Type': markdown ? 'text/markdown' : 'text/plain' }, body: file ?? text }),
      retry: (id) => request(`/documents/${e(id)}/retry`, { method: 'POST' }),
      limits: () => request('/limits'),
      remove: async (id) => (await request(`/documents/${e(id)}`, { method: 'DELETE' }), true),
      fromMeeting: (courseId, meetingId, title = null) => request(`/courses/${e(courseId)}/documents/from-meeting`, json('POST', { meetingId, ...(title ? { title } : {}) })),
      lectures: () => request('/meetings')
    },
    memory: {
      inspect: () => request('/memory'),
      removeLane: (lane, { courseId = null, confirmAll = false } = {}) => request(`/memory/lane/${e(lane)}?${courseId ? `course=${e(courseId)}&` : ''}${confirmAll ? 'confirm=all' : ''}`, { method: 'DELETE' }),
      removeExperience: async (id) => (await request(`/memory/experiences/${e(id)}`, { method: 'DELETE' }), true),
      correctExperience: (id, patch) => request(`/memory/experiences/${e(id)}`, json('PATCH', patch)),
      removeEverything: () => request('/memory?confirm=all', { method: 'DELETE' }),
      exportUrl: `${BASE}/memory/export?documents=full`
    },
    sessions: {
      start: (options) => request('/sessions', json('POST', options)),
      current: () => request('/sessions/current'),
      update: (id, patch) => request(`/sessions/${e(id)}`, json('PATCH', patch)),
      pause: (id) => request(`/sessions/${e(id)}/pause`, { method: 'POST' }),
      resume: (id) => request(`/sessions/${e(id)}/resume`, { method: 'POST' }),
      stop: (id) => request(`/sessions/${e(id)}/stop`, { method: 'POST' })
    },
    /** One screenshot (the picture is the body, as it is). */
    sendCapture: (sessionId, { bytes, mimeType }) => request(`/sessions/${e(sessionId)}/captures`, { method: 'POST', headers: { 'Content-Type': mimeType }, body: bytes }),
    questions: (sessionId) => request(`/sessions/${e(sessionId)}/questions`),
    content: (sessionId) => request(`/sessions/${e(sessionId)}/content`),
    /** `live` ({ onEvent, signal }): the answer as it is written (see requestLive); without it, the whole answer in one reply. */
    answer: (sessionId, questionId, options = {}, live = null) => (live ? requestLive(`/sessions/${e(sessionId)}/questions/${e(questionId)}/answer`, json('POST', options), live) : request(`/sessions/${e(sessionId)}/questions/${e(questionId)}/answer`, json('POST', options))),
    ask: (sessionId, text, options = {}, live = null) => (live ? requestLive(`/sessions/${e(sessionId)}/ask`, json('POST', { text, ...options }), live) : request(`/sessions/${e(sessionId)}/ask`, json('POST', { text, ...options }))),
    concept: (sessionId, concept, options = {}) => request(`/sessions/${e(sessionId)}/concept`, json('POST', { concept, ...options })),
    feedback: (body) => request('/feedback', json('POST', body)),
    progress: (courseId = null) => request(`/progress${courseId ? `?course=${e(courseId)}` : ''}`)
  }
}
