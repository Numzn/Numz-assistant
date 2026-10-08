import { randomUUID } from 'node:crypto'

function fromRow(row) {
  if (!row) return null
  return {
    speechSessionId: row.speech_session_id,
    meetingId: row.meeting_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
    timelineOffsetMs: row.timeline_offset_ms,
    endReason: row.end_reason ?? null
  }
}

/**
 * Speech sessions are one connection/processing run attached to a meeting.
 * They never own meeting identity: a meeting outlives any number of sessions.
 */
export function createSpeechSessionRepository(database) {
  const insert = database.prepare(`
    INSERT INTO speech_sessions
      (speech_session_id, meeting_id, status, started_at, ended_at, updated_at, timeline_offset_ms, end_reason)
    VALUES (?, ?, 'ACTIVE', ?, NULL, ?, ?, NULL)
  `)
  const select = database.prepare('SELECT * FROM speech_sessions WHERE speech_session_id = ?')
  const byMeeting = database.prepare(
    'SELECT * FROM speech_sessions WHERE meeting_id = ? ORDER BY started_at, speech_session_id'
  )
  const activeByMeeting = database.prepare(`
    SELECT * FROM speech_sessions WHERE meeting_id = ? AND status = 'ACTIVE'
    ORDER BY started_at, speech_session_id
  `)
  const activeAll = database.prepare(`
    SELECT * FROM speech_sessions WHERE status = 'ACTIVE' ORDER BY started_at, speech_session_id
  `)
  const endOne = database.prepare(`
    UPDATE speech_sessions
    SET status = 'ENDED', ended_at = ?, updated_at = ?, end_reason = ?
    WHERE speech_session_id = ? AND status = 'ACTIVE'
  `)

  const repository = {
    create({ meetingId, speechSessionId = randomUUID(), now = new Date().toISOString(), timelineOffsetMs = 0 }) {
      insert.run(speechSessionId, meetingId, now, now, timelineOffsetMs)
      return repository.getById(speechSessionId)
    },

    getById(speechSessionId) {
      return fromRow(select.get(speechSessionId))
    },

    getByMeeting(meetingId) {
      return byMeeting.all(meetingId).map(fromRow)
    },

    getActiveByMeeting(meetingId) {
      return activeByMeeting.all(meetingId).map(fromRow)
    },

    listActive() {
      return activeAll.all().map(fromRow)
    },

    /** Moves an ACTIVE session to ENDED. Returns true only when this call performed the transition. */
    end({ speechSessionId, reason, now = new Date().toISOString() }) {
      return endOne.run(now, now, reason, speechSessionId).changes === 1
    }
  }
  return repository
}
