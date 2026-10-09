# Meeting Lifecycle and Persistence

Status labels used below:

- **Implemented**: present in code and covered by a test (named in brackets).
- **Partially implemented**: present, with a limit stated next to it.
- **Planned**: not in the code. Nothing here describes planned behavior as if it already works.

## Summary

A **meeting** is the durable logical conversation. A **speech session** is one connection run that
contributes transcript to a meeting. A WebSocket connection never defines meeting identity: a
reconnect opens a new speech session on the same meeting. Canonical final segments are stored once,
ordered on one meeting timeline, and survive disconnects and process restarts. A meeting cannot be
ended while its transcript is known to be incomplete.

## Identity model — **Implemented** [`persistenceOutcomes.test.js`]

```text
Meeting ── has many ──> SpeechSession ── has many ──> TranscriptSegment
```

| Level | Id | Created by | Lives until |
|---|---|---|---|
| Meeting | UUID (`meetingId`) | An operator, `POST /meetings` | `COMPLETED`, `FAILED` or `CANCELLED` |
| Speech session | UUID (`speechSessionId`) | The speech transport, when it attaches (`POST /:id/sessions`) | The connection ends; then `ENDED` with a reason |
| Transcript segment | `seg_` + 32 hex, see Segment identity below | The speech transport | Stored once per meeting, linked to its session |

Starting a meeting creates **no** speech session. Each connection attaches its own, so a meeting with
two connections has exactly two sessions. A segment must name its session; the API never guesses it.

## Meeting states — **Implemented** [`meetingLifecycle.test.js`]

