import { contentHash } from './canonicalJson.js'

function fromRow(row) {
  return row ? JSON.parse(row.segment_json) : null
}

/**
 * Canonical final segments for meetings.
 *
 * Uniqueness is (meeting_id, segment_id). A write has exactly one of three outcomes:
 *   INSERTED        - new row stored
 *   ALREADY_EXISTS  - same id with identical canonical content (a safe duplicate delivery)
 *   CONFLICT        - same id with different content: nothing is written or overwritten
 * Callers must never treat CONFLICT as success.
 */
export function createTranscriptRepository(database) {
  const insert = database.prepare(`
    INSERT INTO transcript_segments
      (meeting_id, segment_id, speaker_id, start_ms, end_ms, text, confidence,
       is_final, schema_version, segment_json, created_at, updated_at, content_hash, speech_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, '1.0', ?, ?, ?, ?, ?)
  `)
  const select = database.prepare('SELECT * FROM transcript_segments WHERE meeting_id = ? AND segment_id = ?')
  const maxEnd = database.prepare('SELECT MAX(end_ms) AS max_end FROM transcript_segments WHERE meeting_id = ?')
  const chronological = database.prepare(`
    SELECT segment_json FROM transcript_segments
    WHERE meeting_id = ?
    ORDER BY start_ms, end_ms, segment_id
  `)

  return {
    /**
     * @param {{ meetingId: string, speechSessionId: string, canonical: object, now: string }} input
     *   canonical: the segment already expressed on the meeting timeline
     */
    insertFinalSegment({ meetingId, speechSessionId, canonical, now }) {
      const hash = contentHash(canonical)
      const existing = select.get(meetingId, canonical.id)
      if (existing) {
        const stored = fromRow(existing)
        return existing.content_hash === hash
          ? { status: 'ALREADY_EXISTS', segment: stored }
          : { status: 'CONFLICT', segment: stored }
      }

      insert.run(
        meetingId,
        canonical.id,
        canonical.speaker ?? null,
        Math.round(canonical.start * 1000),
        Math.round(canonical.end * 1000),
        canonical.text,
        canonical.confidence ?? null,
        JSON.stringify(canonical),
        now,
        now,
        hash,
        speechSessionId
      )
      return { status: 'INSERTED', segment: canonical }
    },

    /** Latest end of any stored segment for the meeting, in meeting milliseconds (0 when empty). */
    maxEndMs(meetingId) {
      return maxEnd.get(meetingId)?.max_end ?? 0
    },

    getById(meetingId, segmentId) {
      return fromRow(select.get(meetingId, segmentId))
    },

    getByMeeting(meetingId) {
      return chronological.all(meetingId).map(fromRow)
    }
  }
}
