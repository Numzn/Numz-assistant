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
  // Ownership (migration 9) is kept out of the meeting object on purpose: nothing that compares or serialises a meeting changes. These
  // statements are prepared on first use, so a repository built over a database that has not been migrated yet still works.
  const lazy = (sql) => {
    let statement = null
    return () => (statement ??= database.prepare(sql))
  }
  const setOwner = lazy('UPDATE meetings SET owner_user_id = ? WHERE meeting_id = ? AND owner_user_id IS NULL')
  const ownerOf = lazy('SELECT owner_user_id AS owner FROM meetings WHERE meeting_id = ?')
  const ownedBy = lazy('SELECT * FROM meetings WHERE owner_user_id = ? ORDER BY created_at DESC, meeting_id LIMIT ?')
  const unowned = lazy('SELECT * FROM meetings WHERE owner_user_id IS NULL ORDER BY created_at DESC, meeting_id')
  const claimOne = lazy('UPDATE meetings SET owner_user_id = ? WHERE meeting_id = ? AND owner_user_id IS NULL')
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
      if (typeof input.ownerUserId === 'string' && input.ownerUserId) setOwner().run(input.ownerUserId, meeting.meetingId)
      return meeting
    },

    /** The person a meeting belongs to, or null (an older meeting, or one started with the host's admin token). */
    getOwner(meetingId) {
      return ownerOf().get(meetingId)?.owner ?? null
    },

    /** A person's own meetings, newest first. */
    listOwnedBy(userId, { limit = 100 } = {}) {
      return ownedBy().all(userId, Math.min(500, Math.max(1, limit))).map(fromRow)
    },

    /** Meetings nobody owns yet (host-side administration). */
    listUnowned() {
      return unowned().all().map(fromRow)
    },

    /** Gives unowned meetings to a person (all of them, or just these ids). Never takes a meeting from its owner. */
    claim(userId, meetingIds = null) {
      const ids = meetingIds ?? unowned().all().map((row) => row.meeting_id)
      let moved = 0
      for (const id of ids) moved += claimOne().run(userId, id).changes
      return moved
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
