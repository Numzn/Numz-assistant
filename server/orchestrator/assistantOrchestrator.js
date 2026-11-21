import { ASSISTANT_STATES, LEGACY_OWNER, sessionService } from '../sessions/sessionService.js'
import { streamResponse } from '../services/aiService.js'

/**
 * Orchestrates a single assistant "turn" (user message -> streamed reply -> final message persisted).
 * Transport-agnostic: callers provide `emit(eventType, data)`.
 *
 * A turn belongs to one owner (a person, or the single-tenant fallback): it only ever reads and writes that owner's sessions.
 * `signal` stops the model call when nobody is listening any more; `onUsage` receives the provider's token counts.
 *
 * Canonical AI stream event types (per project requirement):
 * - AI_RESPONSE_STARTED
 * - AI_TOKEN
 * - AI_RESPONSE_FINISHED
 * - AI_RESPONSE_ERROR
 */
export function createAssistantOrchestrator() {
  function setState(sessions, sessionId, state, emit) {
    const session = sessions.setState(sessionId, state)
    emit?.('STATE', { state: session.state, sessionId: session.id })
    // Back-compat with existing SSE consumer:
    emit?.('state', { state: session.state, sessionId: session.id })
    return session
  }

  async function runStreamingTurn({ sessionId, message, requestId, emit, owner = LEGACY_OWNER, signal, onUsage }) {
    const sessions = sessionService.forOwner(owner)
    const session = sessions.getOrCreateSession(sessionId)

    const userMessage = { role: 'user', content: message.trim() }
    sessions.appendMessage(session.id, userMessage)

    emit?.('AI_RESPONSE_STARTED', { sessionId: session.id })
    emit?.('session', {
      sessionId: session.id,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    })

    setState(sessions, session.id, ASSISTANT_STATES.THINKING, emit)
    setState(sessions, session.id, ASSISTANT_STATES.GENERATING, emit)

    const messages = session.messages.map(({ role, content }) => ({ role, content }))

    let finalReply = ''
    try {
      for await (const chunk of streamResponse(messages, { signal, onUsage })) {
        if (chunk.type === 'token') {
          finalReply += chunk.token
          emit?.('AI_TOKEN', { token: chunk.token, sessionId: session.id })
          // Back-compat SSE token event:
          emit?.('token', { token: chunk.token, sessionId: session.id })
        } else if (chunk.type === 'message') {
          finalReply = chunk.content
        }
      }

      sessions.appendMessage(session.id, { role: 'assistant', content: finalReply })

      setState(sessions, session.id, ASSISTANT_STATES.SPEAKING, emit)

      emit?.('AI_RESPONSE_FINISHED', { reply: finalReply, sessionId: session.id })
      // Back-compat SSE final message:
      emit?.('message', { reply: finalReply, sessionId: session.id })

      setState(sessions, session.id, ASSISTANT_STATES.IDLE, emit)
      emit?.('done', { sessionId: session.id })

      return { reply: finalReply, sessionId: session.id }
    } catch (err) {
      if (signal?.aborted && err?.name !== 'TimeoutError' && signal.reason?.name !== 'TimeoutError') {
        // Nobody is listening any more (the connection closed, or the person pressed stop): not an error, and nothing half-finished is kept.
        try {
          setState(sessions, session.id, ASSISTANT_STATES.INTERRUPTED, null)
        } catch {
          /* the session may have been cleared meanwhile */
        }
        return { reply: finalReply, sessionId: session.id, interrupted: true }
      }
      setState(sessions, session.id, ASSISTANT_STATES.ERROR, emit)

      const isClientError = err?.statusCode && err.statusCode < 500
      const errorMessage = isClientError ? err.message : 'Internal Server Error'

      emit?.('AI_RESPONSE_ERROR', { error: errorMessage, requestId, sessionId: session.id })
      // Back-compat SSE error:
      emit?.('error', { error: errorMessage, requestId, sessionId: session.id })

      throw err
    }
  }

  return {
    runStreamingTurn
  }
}

