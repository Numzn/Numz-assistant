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

/** Statuses that represent a meeting still being captured or recovered (listed at startup). */
export const ACTIVE_MEETING_STATUSES = Object.freeze(['STARTING', 'LIVE', 'PAUSED', 'RECOVERING'])

export function createMeetingRepository(database) {
  const insert = database.prepare(`
    INSERT INTO meetings
      (meeting_id, status, created_at, started_at, paused_at, ended_at, updated_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const select = database.prepare('SELECT * FROM meetings WHERE meeting_id = ?')
  const update = database.prepare(`
    UPDATE meetings
    SET status = ?, started_at = ?, paused_at = ?, ended_at = ?, updated_at = ?, metadata_json = ?
    WHERE meeting_id = ?
  `)

  const repository = {
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

    /** Persists lifecycle fields. created_at is immutable and deliberately not written here. */
    save(meeting) {
      update.run(
        meeting.status,
        meeting.startedAt,
        meeting.pausedAt,
        meeting.endedAt,
        meeting.updatedAt,
        JSON.stringify(meeting.metadata),
        meeting.meetingId
      )
      return meeting
    },

    findByStatus(statuses) {
      const placeholders = statuses.map(() => '?').join(', ')
      return database
        .prepare(`SELECT * FROM meetings WHERE status IN (${placeholders}) ORDER BY created_at, meeting_id`)
        .all(...statuses)
        .map(fromRow)
    },

    getActiveMeetings() {
      return repository.findByStatus(ACTIVE_MEETING_STATUSES)
    },

    getActiveMeeting() {
      return repository.getActiveMeetings()[0] ?? null
    }
  }
  return repository
}
