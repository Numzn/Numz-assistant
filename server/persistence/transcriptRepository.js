function assertCanonicalSegment(segment) {
	if (!segment || typeof segment !== 'object') throw new Error('segment must be an object')
	if (typeof segment.id !== 'string' || !segment.id) throw new Error('segment.id is required')
	if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) {
		throw new Error(`invalid timestamps for segment: ${segment.id}`)
	}
	if (typeof segment.text !== 'string') throw new Error(`text is required for segment: ${segment.id}`)
	if (segment.uncertain === undefined) throw new Error(`uncertain is required for segment: ${segment.id}`)
}

function fromRow(row) {
	if (!row) return null
	return JSON.parse(row.segment_json)
}

export function createTranscriptRepository(database) {
	const insert = database.prepare(`
		INSERT OR IGNORE INTO transcript_segments
			(meeting_id, segment_id, speaker_id, start_ms, end_ms, text, confidence,
			 is_final, schema_version, segment_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	const select = database.prepare(`
		SELECT * FROM transcript_segments WHERE meeting_id = ? AND segment_id = ?
	`)

	return {
		appendFinalSegment(meetingId, segment, now = new Date().toISOString()) {
			assertCanonicalSegment(segment)
			const result = insert.run(
				meetingId,
				segment.id,
				segment.speaker ?? null,
				Math.round(segment.start * 1000),
				Math.round(segment.end * 1000),
				segment.text,
				segment.confidence ?? null,
				1,
				'1.0',
				JSON.stringify(segment),
				now,
				now
			)
			return { segment: this.getById(meetingId, segment.id), inserted: result.changes === 1 }
		},

		getById(meetingId, segmentId) {
			return fromRow(select.get(meetingId, segmentId))
		},

		exists(meetingId, segmentId) {
			return this.getById(meetingId, segmentId) !== null
		},

		getByMeeting(meetingId) {
			const rows = database.prepare(`
				SELECT * FROM transcript_segments
				WHERE meeting_id = ?
				ORDER BY start_ms, end_ms, segment_id
			`).all(meetingId)
			return rows.map(fromRow)
		}
	}
}
