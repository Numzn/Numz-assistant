import { randomUUID } from 'node:crypto'

function fromRow(row) {
  if (!row) return null
  return {
    speechSessionId: row.speech_session_id,
    meetingId: row.meeting_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at
  }
}

export function createSpeechSessionRepository(database) {
  const insert = database.prepare(`
    INSERT INTO speech_sessions
      (speech_session_id, meeting_id, status, started_at, ended_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const select = database.prepare('SELECT * FROM speech_sessions WHERE speech_session_id = ?')

  return {
    create({ meetingId, speechSessionId = randomUUID(), now = new Date().toISOString() }) {
      const session = { speechSessionId, meetingId, status: 'ACTIVE', startedAt: now, endedAt: null, updatedAt: now }
      insert.run(session.speechSessionId, session.meetingId, session.status, session.startedAt, session.endedAt, session.updatedAt)
      return session
    },

    getById(speechSessionId) {
      return fromRow(select.get(speechSessionId))
    },

    getByMeeting(meetingId) {
      return database.prepare(`
        SELECT * FROM speech_sessions WHERE meeting_id = ? ORDER BY started_at, speech_session_id
      `).all(meetingId).map(fromRow)
    }
  }
}
