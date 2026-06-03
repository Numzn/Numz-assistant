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

export function createSessionService() {
  const sessions = new Map()

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
    return sessions.get(sessionId) ?? null
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

    session.messages.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...message
    })
    session.updatedAt = new Date().toISOString()
    return session
  }

  return {
    createSession,
    getSession,
    getOrCreateSession,
    setState,
    appendMessage
  }
}

export const sessionService = createSessionService()
