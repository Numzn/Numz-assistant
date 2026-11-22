import { randomUUID } from 'node:crypto'
import { ASSISTANT_STATES, isValidAssistantState } from './assistantStates.js'

// The state list is defined once, in assistantStates.js (the browser imports the same file). Re-exported here so
// the routes and the orchestrator keep importing it from the session service.
export { ASSISTANT_STATES, isValidAssistantState }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The owner of everything made in the single-tenant fallback (ASSISTANT_AUTH_MODE=code). */
export const LEGACY_OWNER = 'legacy'

const MAX_SESSIONS = 2000
const MAX_SESSIONS_PER_OWNER = 200

/**
 * `store` (optional) is the conversation repository: every user and assistant message is saved as it is added,
 * and a conversation that is not in memory (after a restart, or an old one reopened from history) is loaded
 * back when its id is asked for. Saving never breaks a chat: if the store fails the conversation carries on in
 * memory and the failure is logged. Sessions with no messages are never saved.
 *
 * Sessions belong to a person. `forOwner(key)` is that person's view: a session id is only ever looked up inside the
 * view, in memory AND in the store, so an id that belongs to someone else (or to nobody, or is guessed) is simply
 * "not found" and can never be read, extended, reset or deleted through another person's view. The service's own
 * methods are the view of the single-tenant fallback owner (LEGACY_OWNER).
 */
export function createSessionService({ store = null, logger = console } = {}) {
  const sessions = new Map() // `${owner}\0${id}` -> session
  let history = store

  const keyOf = (owner, id) => `${owner}\u0000${id}`
  const scoped = (owner) => {
    if (!history) return null
    return typeof history.forOwner === 'function' ? history.forOwner(owner === LEGACY_OWNER ? null : owner) : history
  }

  function evict(owner) {
    const mine = []
    for (const [key, session] of sessions) if (session.owner === owner) mine.push([key, session])
    if (sessions.size < MAX_SESSIONS && mine.length < MAX_SESSIONS_PER_OWNER) return
    // Saved conversations come back from the store on demand, so dropping the least recently used ones from memory loses nothing.
    const pool = mine.length >= MAX_SESSIONS_PER_OWNER ? mine : [...sessions]
    pool.sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
    for (const [key] of pool.slice(0, Math.max(1, Math.floor(pool.length / 4)))) sessions.delete(key)
  }

  function view(owner) {
    function persist(session, message) {
      const repo = scoped(owner)
      if (!repo) return
      try {
        repo.append(session.id, message, { conversationCreatedAt: session.createdAt, origin: session.metadata?.source ?? null })
      } catch (err) {
        logger.error('[history] could not save a message; the conversation continues without it', err?.message ?? err)
      }
    }

    function restore(sessionId) {
      const repo = scoped(owner)
      if (!repo || !UUID.test(String(sessionId))) return null
      try {
        const saved = repo.get(sessionId)
        if (!saved) return null
        const session = {
          id: saved.id,
          owner,
          state: ASSISTANT_STATES.IDLE,
          messages: saved.messages.map((m) => ({ id: randomUUID(), createdAt: m.createdAt, role: m.role, content: m.content })),
          metadata: { restored: true },
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt
        }
        evict(owner)
        sessions.set(keyOf(owner, session.id), session)
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
        owner,
        state: ASSISTANT_STATES.IDLE,
        messages: [],
        metadata,
        createdAt: now,
        updatedAt: now
      }
      evict(owner)
      sessions.set(keyOf(owner, session.id), session)
      return session
    }

    function getSession(sessionId) {
      if (!sessionId) return null
      return sessions.get(keyOf(owner, sessionId)) ?? restore(sessionId)
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

    /**
     * Removes a screenshot's messages (every user message that carries `markerPrefix` and the assistant message right after it) from the
     * session in memory and from the saved conversation. Returns how many messages were removed in all.
     */
    function removeScreenshot(sessionId, markerPrefix) {
      let removed = 0
      const session = sessions.get(keyOf(owner, sessionId))
      if (session) {
        const kept = []
        for (let i = 0; i < session.messages.length; i++) {
          const message = session.messages[i]
          if (message.role === 'user' && typeof message.content === 'string' && message.content.includes(markerPrefix)) {
            removed++
            if (session.messages[i + 1]?.role === 'assistant') {
              removed++
              i++
            }
            continue
          }
          kept.push(message)
        }
        session.messages = kept
        session.updatedAt = new Date().toISOString()
      }
      const repo = scoped(owner)
      if (repo && typeof repo.removeMarked === 'function') removed = Math.max(removed, repo.removeMarked(sessionId, markerPrefix))
      return removed
    }

    /** Forgets a session from memory (its saved copy is removed by the caller through the store). */
    function forget(sessionId) {
      sessions.delete(keyOf(owner, sessionId))
    }

    return {
      owner,
      createSession,
      getSession,
      getOrCreateSession,
      setState,
      appendMessage,
      removeScreenshot,
      forget,
      /** This owner's conversation store, or null when history is off. */
      getHistory: () => scoped(owner)
    }
  }

  const views = new Map()
  const forOwner = (owner) => {
    if (typeof owner !== 'string' || !owner) throw new Error('forOwner needs an owner key')
    if (!views.has(owner)) views.set(owner, view(owner))
    return views.get(owner)
  }
  const legacy = forOwner(LEGACY_OWNER)

  return {
    ...legacy,
    forOwner,
    /** The whole conversation store (administration and tests only; the routes never use it). */
    getStore: () => history,
    /** Turns saving on (once, at startup) for the shared service the routes use. */
    useStore(nextStore) {
      history = nextStore
    }
  }
}

export const sessionService = createSessionService()
