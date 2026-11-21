import { WebSocketServer } from 'ws'
import { createAssistantOrchestrator } from '../orchestrator/assistantOrchestrator.js'
import { LEGACY_IDENTITY } from '../auth/identity.js'
import { NO_METER } from '../usage/meter.js'
import { createUpgradeRouter, rejectUpgrade } from './upgradeRouter.js'

// A chat message is a sentence or a pasted page, not a file: and nobody types faster than this.
const MAX_FRAME_BYTES = 64 * 1024
const MAX_CHAT_CHARS = 50_000
const BURST = { messages: 20, windowMs: 10_000 }

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
/**
 * `authorize(req)` (sync or async) answers { ok, identity?, idHash? } or { ok: false, status, code }: the same access rule as the HTTP
 * routes (a valid session, a same-origin browser), decided BEFORE the upgrade. `onConnect(ws, verdict)` lets the caller track the socket
 * (to close it when the person's access ends) and `onActivity(verdict)` is told when the person is really using it.
 * `meter` is the usage meter: every chat turn is checked and recorded against the person who owns the socket.
 */
export function attachSocketServer(httpServer, { path = '/api/v1/assistant/ws', upgrades, authorize = null, meter = NO_METER, onConnect = null, onActivity = null } = {}) {
  const orchestrator = createAssistantOrchestrator()
  // Upgrades are routed by path through one dispatcher, so other WebSocket endpoints can share this server.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const router = upgrades ?? createUpgradeRouter(httpServer)
  router.add(path, async (req, socket, head) => {
    // Same access rule as the HTTP routes: no session cookie, no socket.
    const verdict = authorize ? await authorize(req) : { ok: true }
    if (!verdict.ok) return rejectUpgrade(socket, verdict.status, verdict.code)
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, verdict))
  })

  wss.on('connection', (ws, _req, verdict = {}) => {
    const identity = verdict.identity ?? LEGACY_IDENTITY
    let current = null // the usage handle of the turn in progress
    let burst = []
    onConnect?.(ws, verdict)

    ws.on('message', async (raw) => {
      const now = Date.now()
      burst = burst.filter((t) => now - t < BURST.windowMs)
      if (burst.push(now) > BURST.messages) return ws.close(1008, 'too-many-messages')
      const text = raw instanceof Buffer ? raw.toString('utf8') : String(raw ?? '')
      const parsed = safeJsonParse(text)
      if (!parsed.ok) {
        safeSend(ws, { type: 'AI_RESPONSE_ERROR', error: 'Invalid JSON' })
        return
      }

      const msg = parsed.value
      const type = String(msg?.type ?? '')

      if (type === 'interrupt') {
        current?.abort(new Error('interrupted'))
        current = null
        safeSend(ws, { type: 'STATE', state: 'INTERRUPTED', sessionId: msg?.sessionId ?? null })
        return
      }

      if (type !== 'chat') {
        safeSend(ws, { type: 'AI_RESPONSE_ERROR', error: `Unknown message type: ${type}` })
        return
      }

      const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId : ''
      const message = typeof msg?.message === 'string' ? msg.message : ''
      if (message.length > MAX_CHAT_CHARS) {
        safeSend(ws, { type: 'AI_RESPONSE_ERROR', error: 'That message is too long', code: 'message-too-long' })
        return
      }
      if (!sessionId || !message.trim()) {
        safeSend(ws, {
          type: 'AI_RESPONSE_ERROR',
          error: 'chat requires sessionId and non-empty message'
        })
        return
      }

      current?.abort(new Error('replaced by a newer message')) // a new question replaces the one still being answered
      onActivity?.(verdict)
      let call
      try {
        call = meter.begin(identity, 'stream', { requestId: null, conversationId: sessionId })
      } catch (err) {
        safeSend(ws, { type: 'AI_RESPONSE_ERROR', error: err?.expose ? err.message : 'Internal Server Error', code: err?.code ?? 'error' })
        return
      }
      current = call

      let replyText = ''
      try {
        await orchestrator.runStreamingTurn({
          sessionId,
          message,
          requestId: null,
          owner: identity.ownerKey,
          signal: call.signal,
          onUsage: call.usage,
          emit(eventType, data) {
            if (eventType === 'AI_TOKEN' && typeof data?.token === 'string') replyText += data.token
            return safeSend(ws, { type: eventType, ...data })
          }
        })
        call.estimate({ inText: message, outText: replyText })
        call.finish()
      } catch (err) {
        call.fail(err)
        safeSend(ws, {
          type: 'AI_RESPONSE_ERROR',
          error: err?.message ?? 'Internal Server Error'
        })
      } finally {
        if (current === call) current = null
      }
    })

    ws.on('close', () => {
      current?.abort(new Error('the socket closed'))
      current = null
    })
  })

  return { wss, path }
}

