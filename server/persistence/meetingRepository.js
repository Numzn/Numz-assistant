import { createMeeting } from '../meetings/meetingDomain.js'

function fromRow(row) {
  if (!row) return null
  return {
    meetingId: row.meeting_id,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
    metadata: JSON.parse(row.metadata_json)
  }
}

export function createMeetingRepository(database) {
  const insert = database.prepare(`
    INSERT INTO meetings
      (meeting_id, status, created_at, started_at, paused_at, ended_at, updated_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const select = database.prepare('SELECT * FROM meetings WHERE meeting_id = ?')
  const update = database.prepare(`
    UPDATE meetings
    SET status = ?, created_at = ?, started_at = ?, paused_at = ?, ended_at = ?, updated_at = ?, metadata_json = ?
    WHERE meeting_id = ?
  `)

  return {
    create(input = {}) {
      const meeting = createMeeting(input)
      insert.run(
        meeting.meetingId,
        meeting.status,
        meeting.createdAt,
        meeting.startedAt,
        meeting.pausedAt,
        meeting.endedAt,
        meeting.updatedAt,
        JSON.stringify(meeting.metadata)
      )
      return meeting
    },

    getById(meetingId) {
      return fromRow(select.get(meetingId))
    },

    save(meeting) {
      update.run(
        meeting.status,
        meeting.createdAt,
        meeting.startedAt,
        meeting.pausedAt,
        meeting.endedAt,
        meeting.updatedAt,
        JSON.stringify(meeting.metadata),
        meeting.meetingId
      )
      return meeting
    },

    updateMetadata(meetingId, metadata) {
      const meeting = this.getById(meetingId)
      if (!meeting) return null
      return this.save({ ...meeting, metadata, updatedAt: new Date().toISOString() })
    },

    getActiveMeetings() {
      const rows = database.prepare(`
        SELECT * FROM meetings
        WHERE status IN ('STARTING', 'LIVE', 'PAUSED', 'RECOVERING')
        ORDER BY created_at, meeting_id
      `).all()
      return rows.map(fromRow)
    },

    getActiveMeeting() {
      return this.getActiveMeetings()[0] ?? null
    }
  }
}
