# Meeting Lifecycle

Milestone 2 introduces durable meetings independently from browser/WebSocket connections.

## Domain states

```text
CREATED -> STARTING -> LIVE -> PAUSED -> LIVE
                         |       |
                         v       v
                      RECOVERING  FINALIZING -> COMPLETED
```

`FAILED` and `CANCELLED` are explicit terminal states. `STARTING`, `LIVE`, `PAUSED`, and `RECOVERING` are recoverable after a process restart.

Invalid transitions are rejected by `server/meetings/meetingDomain.js`.

## Meeting and speech session

A meeting is the durable logical conversation. A speech session is one audio connection and is stored separately in `speech_sessions`. Multiple speech sessions may reference one meeting. Disconnecting a speech session does not delete or complete its meeting.

## Persistence

The Node API uses the built-in Node 22 `node:sqlite` runtime and creates the database at `SPEECH_DATABASE_PATH` (default `./data/speech.sqlite`). Schema initialization is performed by `server/persistence/sqliteDatabase.js`; schema version `1` creates:

- `meetings`, indexed by status
- `speech_sessions`, indexed by meeting ID
- `transcript_segments`, uniquely keyed by `(meeting_id, segment_id)` and indexed by chronological timestamps

The repository layer hides SQL from meeting services.

## Transcript authority and idempotency

Only canonical final segments are accepted by `TranscriptRepository.appendFinalSegment()`. Partial and stabilizing hypotheses are not persistence records. The canonical segment JSON is retained unchanged, while relational fields provide querying and indexing.

A repeated `(meetingId, segmentId)` is ignored by SQLite's unique primary key and returns `inserted: false`. Transcript reads order by `start`, `end`, and `segmentId`, so network arrival order does not affect retrieval order.

## Recovery policy

On application startup, `MeetingRepository.getActiveMeetings()` identifies meetings in `STARTING`, `LIVE`, `PAUSED`, or `RECOVERING`. The current policy does not complete them automatically. A caller explicitly moves a recoverable meeting to `RECOVERING`, then attaches a new speech session and resumes it when the client reconnects.

Persisted transcript segments remain available throughout this process. This is local/process recovery, not distributed worker recovery; active audio buffers and in-flight ASR work are not reconstructed.

## API boundary

- `POST /api/v1/meetings`
- `GET /api/v1/meetings/:meetingId`
- `POST /api/v1/meetings/:meetingId/start`
- `POST /api/v1/meetings/:meetingId/pause`
- `POST /api/v1/meetings/:meetingId/resume`
- `POST /api/v1/meetings/:meetingId/recover`
- `POST /api/v1/meetings/:meetingId/end`
- `POST /api/v1/meetings/:meetingId/transcript/final`
- `GET /api/v1/meetings/:meetingId/transcript`

The live Python WebSocket remains transport-specific, but it can now participate in persistence: include `meetingId` in its `start` control message and set `MEETING_API_URL`. The sidecar creates a separate speech session and posts each canonical final segment to the Node API. Without those two settings, the existing standalone live behavior is preserved. A meeting must already be `LIVE`, `STARTING`, or `RECOVERING` before a speech session can attach.