```text
CREATED -> STARTING -> LIVE <-> PAUSED
                         |         |
                         v         v
                     RECOVERING ---+--> LIVE / STARTING   (resume after restart)
                         |
                         v
LIVE, PAUSED, RECOVERING -> FINALIZING -> COMPLETED
Any non-terminal state -> CANCELLED or FAILED
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

- Invalid transitions return **409** `invalid-meeting-transition`.
- Repeating the current state is a no-op. In particular a closed meeting is never rewritten, so its
  end time cannot drift when a client retries.
- `COMPLETED` means the transcript has no known loss (see Completion integrity below).
- `CANCELLED` is an abandoned meeting. `FAILED` is an explicit failure, for example a transcript that
  can never be made complete. Both take an optional `reason`, kept in `metadata.closeReason` (a reserved
  key). Stored segments stay readable in every closed state.

## Closed meetings are immutable — **Implemented** [`persistenceOutcomes.test.js`, `meetingsApi.test.js`]

A `COMPLETED`, `FAILED` or `CANCELLED` meeting accepts nothing:

- Service level: appends and new sessions return **409** (`meeting-not-accepting-transcript`,
  `meeting-not-attachable`); every lifecycle route except a repeat of the same close returns **409**.
- Database level (migration 3 triggers): inserting a segment or a session, editing a segment, or changing
  the meeting's status fails with `meeting-closed` or `meeting-terminal`, even from a writer that bypasses
  the service. These surface as a generic 500 if ever hit, because they mean a bug, not a client mistake.

## Meeting and speech session — **Implemented** [`persistenceOutcomes.test.js`]

- A speech session has a status (`ACTIVE` or `ENDED`) and, when ended, an `endReason`:
  `stopped`, `disconnected`, `superseded`, `process-restart`, `meeting-completed`, or `error`.
- At most one session is `ACTIVE` per meeting. Attaching a new one supersedes the previous
  active session (`endReason: superseded`). Both rows stay in the record.
- Ending a meeting ends its active sessions.
- Segments are accepted from any session of the meeting, active or ended. Late, already-produced
  events from a session that dropped are still stored while the meeting is open.
- When a session ends, the transport reports `committedSegments`, how many final segments it produced.

## Timeline contract — **Implemented** [`persistenceOutcomes.test.js`, `meetingE2E.test.js`]

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
- Segments are ordered by `start`, then `end`, then `id` (a stable tie-break, not arrival order).
- Limit: the wall-clock term assumes audio arrives close to real time. A client that streams faster
  than real time gets offsets from the stored segments, which is still monotonic but not wall-clock.
- The API alone computes offsets, so clock skew between the speech sidecar and the API does not matter.

## Segment identity — **Implemented** [`test_live_session.py`, `persistenceOutcomes.test.js`]

- Live segment ids are `seg_` + 32 hex characters, derived as
  `uuid5(speechSessionId, "segment:<n>")`, where `n` is the event's sequence in its session.
- Two sessions, or two meetings, cannot produce the same id unless their UUIDs collide.
- A retry of the same event re-derives the same id, so the server recognizes it as a duplicate.
- The uniqueness boundary is `(meeting_id, segment_id)`, enforced by the primary key. If two writers
  ever do send the same id with different content, the second gets **409** `segment-id-conflict`. It is
  never ignored and never overwrites.
- Batch-pipeline ids (`seg_0001`) are local to one batch run. They are not written to meetings.

## Persistence outcomes — **Implemented** [`meetingsApi.test.js`, `test_live_persistence.py`]

Every write has exactly one outcome, and the speech transport keeps all four distinct.

| Meeting API answer | Meaning | Transport outcome |
|---|---|---|
| `201` with `status: INSERTED` | Stored now | `INSERTED` |
| `200` with `status: ALREADY_EXISTS` | Same id and identical canonical content (safe duplicate) | `ALREADY_EXISTS` |
| `200`/`201` **without** that explicit status (for example `inserted: false`) | Proves nothing was stored | `FAILED` (`unexpected-response`), kept, not retried inline |
| `409 segment-id-conflict` | Same id, different content. Nothing is overwritten | `REJECTED` (quarantined) |
| `409 meeting-not-accepting-transcript` | Meeting is COMPLETED, FAILED or CANCELLED | `REJECTED` |
| `400 invalid-segment` | Fails validation | `REJECTED` |
| `404` | Unknown meeting or session | `REJECTED` |
| `401` / `403` / `503` | Ticket refused or not configured | `FAILED` (kept, not retried inline) |
| `5xx`, timeout, unreachable | Transient | `FAILED` (kept, retried) |

A segment is **persisted** only as `INSERTED` or `ALREADY_EXISTS`. `FAILED` and `REJECTED` are always
reported to the client and counted, never folded into success. Duplicate detection compares a SHA-256
of the canonical JSON of the stored segment: equal means `ALREADY_EXISTS`, different means conflict.

## Completion integrity — **Implemented** [`persistenceOutcomes.test.js`, `meetingsApi.test.js`, `test_live_ws_integration.py`]

When a session ends it reports how many final segments it committed. The API compares that with the
segments it stored for the session:

| State | Meaning | Blocks `POST /:id/end`? |
|---|---|---|
| `VERIFIED` | Reported count equals stored count | No |
| `UNVERIFIED` | Nothing reported, whether or not anything is stored: the transport crashed, or could not reach the API when it stopped, and may still hold committed segments in its outbox | No, but the meeting is not `verified` |
| `INCOMPLETE` | Reported more than stored: segments are missing | **409** `transcript-incomplete` |
| `INCONSISTENT` | Stored more than reported: the report cannot be trusted | **409** `transcript-incomplete` |
| `OPEN` | Still `ACTIVE` and has produced transcript | **409** `speech-session-active` |

- The check runs before anything changes, so a refusal leaves the meeting exactly as it was and
  capture can continue.
- The report is `integrity: { complete, verified, unverifiedSessions, missingSegments, sessions[] }`.
  `complete` means no known loss and nothing still streaming. `verified` also requires that no session
  is unverified. It is returned by `POST /:id/end` and `GET /:id/transcript`.
- To resolve `transcript-incomplete`: deliver the missing segments from the transport outbox
  (`npm run outbox:replay`, below), then end the meeting again. If they can never be delivered, mark the
  meeting failed with `POST /:id/fail`.
- A session that ended without reporting stays `UNVERIFIED`, even when nothing is stored for it: a transport that could not reach the API cannot have reported, and its committed segments may be waiting in its outbox. Run `npm run outbox:status` on the sidecar host, and `npm run outbox:replay` while the meeting is still open. The API does not claim more than it knows. Only a report makes a session `VERIFIED`, including a clean stop that committed nothing (`committedSegments: 0`).
  The first count report for a session that already ended is still accepted and recorded.

## Transport durability — **Partially implemented** [`test_live_outbox.py`, `test_live_outbox_cli.py`, `test_live_ws_integration.py`]

Implemented:

- Every committed final segment is written to the **durable outbox** (`audio/outbox/<meeting>.jsonl`,
  fsync per record) before the first delivery attempt.
- Acknowledgements are separate records, so replay is idempotent. A torn final write is ignored.
- A failed session start, an unreachable API, or a crash leaves segments waiting. The next session
  start for the meeting, or the next stop, retries them in order.
- Committed segments are persisted before any finalization step can fail, so a later failure cannot
  discard them.
- The `stopped` frame reports `committed`, `inserted`, `alreadyExists`, `rejected`, `failed` (the retry
  backlog) and whether the outbox is `durable`.
- Operator tool: `npm run outbox:status` lists what is waiting or refused per meeting (offline).
  `MEETING_TICKET=<ticket> npm run outbox:replay -- <meeting-id>` delivers the waiting segments of that
  meeting, including those of sessions that already ended. The ticket comes from the environment, never
  from the command line.

Limits (**Partially**):

- The outbox is on the sidecar's disk only. It is not replicated.
- If the outbox cannot be written, the segment is held in memory and the client gets an
  `outbox-unavailable` error. Nothing else is durable in that case.
- **Planned:** a background replay daemon. Today waiting segments are retried when a session for the
  same meeting starts or stops, or when an operator runs the replay tool.

## Restart recovery — **Implemented** [`persistenceOutcomes.test.js`, `meetingE2E.test.js`]

On API startup (`recoverInterruptedMeetings`):

1. Every `ACTIVE` speech session ends with `endReason: process-restart`.
2. Every `STARTING`, `LIVE` or `PAUSED` meeting moves to `RECOVERING`.
3. Persisted segments are untouched.

The startup log states what was recovered. A session ended this way has no reported count, so it is
`UNVERIFIED` unless its transport files the count afterwards.

**What is not recovered:** audio buffers, partial utterances, and in-flight ASR. Those are lost with
the process. Waiting outbox segments are not lost (see above).

Operator path to continue a recovered meeting: attach a session (ticket), then resume (admin),
then keep streaming. `RECOVERING` can also be ended directly.

## Authentication — **Implemented** as a shared-secret boundary [`meetingAuth.test.js`, `meetingsApi.test.js`, `meetingLaunch.test.js`]

| Credential | Source | Can do |
|---|---|---|
| Admin token | `MEETING_API_TOKEN` (≥ 32 chars) | Everything: create, lifecycle, reads, ticket minting |
| Meeting ticket | HMAC-SHA256 with `MEETING_TICKET_SECRET` (≥ 32 chars), bound to one meeting, expires after `MEETING_TICKET_TTL_S` (default 43200 s) | For that one meeting: attach/end its speech sessions, append its segments, and **end the meeting**. Nothing else |
| Launch code | `MEETING_LAUNCH_CODE` (≥ 12 chars), sent as `X-Meeting-Launch-Code` | **Start a new meeting** (`POST /launch`) and receive its ticket. Nothing else: it is not an admin token or a ticket, and cannot read, list or end anything |

- Fails closed: when a credential type is not configured, its routes answer **503**
  (`auth-not-configured`, or `launch-not-configured` for the launch code). Nothing is allowed by default.
- A ticket cannot read transcripts, pause, cancel or fail a meeting, mint tickets, or touch another meeting (403).
- The speech transport and the browser each receive a ticket. Neither ever receives the admin token.
- The launch code is the only thing a browser needs to type. Ten wrong codes in a minute lock the
  endpoint for everyone for the rest of that minute (429 `too-many-attempts`, with `Retry-After`), even
  for the right code, so the code cannot be guessed at speed. Correct launches never count.
- Provider boundary: `server/auth/meetingAuth.js` is the only module that knows the provider.
  Routes use `requireAdmin`, `requireMeetingWriter`, `requireLaunchCode` and `issueTicket`; the
  live-speech relay uses `authenticateToken` because a browser WebSocket cannot send headers.

**Not implemented (Planned):** per-user authentication (the launch code is one shared secret, so it says
the caller knows the code, not who they are), ticket revocation (only expiry today), general rate
limiting (only the launch-code lockout), and an audit log. Tickets are bearer credentials: anyone
holding one can write within its meeting, and end it, until it expires.

## Observability — **Implemented** [`meetingHealth.test.js`, `meetingE2E.test.js`, `test_live_health.py`]

A misconfigured persistence setup is reported, not silent.

- `GET /api/v1/health` includes `meetings: { ready, schemaVersion, auth: { admin, tickets }, launch: { enabled }, problem? }`.
  Booleans only; no secret is ever returned. `launch.enabled` says whether the browser's Start meeting
  button can work (a usable launch code and tickets). The startup log states each fact and warns when
  persistence cannot work or launching is disabled.
- The sidecar's `GET /health` includes `persistence: { state, configured, apiOrigin, outboxDurable, outbox,
  meetingApi, problem? }`. `state` is one of:

  | State | Meaning |
  |---|---|
  | `disabled` | `MEETING_API_URL` is unset. Standalone sessions work; meeting-bound ones are refused |
  | `misconfigured` | Unreachable, not the meeting API (for example the URL includes `/api/v1`), or its credentials are not configured |
  | `degraded` | Segments waiting, refused or unreadable, or the outbox is not durable |
  | `ok` | Nothing waiting and the meeting API reported itself ready |

  Only the URL's origin is reported. The check is also logged at sidecar startup.
- A meeting-bound `start` that cannot work fails with an explicit error: `persistence-unconfigured`,
  `persistence-unauthorized`, `persistence-unavailable` or `persistence-rejected`.

## API reference — **Implemented** [`meetingsApi.test.js`, `meetingE2E.test.js`]

Base path `/api/v1/meetings`. Errors are `{ error, code, requestId }`, plus `details` where a caller can
act on it. Stacks are never returned.

| Method and path | Credential | Success | Notable errors |
|---|---|---|---|
| `POST /` | admin | 201 meeting + `ticket` | 400 `invalid-metadata` |
| `POST /launch` | launch code | 201 LIVE meeting + `ticket` (creates, starts and tickets in one step; body `{ title? }`, metadata gets `source: "browser"`) | 401 `launch-code-required` / `launch-code-invalid`, 429 `too-many-attempts`, 503 `launch-not-configured`, 400 `invalid-title`. Nothing is created on any error; a meeting that cannot be started is cancelled |
| `GET /:id` | admin | 200 | 400 `invalid-meeting-id`, 404 |
| `POST /:id/ticket` | admin | 201 `{ticket}` | 503 if tickets unconfigured |
| `POST /:id/start` | admin | 200 meeting (creates no session) | 409 `invalid-meeting-transition` |
| `POST /:id/pause`, `/resume`, `/recover` | admin | 200 meeting | 409 `invalid-meeting-transition` |
| `POST /:id/end` | admin, or the meeting's own ticket | 200 COMPLETED + `integrity` | 409 `transcript-incomplete`, 409 `speech-session-active`, 409 `invalid-meeting-transition` |
| `POST /:id/cancel`, `/fail` | admin | 200 meeting; optional body `{ reason }` | 400 `invalid-close-reason`, 409 `invalid-meeting-transition` |
| `GET /:id/sessions` | admin | 200 list with `committedSegments` and `storedSegments` | |
| `POST /:id/sessions` | admin or ticket | 201 session | 409 `meeting-not-attachable` |
| `POST /:id/sessions/:sid/end` | admin or ticket | 200 session; body `{ reason, committedSegments? }` | 400 `invalid-end-reason`, 400 `invalid-committed-segments` |
| `POST /:id/transcript/final` | admin or ticket | 201 INSERTED / 200 ALREADY_EXISTS | 409 `segment-id-conflict`, 409 `meeting-not-accepting-transcript`, 400 `invalid-segment`, 400 `invalid-speech-session-id`, 404 `speech-session-not-found` |
| `GET /:id/transcript` | admin | 200 segments in timeline order + `integrity` | |

## Starting a meeting from the browser — **Implemented** [`meetingLaunch.test.js`, `meetingLaunchE2E.test.js`, `liveSpeechRelay.test.js`, `meetingController.test.js`, `liveSpeechClient.test.js`]

The **Meeting** button on the assistant screen opens a panel. The flow, in order:

1. **Launch.** The user types the launch code (kept for the tab's session only) and an optional title.
   The page checks the browser can record (a secure page with a microphone and AudioWorklet) *before*
   creating anything, then calls `POST /api/v1/meetings/launch` and receives the meeting and its own ticket.
2. **Stand down.** From launch until the meeting is finished or forgotten, the hands-free assistant
   stops listening, the wake word is disarmed and its buttons are inert, so it cannot answer meeting
   speech aloud. It comes back afterwards.
3. **Stream.** The page opens `wss://<app>/api/v1/live-speech` (the **relay**) and streams the
   microphone. Each finished line is shown with whether the server stored it: saved, waiting, or not saved.
