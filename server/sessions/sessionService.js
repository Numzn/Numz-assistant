import { randomUUID } from 'node:crypto'

export const ASSISTANT_STATES = Object.freeze({
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  TRANSCRIBING: 'TRANSCRIBING',
  PROCESSING: 'PROCESSING',
  THINKING: 'THINKING',
  RETRIEVING_MEMORY: 'RETRIEVING_MEMORY',
  TOOL_EXECUTION: 'TOOL_EXECUTION',
  GENERATING: 'GENERATING',
  SPEAKING: 'SPEAKING',
  INTERRUPTED: 'INTERRUPTED',
  ERROR_RECOVERY: 'ERROR_RECOVERY',
  ERROR: 'ERROR'
})

const VALID_STATES = new Set(Object.values(ASSISTANT_STATES))

export function isValidAssistantState(state) {
  return VALID_STATES.has(state)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `store` (optional) is the conversation repository: every user and assistant message is saved as it is added,
 * and a conversation that is not in memory (after a restart, or an old one reopened from history) is loaded
 * back when its id is asked for. Saving never breaks a chat: if the store fails the conversation carries on in
 * memory and the failure is logged. Sessions with no messages are never saved.
 */
export function createSessionService({ store = null, logger = console } = {}) {
  const sessions = new Map()
  let history = store

  function persist(session, message) {
    if (!history) return
    try {
      history.append(session.id, message, { conversationCreatedAt: session.createdAt })
    } catch (err) {
      logger.error('[history] could not save a message; the conversation continues without it', err?.message ?? err)
    }
  }

  function restore(sessionId) {
    if (!history || !UUID.test(String(sessionId))) return null
    try {
      const saved = history.get(sessionId)
      if (!saved) return null
      const session = {
        id: saved.id,
        state: ASSISTANT_STATES.IDLE,
        messages: saved.messages.map((m) => ({ id: randomUUID(), createdAt: m.createdAt, role: m.role, content: m.content })),
        metadata: { restored: true },
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt
      }
      sessions.set(session.id, session)
      return session
    } catch (err) {
      logger.error('[history] could not load a saved conversation', err?.message ?? err)
      return null
    }
  }

  function createSession(metadata = {}) {
    const now = new Date().toISOString()
    const session = {
      id: randomUUID(),
      state: ASSISTANT_STATES.IDLE,
      messages: [],
      metadata,
      createdAt: now,
      updatedAt: now
    }
    sessions.set(session.id, session)
    return session
  }

  function getSession(sessionId) {
    if (!sessionId) return null
    return sessions.get(sessionId) ?? restore(sessionId)
  }

  function getOrCreateSession(sessionId, metadata = {}) {
    return getSession(sessionId) ?? createSession(metadata)
  }

  function setState(sessionId, state) {
    if (!isValidAssistantState(state)) {
      const err = new Error(`Invalid state: ${state}`)
      err.statusCode = 400
      throw err
    }

    const session = getSession(sessionId)
    if (!session) {
      const err = new Error('Session not found')
      err.statusCode = 404
      throw err
    }

    session.state = state
    session.updatedAt = new Date().toISOString()
    return session
  }

  function appendMessage(sessionId, message) {
    const session = getSession(sessionId)
    if (!session) {
      const err = new Error('Session not found')
      err.statusCode = 404
      throw err
    }

    const entry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...message
    }
    session.messages.push(entry)
    session.updatedAt = new Date().toISOString()
    persist(session, entry)
    return session
  }

  /** Forgets a session from memory (its saved copy is removed by the caller through the store). */
  function forget(sessionId) {
    sessions.delete(sessionId)
  }

  return {
    createSession,
    getSession,
    getOrCreateSession,
    setState,
    appendMessage,
    forget,
    /** The conversation store, or null when history is off. */
    getHistory: () => history,
    /** Turns saving on (once, at startup) for the shared service the routes use. */
    useStore(nextStore) {
      history = nextStore
    }
  }
}

export const sessionService = createSessionService()
