import { createAssistantRealtimeClient } from './realtimeClient.js'

const BASE = '/api/v1/assistant'

async function parseJson(res) {
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function parseSseBlock(block) {
  let event = 'message'
  const dataLines = []

  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }

  const raw = dataLines.join('\n')
  if (!raw) return { event, data: {} }

  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: { raw } }
  }
}

export function createAssistantClient() {
  let sessionId = null
  const realtime = createAssistantRealtimeClient()

  function sessionPath(path) {
    return sessionId ? `${BASE}/sessions/${sessionId}${path}` : `${BASE}${path}`
  }

  function isMissingSession(res, data) {
    return res.status === 404 && data?.error === 'Session not found'
  }

  async function recoverSession() {
    sessionId = null
    return api.createSession({
      client: 'browser',
      recovered: true
    })
  }

  const api = {
    getSessionId() {
      return sessionId
    },

    async createSession(metadata = {}) {
      const res = await fetch(`${BASE}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata })
      })
      const data = await parseJson(res)
      if (!res.ok) {
        throw new Error(data.error ?? `POST session failed: ${res.status}`)
      }
      if (typeof data.sessionId === 'string') sessionId = data.sessionId
      return data
    },

    async getState() {
      const res = await fetch(sessionPath('/state'))
      const data = await parseJson(res)
      if (!res.ok && isMissingSession(res, data)) {
        await recoverSession()
        return this.getState()
      }
      if (!res.ok) {
        throw new Error(data.error ?? `GET state failed: ${res.status}`)
      }
      if (typeof data.sessionId === 'string') sessionId = data.sessionId
      return data
    },

    async setState(state) {
      const res = await fetch(sessionPath('/state'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state })
      })
      const data = await parseJson(res)
      if (!res.ok && isMissingSession(res, data)) {
        await recoverSession()
        return this.setState(state)
      }
      if (!res.ok) {
        throw new Error(data.error ?? `PATCH state failed: ${res.status}`)
      }
      if (typeof data.sessionId === 'string') sessionId = data.sessionId
      return data
    },

    async sendMessage(message) {
      const res = await fetch(sessionPath('/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId })
      })
      const data = await parseJson(res)
      if (!res.ok && isMissingSession(res, data)) {
        await recoverSession()
        return this.sendMessage(message)
      }
      if (!res.ok) {
        throw new Error(data.error ?? `POST chat failed: ${res.status}`)
      }
      if (typeof data.sessionId === 'string') sessionId = data.sessionId
      return data
    },

    async streamMessage(message, { signal, onEvent } = {}) {
      // Prefer WebSocket streaming when available; fall back to SSE — but
      // only when the WS attempt never produced any output. Once it has
      // relayed even one token, the voice UI may already be speaking it
      // incrementally as it streams in; silently retrying via a fresh SSE
      // request at that point would regenerate and re-speak the whole
      // reply from scratch (sounds like the same sentence twice).
      let wsTokenSeen = false
      const wrappedOnEvent = (parsed) => {
        if (parsed?.event === 'token') wsTokenSeen = true
        onEvent?.(parsed)
      }

      try {
        if (sessionId) {
          const wsResult = await realtime.chatStream({
            sessionId,
            message,
            onEvent: wrappedOnEvent,
            signal
          })
          if (wsResult) return wsResult
          if (wsTokenSeen) {
            throw new Error('WebSocket stream ended without a final reply after producing partial output')
          }
        }
      } catch (err) {
        if (wsTokenSeen) throw err
        // Otherwise the WS attempt never produced any output — a clean,
        // single fallback attempt via SSE is safe.
      }

      const res = await fetch(sessionPath('/chat/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId }),
        signal
      })

      if (!res.ok || !res.body) {
        const data = await parseJson(res)
        if (isMissingSession(res, data)) {
          await recoverSession()
          return this.streamMessage(message, { signal, onEvent })
        }
        throw new Error(data.error ?? `POST chat stream failed: ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finalMessage = null

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''

        for (const block of blocks) {
          const parsed = parseSseBlock(block)
          if (typeof parsed.data?.sessionId === 'string') sessionId = parsed.data.sessionId
          if (parsed.event === 'message') finalMessage = parsed.data
          onEvent?.(parsed)
        }
      }

      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer)
        if (typeof parsed.data?.sessionId === 'string') sessionId = parsed.data.sessionId
        if (parsed.event === 'message') finalMessage = parsed.data
        onEvent?.(parsed)
      }

      return finalMessage
    }
  }

  return api
}