4. **Stop and save.** The page stops recording, then calls `POST /:id/end` with its ticket. The server
   refuses (409) while the recording is still closing or lines are missing, so the page retries for about
   20 seconds, then offers **Try again**. The result is shown plainly: *saved and verified*, *ended but not
   verified* (a recording never confirmed its line count), or *nothing was recorded*.

**Recovery.** The meeting id and ticket are kept in the browser (`localStorage`) until the meeting is
finished. A reloaded or reopened page offers **Finish meeting** or **Forget this meeting**; a dropped
connection or blocked microphone offers **Reconnect** (a new speech session on the same meeting) or
**End meeting**. A meeting left open with an expired ticket is dropped from the browser with a note, and
an operator ends it (`npm run meeting -- end <id>`). Leaving the page while recording asks for confirmation.

**The relay** (`server/websocket/liveSpeechRelay.js`, path `/api/v1/live-speech`) exists because a page
served over HTTPS may only open `wss://`, while the speech service speaks plain `ws://` on a host port.

- Only a holder of a valid meeting ticket gets in. The ticket is offered as a WebSocket subprotocol,
  `[numz.meeting-ticket.v1, <token>]`, so it is in no URL or log, and it is never echoed back. The admin
  token, expired tickets and anything else get 401.
- The first client message must be a `start` for the ticket's own meeting carrying that same ticket
  (otherwise close 1008), so a ticket cannot open a standalone session or write to another meeting. After
  that, text and binary frames pass through unchanged in both directions.
