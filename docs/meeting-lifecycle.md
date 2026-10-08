# Meeting Lifecycle and Persistence

Status labels used below:

- **Implemented**: present in code and covered by a test (named in brackets).
- **Partially implemented**: present, with a limit stated next to it.
- **Planned**: not in the code. Nothing here describes planned behavior as if it already works.

## Summary

A **meeting** is the durable logical conversation. A **speech session** is one connection run that
contributes transcript to a meeting. A WebSocket connection never defines meeting identity: a
reconnect opens a new speech session on the same meeting. Canonical final segments are stored once,
ordered on one meeting timeline, and survive disconnects and process restarts.

## Meeting states — **Implemented** [`meetingLifecycle.test.js`]

```text
CREATED -> STARTING -> LIVE <-> PAUSED
                         |         |
                         v         v
                     RECOVERING ---+--> LIVE / STARTING   (resume after restart)
                         |
                         v
LIVE, PAUSED, RECOVERING -> FINALIZING -> COMPLETED
Any non-terminal state -> CANCELLED or FAILED (service only)
```

Exact table (verified cell by cell by the test):

| From | Allowed next states |
|---|---|
| CREATED | STARTING, CANCELLED, FAILED |
| STARTING | LIVE, RECOVERING, FAILED, CANCELLED |
| LIVE | PAUSED, RECOVERING, FINALIZING, FAILED, CANCELLED |
| PAUSED | LIVE, RECOVERING, FINALIZING, FAILED, CANCELLED |
| RECOVERING | STARTING, LIVE, FINALIZING, FAILED, CANCELLED |
| FINALIZING | COMPLETED, FAILED |
| COMPLETED, FAILED, CANCELLED | none (terminal) |

Invalid transitions return **409** with code `invalid-meeting-transition`.
`RECOVERING -> FINALIZING` is new in this milestone: an interrupted meeting can be ended without
resuming capture.

`CANCELLED` and `FAILED` are reachable through the service only. **Planned:** HTTP routes for them.

## Meeting and speech session — **Implemented** [`persistenceOutcomes.test.js`]

- A speech session has a status (`ACTIVE` or `ENDED`) and, when ended, an `endReason`:
  `stopped`, `disconnected`, `superseded`, `process-restart`, `meeting-completed`, or `error`.
- At most one session is `ACTIVE` per meeting. Attaching a new one supersedes the previous
  active session (`endReason: superseded`). Both rows stay in the record.
- Ending a meeting (`COMPLETED`, `FAILED`, `CANCELLED`) ends its active session.
- Segments are accepted from any session of the meeting, active or ended. Late, already-produced
  events from a session that dropped are still stored.

## Timeline contract — **Implemented** [`meetingLifecycle` + `meetingE2E`]

Every stored segment is on the **meeting timeline**:

```text
meeting start  = session.timelineOffsetMs + sessionStart
meeting end    = session.timelineOffsetMs + sessionEnd
```

`timelineOffsetMs` is fixed when a session attaches:

```text
timelineOffsetMs = max( wall-clock ms since the meeting went LIVE,
                        latest stored segment end in the meeting )
```

Consequences:

- A later session never starts before an earlier one ended. Time never goes backwards.
- The stored segment keeps its session-relative times in `sessionStart` and `sessionEnd`, and carries
  `speechSessionId` and `timeline: "meeting"`. See [transcript-schema.md](transcript-schema.md).
- Limit: the wall-clock term assumes audio arrives close to real time. A client that streams faster
  than real time gets offsets from the stored segments, which is still monotonic but not wall-clock.
- The API alone computes offsets, so clock skew between the speech sidecar and the API does not matter.

## Segment identity — **Implemented** [`test_live_session.py`, `persistenceOutcomes.test.js`]

- Live segment ids are `seg_` + 32 hex characters, derived as
  `uuid5(speechSessionId, "segment:<n>")`, where `n` is the event's sequence in its session.
- Two sessions, or two meetings, cannot produce the same id unless their UUIDs collide.
- A retry of the same event re-derives the same id, so the server recognizes it as a duplicate.
- The uniqueness boundary is `(meeting_id, segment_id)`, enforced by the primary key.
- Batch-pipeline ids (`seg_0001`) are local to one batch run. They are not written to meetings.

## Persistence outcomes — **Implemented** [`meetingsApi.test.js`, `test_live_persistence.py`]

Every write has exactly one outcome. The speech transport must distinguish them.

| Meeting API answer | Meaning | Transport state |
|---|---|---|
| `201 INSERTED` | Stored now | `DELIVERED` |
| `200 ALREADY_EXISTS` | Same id and identical canonical content (safe duplicate) | `DELIVERED` |
| `409 segment-id-conflict` | Same id, different content. Nothing is overwritten | `REJECTED` (quarantined) |
| `409 meeting-not-accepting-transcript` | Meeting is COMPLETED, FAILED or CANCELLED | `REJECTED` |
| `400 invalid-segment` | Fails validation | `REJECTED` |
| `404` | Unknown meeting or session | `REJECTED` |
| `401` / `403` / `503` | Ticket refused or not configured | `PENDING` (retained, not retried inline) |
| `5xx`, timeout, unreachable | Transient | `PENDING` (retried) |

`DELIVERED` is reported only after the API answered `201` or `200`. `PENDING` and `REJECTED` are
always reported, never folded into success.

