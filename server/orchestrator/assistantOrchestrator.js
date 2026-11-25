import { ASSISTANT_STATES, LEGACY_OWNER, sessionService } from '../sessions/sessionService.js'
import { streamResponse } from '../services/aiService.js'
import { assistantContext } from '../assistant/assistantContext.js'
import { CONTEXT_RULES } from '../assistant/contextService.js'
import { kindOf, parseMemoryCommand } from '../assistant/memoryCommands.js'
import { systemPromptWith } from '../providers/deepseek/prompts.js'

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
/**
 * The conversation with what the assistant knows put in front of it, as the system message: the persona, the date, the person, their memories
 * and their day; and, when they asked to remember or forget something, that is done first and told to the model. Used by every way a person
 * talks to the assistant (stream, socket, plain chat). If knowing fails the conversation is returned as it was.
 */
export function withKnowledge({ messages, owner = LEGACY_OWNER, person = {}, message = '', emit }) {
  const known = assistantContext.get()
  if (!known) return messages
  try {
    const memoryOwner = owner === LEGACY_OWNER ? null : owner
    const action = memoryAction(known.memories, memoryOwner, message)
    if (action.event) emit?.('MEMORY', action.event)
    const context = known.context.build({ owner: memoryOwner, person, message })
    return [{ role: 'system', content: systemPromptWith([context.text, action.note].filter(Boolean).join('\n\n'), CONTEXT_RULES) }, ...messages]
  } catch (err) {
    console.warn('[assistant] context unavailable:', err?.message ?? err)
    return messages
  }
}

/**
 * What a person said about the assistant's memory of them, done (when it is a request to remember or forget) and described for the model,
 * so that it confirms in its own words what really happened. Returns { note, event } (both null when the message is not about memory).
 */
function memoryAction(memories, owner, message) {
  const command = parseMemoryCommand(message)
  if (!command) return { note: null, event: null }
  const mine = memories.forOwner(owner)
  if (command.type === 'remember') {
    const text = /^to\s/i.test(command.text) ? `Remember ${command.text}` : command.text
    try {
      const { memory, created } = mine.add({ text, kind: kindOf(text), source: 'said' })
      return { note: `JUST NOW the person asked you to remember: "${memory.text}". It is ${created ? 'saved' : 'already saved, now up to date'}. Confirm in one short sentence in your own words, without reading it back word for word.`, event: { action: 'remembered', id: memory.id, text: memory.text } }
    } catch (err) {
      return { note: `JUST NOW the person asked you to remember something, and it could NOT be saved: ${err.message} Tell them so, briefly.`, event: { action: 'not-saved' } }
    }
  }
  if (command.type === 'forget') {
    const gone = mine.forget(command.text)
    return gone.length
      ? { note: `JUST NOW the person asked you to forget "${command.text}". ${gone.length} ${gone.length === 1 ? 'memory was' : 'memories were'} forgotten: ${gone.map((m) => `"${m.text}"`).join('; ')}. Confirm in one short sentence.`, event: { action: 'forgotten', count: gone.length } }
      : { note: `JUST NOW the person asked you to forget "${command.text}", but nothing you remember matches that. Say so, briefly, and offer to forget something from what you do remember.`, event: { action: 'nothing-to-forget' } }
  }
  if (command.type === 'forget-all') {
    return { note: 'JUST NOW the person asked you to forget everything. You have NOT done it: that cannot be undone, and it is not done by voice. Tell them to press "Forget all" in the Memory panel if they are sure.', event: { action: 'forget-all-needs-panel' } }
  }
  return { note: 'JUST NOW the person asked what you remember about them. Tell them briefly, from what you know above (or that you do not remember anything yet, and that they can say "remember that ..." to tell you).', event: { action: 'listed' } }
}

export function createAssistantOrchestrator({ stream = streamResponse } = {}) {
  function setState(sessions, sessionId, state, emit) {
    const session = sessions.setState(sessionId, state)
    emit?.('STATE', { state: session.state, sessionId: session.id })
    // Back-compat with existing SSE consumer:
    emit?.('state', { state: session.state, sessionId: session.id })
    return session
  }

  async function runStreamingTurn({ sessionId, message, requestId, emit, owner = LEGACY_OWNER, person = {}, signal, onUsage }) {
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
    let messages = session.messages.map(({ role, content }) => ({ role, content }))
    // What the assistant knows about this person and their day goes in front of the conversation (the orb shows RETRIEVING_MEMORY for the
    // moment it takes), and a request to remember or forget is done before the model answers.
    setState(sessions, session.id, ASSISTANT_STATES.RETRIEVING_MEMORY, emit)
    messages = withKnowledge({ messages, owner, person, message, emit })

    setState(sessions, session.id, ASSISTANT_STATES.GENERATING, emit)

    let finalReply = ''
    try {
      for await (const chunk of stream(messages, { signal, onUsage })) {
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