- Limits: 4 concurrent relays (503 beyond), 1 MiB per message, `start` within 10 s, and a backed-up
  speech service closes the connection (1013) instead of buffering without bound. An unreachable speech
  service closes the client with 1011.
- All WebSocket upgrades go through one dispatcher (`server/websocket/upgradeRouter.js`); unknown paths get 404.

**Configuration.** Set `MEETING_LAUNCH_CODE` in `.env.secrets` (see `.env.secrets.example`) and restart
the server. Without it the button is still there, but the panel says meetings cannot be started from here
and `meetings.launch.enabled` in `/api/v1/health` is `false`.

**Validated in a real browser (Chrome, against the dev server):** the panel, wrong and right launch codes,
the assistant standing down and returning, the ticket subprotocol through Vite's proxy and the relay to the
real speech service, ending with the ticket, and the "Leave site?" guard.
**Requires manual validation:** a recording with a real microphone, saved end to end. The speech service
reports to `MEETING_API_URL`; in development that is the production API, which does not know a meeting made
by the dev server, so the speech service answers `persistence-rejected: meeting-not-found`. Run it from the
production page, or point `MEETING_API_URL` at the dev API for the duration of the test.

## Operator workflow — **Implemented** [`meetingAdminCli.test.js`]

An operator drives the lifecycle with `npm run meeting`. It reads `MEETING_API_TOKEN` and `MEETING_API_URL` from
`.env.secrets` and `.env`, and never prints the admin token.