Duplicate detection compares a SHA-256 of the canonical JSON of the stored segment. Equal hash means
`ALREADY_EXISTS`; different hash means `CONFLICT`.

## Transport durability — **Partially implemented** [`test_live_outbox.py`, `test_live_ws_integration.py`]

Implemented:

- Every committed final segment is written to the **durable outbox** (`audio/outbox/<meeting>.jsonl`,
  fsync per record) before the first delivery attempt.
- Acknowledgements are separate records, so replay is idempotent. A torn final write is ignored.
- A failed session start, an unreachable API, or a crash leaves segments pending. The next session
  start for the meeting, or the next stop, retries them in order.
- Committed segments are persisted before any finalization step can fail, so a later failure cannot
  discard them.
- The `stopped` frame reports `delivered`, `pending`, `rejected`, and whether the outbox is `durable`.

Limits (**Partially**):

- The outbox is on the sidecar's disk only. It is not replicated.
- If the outbox cannot be written, the segment is held in memory and the client gets an
  `outbox-unavailable` error. Nothing else is durable in that case.
- **Planned:** a replay command or background daemon. Today pending segments are retried only when
  a session for the same meeting starts or stops.

## Restart recovery — **Implemented** [`persistenceOutcomes.test.js`, `meetingE2E.test.js`]

On API startup (`recoverInterruptedMeetings`):

1. Every `ACTIVE` speech session ends with `endReason: process-restart`.
2. Every `STARTING`, `LIVE` or `PAUSED` meeting moves to `RECOVERING`.
3. Persisted segments are untouched.

**What is not recovered:** audio buffers, partial utterances, and in-flight ASR. Those are lost with
the process. Pending outbox segments are not lost (see above).

Operator path to continue a recovered meeting: attach a session (ticket), then resume (admin),
then keep streaming. `RECOVERING` can also be finalized directly.

## Authentication — **Implemented** as a shared-secret boundary [`meetingAuth.test.js`, `meetingsApi.test.js`]

| Credential | Source | Can do |
|---|---|---|
| Admin token | `MEETING_API_TOKEN` (≥ 32 chars) | Everything: create, lifecycle, reads, ticket minting |
| Meeting ticket | HMAC-SHA256 with `MEETING_TICKET_SECRET` (≥ 32 chars), bound to one meeting, expires after `MEETING_TICKET_TTL_S` (default 43200 s) | Attach/end that meeting's speech sessions; append that meeting's segments. Nothing else |

- Fails closed: when a credential type is not configured, its routes answer **503**
  `auth-not-configured`. Nothing is allowed by default.
- A ticket cannot read transcripts, change lifecycle, or touch another meeting (403).
- The speech transport receives a ticket from its client. It never receives the admin token.
- Provider boundary: `server/auth/meetingAuth.js` is the only module that knows the provider.
  Routes use `requireAdmin`, `requireMeetingWriter` and `issueTicket`.

**Not implemented (Planned):** per-user authentication, ticket revocation (only expiry today),
rate limiting, and an audit log. Tickets are bearer credentials: anyone holding one can write
within its meeting until it expires.

## API reference — **Implemented** [`meetingsApi.test.js`, `meetingE2E.test.js`]

Base path `/api/v1/meetings`. Errors are `{ error, code, requestId }`. Stacks are never returned.

| Method and path | Credential | Success | Notable errors |
|---|---|---|---|
| `POST /` | admin | 201 meeting + `ticket` | 400 `invalid-metadata` |
| `GET /:id` | admin | 200 | 400 `invalid-meeting-id`, 404 |
| `POST /:id/ticket` | admin | 201 `{ticket}` | 503 if tickets unconfigured |
| `POST /:id/start`, `/pause`, `/resume`, `/recover` | admin | 200 meeting | 409 `invalid-meeting-transition` |
| `POST /:id/end` | admin | 200 (COMPLETED) | 409 |
| `GET /:id/sessions` | admin | 200 list | |
| `POST /:id/sessions` | admin or ticket | 201 session | 409 `meeting-not-attachable` |
| `POST /:id/sessions/:sid/end` | admin or ticket | 200 session | 400 `invalid-end-reason` |
| `POST /:id/transcript/final` | admin or ticket | 201 INSERTED / 200 ALREADY_EXISTS | 409 `segment-id-conflict`, 409 `meeting-not-accepting-transcript`, 400 `invalid-segment`, 404 `speech-session-not-found` |
| `GET /:id/transcript` | admin | 200 segments in timeline order | |

`POST /:id/start` also creates the meeting's first speech session. That session is superseded when a
client attaches its own.

Not exposed over HTTP: cancel and fail. **Planned.**

## Not implemented — **Planned**

- Browser-initiated meeting creation. The app has no user authentication, so a browser cannot be
  trusted with an admin or ticket-minting credential. Today an operator creates meetings and hands a
  ticket to the live client.
- Connecting the hold-to-talk and conversation voice path to meetings. That path uses the batch
  `/api/v1/assistant/stt` endpoint and does not create speech sessions.
- Persisting the `reprocessOnStop` result. For meeting sessions the server ignores it, so the stored
  transcript is always the live one.
- Retention, deletion, export, and access-control policy.
- Running more than one API process against the same database. SQLite is single-writer here.
