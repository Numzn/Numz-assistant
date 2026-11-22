import { AcademicError, oneOf, textField } from './academicError.js'
import { SESSION_TYPES } from '../persistence/academicRepository.js'

/**
 * The Academic Session Manager: authorised study sessions. A session is the person's explicit, declared start of studying: its type
 * (study, practice, restricted), optionally its course and topic, and whether the screen may be read (`captureEnabled`) and questions answered
 * on their own (`autoAnswer`). Nothing academic happens without an active session (integrity.js checks it), and nothing is kept longer than
 * it: the row (settings and times, never content) is kept for the retention period; what the session holds in memory (screens read, questions
 * recognised) is dropped when it ends, expires, is cleared, or the server restarts.
 *
 * One session is open per person at a time. Starting another ends the earlier one ("replaced"). The type never changes (migration 8's trigger).
 */

const DEFAULT_TTL_MS = 4 * 3_600_000

export function createSessionManager({ academic, clock = Date.now, ttlMs = DEFAULT_TTL_MS, audit = () => {} }) {
  const runtimes = new Map() // `${userId}\0${sessionId}` -> what the session holds in memory
  const keyOf = (userId, sessionId) => `${userId}\u0000${sessionId}`
  const iso = (ms) => new Date(ms).toISOString()

  function forOwner(userId) {
    const mine = academic.forOwner(userId)
    const note = (event, detail) => audit(event, { userId, detail })

    function dropRuntime(sessionId) {
      runtimes.delete(keyOf(userId, sessionId))
    }

    function expireIfNeeded(session) {
      if (session && session.status !== 'ended' && Date.parse(session.expiresAt) < clock()) {
        const ended = mine.sessions.save({ ...session, status: 'ended', endedAt: iso(clock()), endReason: 'expired', lastActivityAt: iso(clock()) })
        dropRuntime(session.id)
        note('academic.session_end', { sessionId: session.id, reason: 'expired' })
        return ended
      }
      return session
    }

    const manager = {
      userId,

      start({ type, courseId = null, topic = null, captureEnabled = false, autoAnswer = false, useResearch = false } = {}) {
        const sessionType = oneOf(type, 'type', SESSION_TYPES)
        if (courseId && !mine.courses.get(courseId)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
        if (sessionType === 'restricted' && (captureEnabled === true || autoAnswer === true)) {
          throw new AcademicError(400, 'restricted-no-capture', 'A restricted session never reads the screen or answers by itself. Start it without those options.')
        }
        if (autoAnswer === true && captureEnabled !== true) throw new AcademicError(400, 'invalid-input', 'Answering by itself needs screen reading to be on.')
        const previous = mine.sessions.current()
        if (previous) {
          mine.sessions.endOpen('replaced')
          dropRuntime(previous.id)
          note('academic.session_end', { sessionId: previous.id, reason: 'replaced' })
        }
        const session = mine.sessions.insert({ courseId, sessionType, activeTopic: textField(topic, 'topic', { max: 120 }), captureEnabled: captureEnabled === true, autoAnswer: autoAnswer === true, useResearch: useResearch === true, ttlMs })
        note('academic.session_start', { sessionId: session.id, type: sessionType, courseId, capture: session.captureEnabled, autoAnswer: session.autoAnswer })
        return session
      },

      /** The open session (active or paused), or null. A session past its time is ended here. */
      current() {
        const session = expireIfNeeded(mine.sessions.current())
        return session && session.status !== 'ended' ? session : null
      },

      get(id) {
        return expireIfNeeded(mine.sessions.get(id))
      },

      /** Any activity in the session keeps it open (and moves its end time on). */
      touch(id) {
        const session = manager.get(id)
        if (!session || session.status === 'ended') return session
        return mine.sessions.save({ ...session, lastActivityAt: iso(clock()), expiresAt: iso(clock() + ttlMs) })
      },

      pause(id) {
        const session = manager.requireOpen(id)
        if (session.status === 'paused') return session
        const saved = mine.sessions.save({ ...session, status: 'paused', lastActivityAt: iso(clock()) })
        note('academic.session_pause', { sessionId: id })
        return saved
      },

      resume(id) {
        const session = manager.requireOpen(id)
        if (session.status === 'active') return session
        const saved = mine.sessions.save({ ...session, status: 'active', lastActivityAt: iso(clock()), expiresAt: iso(clock() + ttlMs) })
        note('academic.session_resume', { sessionId: id })
        return saved
      },

      stop(id, reason = 'stopped') {
        const session = manager.get(id)
        if (!session) throw new AcademicError(404, 'session-not-found', 'That study session does not exist.')
        if (session.status === 'ended') return session
        const saved = mine.sessions.save({ ...session, status: 'ended', endedAt: iso(clock()), endReason: reason, lastActivityAt: iso(clock()) })
        dropRuntime(id)
        note('academic.session_end', { sessionId: id, reason })
        return saved
      },

      /** The topic and the course may change during a session; the type, the capture and answer options may not widen. */
      update(id, patch = {}) {
        const session = manager.requireOpen(id)
        const next = { ...session, lastActivityAt: iso(clock()) }
        if ('topic' in patch) next.activeTopic = textField(patch.topic, 'topic', { max: 120 })
        if ('courseId' in patch) {
          if (patch.courseId && !mine.courses.get(patch.courseId)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
          next.courseId = patch.courseId || null
        }
        if ('captureEnabled' in patch) {
          if (patch.captureEnabled === true && session.sessionType === 'restricted') throw new AcademicError(400, 'restricted-no-capture', 'A restricted session never reads the screen.')
          next.captureEnabled = patch.captureEnabled === true
          if (!next.captureEnabled) next.autoAnswer = false
        }
        if ('autoAnswer' in patch) {
          if (patch.autoAnswer === true && (session.sessionType === 'restricted' || !next.captureEnabled)) throw new AcademicError(400, 'invalid-input', 'Answering by itself needs a non-restricted session with screen reading on.')
          next.autoAnswer = patch.autoAnswer === true
        }
        if ('useResearch' in patch) next.useResearch = patch.useResearch === true
        return mine.sessions.save(next)
      },

      requireOpen(id) {
        const session = manager.get(id)
        if (!session) throw new AcademicError(404, 'session-not-found', 'That study session does not exist.')
        if (session.status === 'ended') throw new AcademicError(409, 'session-ended', 'That study session has ended. Start a new one.')
        return session
      },

      /** What the session holds in memory (screens read, questions recognised). Created on first use, gone when the session is. */
      runtime(id) {
        const key = keyOf(userId, id)
        if (!runtimes.has(key)) runtimes.set(key, { captures: new Map(), questions: new Map(), pictureHashes: new Map(), known: [], reads: 0, lastReadAt: null, busy: false })
        return runtimes.get(key)
      },

      /** Forget everything held in memory for the person's sessions (they cleared the session lane). */
      clearRuntime() {
        for (const key of [...runtimes.keys()]) if (key.startsWith(`${userId}\u0000`)) runtimes.delete(key)
      }
    }
    return manager
  }

  return {
    forOwner,
    /** Sessions that ended without being asked to (expiry) release what they held. */
    sweep() {
      const live = new Set()
      for (const key of runtimes.keys()) live.add(key)
      let dropped = 0
      for (const key of live) {
        const [userId, sessionId] = key.split('\u0000')
        const session = academic.forOwner(userId).sessions.get(sessionId)
        if (!session || session.status === 'ended' || Date.parse(session.expiresAt) < clock()) {
          runtimes.delete(key)
          dropped++
        }
      }
      return dropped
    },
    heldCount: () => runtimes.size
  }
}