```bash
npm run meeting -- create "Weekly sync"    # prints the meeting id and a ticket for the live client
npm run meeting -- start <meeting-id>
# give the meeting id and ticket to the live client, speak, stop it
npm run meeting -- show <meeting-id>       # sessions with committed vs stored counts, and the integrity report
npm run meeting -- end <meeting-id>        # refused with the reason while the transcript is incomplete
```

If `end` is refused with `transcript-incomplete`, run `npm run outbox:replay -- <meeting-id>` on the sidecar host, or
close the meeting honestly with `npm run meeting -- fail <meeting-id> "reason"`. `cancel`, `ticket` and `transcript`
are also available.

## Database — **Implemented** [`persistenceOutcomes.test.js`]

SQLite, numbered additive migrations, each in its own transaction and recorded in `schema_migrations`:

1. Initial meeting, speech session and transcript schema.
2. Timeline offset, content hash for idempotency, session end reason.
3. Committed segment counts, and the closed-meeting triggers above.

A version 2 database upgrades in place and keeps its data (tested).

## Not implemented — **Planned**

- Per-user login for starting meetings. Starting from the browser is gated by one shared launch code.
- Connecting the hold-to-talk and conversation voice path to meetings. That path uses the batch
  `/api/v1/assistant/stt` endpoint and does not create speech sessions.
- Persisting the `reprocessOnStop` result. For meeting sessions the server ignores it, so the stored
  transcript is always the live one.
- A background outbox replay daemon, and reporting counts for sessions whose transport crashed.
- Retention, deletion, export, and access-control policy.
- Running more than one API process against the same database. SQLite is single-writer here.
