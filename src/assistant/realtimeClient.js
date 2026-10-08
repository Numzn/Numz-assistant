import { safeJsonParse } from '../utils/json.js'

/**
 * Minimal WS streaming client.
 * - Keeps transport isolated from controller/state/orb.
 * - Re-emits server events into the existing SSE-like `onEvent({event,data})` shape.
 */
export function createAssistantRealtimeClient({
  url = '/api/v1/assistant/ws',
  connectTimeoutMs = 1500
} = {}) {
  let ws = null
  let connecting = null

  function connect({ signal } = {}) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve(ws)
    }
    if (connecting) return connecting

    connecting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws?.close?.()
        } catch {
          // ignore
        }
        reject(new Error('WS connect timeout'))
      }, connectTimeoutMs)

      ws = new WebSocket(url)

      const cleanup = () => {
        clearTimeout(timer)
        connecting = null
      }

      const abortHandler = () => {
        try {
          ws?.close?.()
        } catch {
          // ignore
        }
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }

      if (signal) {
        if (signal.aborted) return abortHandler()
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      ws.addEventListener(
        'open',
        () => {
          cleanup()
          resolve(ws)
        },
        { once: true }
      )
      ws.addEventListener(
        'error',
        () => {
          cleanup()
          reject(new Error('WS connection error'))
        },
        { once: true }
      )
    })

    return connecting
  }

  async function chatStream({ sessionId, message, onEvent, signal }) {
    const socket = await connect({ signal })

    let finalMessage = null
    const handleMessage = (ev) => {
      const parsed = safeJsonParse(String(ev.data ?? ''))
      if (!parsed.ok) return

      const msg = parsed.value
      const type = String(msg?.type ?? '')

      // Bridge required event types into existing SSE-like event names.
      if (type === 'AI_TOKEN') {
        onEvent?.({ event: 'token', data: { token: msg.token ?? '', sessionId: msg.sessionId ?? sessionId } })
        onEvent?.({ event: 'AI_TOKEN', data: msg })
        return
      }

      if (type === 'AI_RESPONSE_STARTED') {
        onEvent?.({ event: 'AI_RESPONSE_STARTED', data: msg })
        return
      }

      if (type === 'AI_RESPONSE_FINISHED') {
        finalMessage = { reply: msg.reply ?? '', sessionId: msg.sessionId ?? sessionId }
        onEvent?.({ event: 'message', data: finalMessage })
        onEvent?.({ event: 'AI_RESPONSE_FINISHED', data: msg })
        return
      }

      if (type === 'AI_RESPONSE_ERROR') {
        onEvent?.({ event: 'AI_RESPONSE_ERROR', data: msg })
        return
      }

      if (type === 'STATE') {
        onEvent?.({ event: 'state', data: { state: msg.state, sessionId: msg.sessionId ?? sessionId } })
        return
      }

      // Back-compat (orchestrator also emits these names over WS):
      if (type === 'token' || type === 'state' || type === 'message' || type === 'done' || type === 'error') {
        onEvent?.({ event: type, data: msg })
        if (type === 'message') finalMessage = msg
      }
    }

    socket.addEventListener('message', handleMessage)

    const abortHandler = () => {
      try {
        socket.send(JSON.stringify({ type: 'interrupt', sessionId }))
      } catch {
        // ignore
      }
      socket.removeEventListener('message', handleMessage)
    }
    if (signal) {
      if (signal.aborted) abortHandler()
      else signal.addEventListener('abort', abortHandler, { once: true })
    }

    socket.send(JSON.stringify({ type: 'chat', sessionId, message }))

    // Wait until we get a final message, or the stream ends.
    // Note: server currently doesn't emit a dedicated "done" for WS, but it may.
    await new Promise((resolve, reject) => {
      const doneTimeout = setTimeout(() => {
        cleanup()
        reject(new Error('WS stream timeout'))
      }, 120000)

      const cleanup = () => {
        clearTimeout(doneTimeout)
        socket.removeEventListener('message', onDoneMessage)
        socket.removeEventListener('close', onClose)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('message', onErrorMessage)
      }

      const onClose = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('WS stream error'))
      }
      const onDoneMessage = (ev) => {
        const parsed = safeJsonParse(String(ev.data ?? ''))
        if (!parsed.ok) return
        const type = String(parsed.value?.type ?? '')
        if (type === 'AI_RESPONSE_FINISHED' || type === 'done') {
          cleanup()
          resolve()
        }
      }
      const onErrorMessage = (ev) => {
        const parsed = safeJsonParse(String(ev.data ?? ''))
        if (!parsed.ok) return
        const type = String(parsed.value?.type ?? '')
        if (type === 'AI_RESPONSE_ERROR' || type === 'error') {
          cleanup()
          reject(new Error(parsed.value?.error ?? 'WS stream error'))
        }
      }

      socket.addEventListener('message', onDoneMessage)
      socket.addEventListener('message', onErrorMessage)
      socket.addEventListener('close', onClose, { once: true })
      socket.addEventListener('error', onError, { once: true })
    })

    socket.removeEventListener('message', handleMessage)
    return finalMessage
  }

  return {
    connect,
    chatStream
  }
}

