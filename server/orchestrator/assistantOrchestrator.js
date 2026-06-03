import { ASSISTANT_STATES, sessionService } from '../sessions/sessionService.js'
import { streamResponse } from '../services/aiService.js'

/**
 * Orchestrates a single assistant "turn" (user message -> streamed reply -> final message persisted).
 * Transport-agnostic: callers provide `emit(eventType, data)`.
 *
 * Canonical AI stream event types (per project requirement):
 * - AI_RESPONSE_STARTED
 * - AI_TOKEN
 * - AI_RESPONSE_FINISHED
 * - AI_RESPONSE_ERROR
 */
export function createAssistantOrchestrator() {
  function setState(sessionId, state, emit) {
    const session = sessionService.setState(sessionId, state)
    emit?.('STATE', { state: session.state, sessionId: session.id })
    // Back-compat with existing SSE consumer:
    emit?.('state', { state: session.state, sessionId: session.id })
    return session
  }

  async function runStreamingTurn({ sessionId, message, requestId, emit }) {
    const session = sessionService.getOrCreateSession(sessionId)

    const userMessage = { role: 'user', content: message.trim() }
    sessionService.appendMessage(session.id, userMessage)

    emit?.('AI_RESPONSE_STARTED', { sessionId: session.id })
    emit?.('session', {
      sessionId: session.id,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    })

    setState(session.id, ASSISTANT_STATES.THINKING, emit)
    setState(session.id, ASSISTANT_STATES.GENERATING, emit)

    const messages = session.messages.map(({ role, content }) => ({ role, content }))

    let finalReply = ''
    try {
      for await (const chunk of streamResponse(messages)) {
        if (chunk.type === 'token') {
          finalReply += chunk.token
          emit?.('AI_TOKEN', { token: chunk.token, sessionId: session.id })
          // Back-compat SSE token event:
          emit?.('token', { token: chunk.token, sessionId: session.id })
        } else if (chunk.type === 'message') {
          finalReply = chunk.content
        }
      }

      sessionService.appendMessage(session.id, { role: 'assistant', content: finalReply })

      setState(session.id, ASSISTANT_STATES.SPEAKING, emit)

      emit?.('AI_RESPONSE_FINISHED', { reply: finalReply, sessionId: session.id })
      // Back-compat SSE final message:
      emit?.('message', { reply: finalReply, sessionId: session.id })

      setState(session.id, ASSISTANT_STATES.IDLE, emit)
      emit?.('done', { sessionId: session.id })

      return { reply: finalReply, sessionId: session.id }
    } catch (err) {
      setState(session.id, ASSISTANT_STATES.ERROR, emit)

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

