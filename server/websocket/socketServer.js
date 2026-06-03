import { WebSocketServer } from 'ws'
import { createAssistantOrchestrator } from '../orchestrator/assistantOrchestrator.js'

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, error: err }
  }
}

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return false
  ws.send(JSON.stringify(payload))
  return true
}

/**
 * Websocket protocol (minimal, event-driven):
 *
 * Client -> server:
 * - { type: 'chat', sessionId: string, message: string }
 * - { type: 'interrupt', sessionId?: string }
 *
 * Server -> client:
 * - { type: 'AI_RESPONSE_STARTED' | 'AI_TOKEN' | 'AI_RESPONSE_FINISHED' | 'AI_RESPONSE_ERROR' | 'STATE' | 'token' | 'state' | 'message' | 'done', ...data }
 */
export function attachSocketServer(httpServer, { path = '/api/v1/assistant/ws' } = {}) {
  const orchestrator = createAssistantOrchestrator()
  const wss = new WebSocketServer({ server: httpServer, path })

  wss.on('connection', (ws) => {
    let active = null

    ws.on('message', async (raw) => {
      const text = raw instanceof Buffer ? raw.toString('utf8') : String(raw ?? '')
      const parsed = safeJsonParse(text)
      if (!parsed.ok) {
        safeSend(ws, { type: 'AI_RESPONSE_ERROR', error: 'Invalid JSON' })
        return
      }

      const msg = parsed.value
      const type = String(msg?.type ?? '')

      if (type === 'interrupt') {
        active?.abort?.()
        active = null
        safeSend(ws, { type: 'STATE', state: 'INTERRUPTED', sessionId: msg?.sessionId ?? null })
        return
      }

      if (type !== 'chat') {
        safeSend(ws, { type: 'AI_RESPONSE_ERROR', error: `Unknown message type: ${type}` })
        return
      }

      const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId : ''
      const message = typeof msg?.message === 'string' ? msg.message : ''
      if (!sessionId || !message.trim()) {
        safeSend(ws, {
          type: 'AI_RESPONSE_ERROR',
          error: 'chat requires sessionId and non-empty message'
        })
        return
      }

      active?.abort?.()
      active = new AbortController()

      try {
        await orchestrator.runStreamingTurn({
          sessionId,
          message,
          requestId: null,
          emit(eventType, data) {
            return safeSend(ws, { type: eventType, ...data })
          }
        })
      } catch (err) {
        safeSend(ws, {
          type: 'AI_RESPONSE_ERROR',
          error: err?.message ?? 'Internal Server Error'
        })
      } finally {
        active = null
      }
    })

    ws.on('close', () => {
      active?.abort?.()
      active = null
    })
  })

  return { wss, path }
}

