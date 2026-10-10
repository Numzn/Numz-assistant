# Speech and Meeting Intelligence Architecture

Status labels: **Implemented**, **Partially implemented**, **Planned** (see
[meeting-lifecycle.md](meeting-lifecycle.md)).

## Scope

This describes the Speech / Meeting Intelligence subsystem. The voice assistant (hold-to-talk and
conversation mode) and the Three.js renderer are separate consumers. They are not part of this
subsystem's domain model.

## Canonical flow — **Implemented** for the live transport and the batch CLIs

```text
Audio input
  -> live WebSocket (audio/live_speech_ws.py) or batch file (speech_cli.py / lecture_cli.py)
  -> frame/file decoding and validation
  -> live frame VAD + endpointing, or batch VAD metadata
  -> ASR adapter (faster-whisper)
  -> optional alignment
  -> optional diarization
  -> reconciliation (TranscriptReconciler, live; reconcile.py, batch)
  -> canonical transcript schema 1.0
  -> [live + meeting]  durable outbox -> meeting API -> SQLite
  -> grounded notes (speechNotesService) or rolling intelligence (seam only)
```

The canonical transcript is the source of truth. Partial hypotheses are provisional and are never
stored. Generated intelligence is derived and must keep evidence references.

## Module ownership

| Responsibility | Module | Status |
|---|---|---|
| Batch decoding and ingestion | `audio/transcribe.py`, `audio/speech/audio_io.py` | Implemented |
| Batch VAD metadata | `audio/speech/vad.py` | Implemented |
| Batch ASR adapter | `audio/speech/asr.py` (uses `transcribe._transcribe_segments`) | Implemented |
| Alignment contract | `audio/speech/alignment.py` | Implemented (native pass-through) |
| Diarization contract and backends | `audio/speech/diarization.py` | Implemented; pyannote optional, not installed |
| Batch reconciliation | `audio/speech/reconcile.py` | Implemented |
| Batch orchestration | `audio/speech/pipeline.py` | Implemented |
| Live frame VAD | `audio/speech/live/frame_vad.py` | Implemented (adaptive noise-floor energy gate with hysteresis; decides utterance start and end only, whole utterances reach the recognizer) |
| Live session diagnostics | `audio/speech/live/diagnostics.py` | Implemented (numbers-only log line per minute and per session) |
| Live endpointing | `audio/speech/live/endpointing.py` | Implemented |
| Live streaming ASR | `audio/speech/live/streaming_asr.py` | Implemented; times are stream-clock times (see gaps) |
| Live hypothesis events | `audio/speech/live/events.py` | Implemented |
| Live hypothesis reconciliation | `audio/speech/reconciler.py` | Implemented |
| Segment identity | `audio/speech/live/ids.py` | Implemented |
| Live session lifecycle | `audio/speech/live/session.py` | Implemented |
| Durable outbox | `audio/speech/live/outbox.py` | Implemented, file-based |
| Meeting persistence client | `audio/speech/live/persistence.py` | Implemented |
| Live transport | `audio/live_speech_ws.py` | Implemented |
| Meeting domain and lifecycle | `server/meetings/meetingDomain.js` | Implemented |
| Meeting service | `server/services/meetingSessionService.js` | Implemented |
| Meeting persistence (SQLite) | `server/persistence/*` (repositories, migrations) | Implemented |
| Meeting authentication | `server/auth/meetingAuth.js` | Implemented (shared secrets) |
| Meeting API | `server/routes/meetings.js`, `server/http/errorHandler.js` | Implemented |
| Persistence readiness (health, startup log) | `server/meetings/meetingHealth.js`, `audio/speech/live/health.py` | Implemented |
| Outbox operator tool | `audio/outbox_cli.py` (`npm run outbox:status`, `npm run outbox:replay`) | Implemented |
| Meeting operator CLI | `scripts/meeting-admin.js`, `scripts/lib/meetingAdmin.js` (`npm run meeting`) | Implemented |
| Start a meeting from the browser | `POST /api/v1/meetings/launch`, `server/websocket/liveSpeechRelay.js`, `src/interfaces/meeting/` (see [meeting-lifecycle.md](meeting-lifecycle.md)) | Implemented; real-microphone run needs manual validation |
| Grounded notes | `server/services/speechNotesService.js` | Implemented |
| Rolling intelligence | `server/services/rollingIntelligenceService.js` | Seam only; not connected to the live transport |

## Naming note: `reconcile.py` and `reconciler.py`

Two modules, two jobs. Neither is obsolete, and neither imports the other.

| File | Used by | Job |
|---|---|---|
| `audio/speech/reconcile.py` | Batch pipeline (`pipeline.py`) | Merges a finished ASR result with diarization turns into per-speaker canonical segments. Offline, whole file at once |
| `audio/speech/reconciler.py` | Live session (`live/session.py`) | Holds the live hypothesis state: PARTIAL and STABILIZING events replace the current guess, and only a FINAL event is committed as a canonical segment with a stable id. Streaming, one event at a time |

## Persistence path — **Implemented** [`test_live_ws_integration.py`, `meetingE2E.test.js`]

```text
client  --start {meetingId, meetingTicket}-->  live_speech_ws.py
          POST /api/v1/meetings/:id/sessions   (Bearer ticket)  -> speechSessionId, timelineOffsetMs
client  --audio frames-->  LiveSpeechSession  --FINAL-->  drain_committed()
          Outbox.enqueue (fsync)  ->  POST .../transcript/final  (Bearer ticket)
              201 + INSERTED                       -> INSERTED        (stored now)
              200 + ALREADY_EXISTS                 -> ALREADY_EXISTS  (identical segment already stored)
              400 / 404 / 409                      -> REJECTED        (quarantined, never retried)
              401 / 403 / 503 / 5xx / timeout,
              or any 2xx without an explicit status -> FAILED          (kept in the outbox, retried)
          client  <-- FINAL frame with "persisted": INSERTED | ALREADY_EXISTS | REJECTED | FAILED
client  --stop-->  drain, flush the outbox, POST .../sessions/:sid/end {reason, committedSegments}
          <-- stopped {transcript, persistence: {committed, inserted, alreadyExists, rejected, failed, durable},
                       diagnostics: {levels, gate, decodes, lag, confidence counts; numbers and ids only} | null}
operator, or the launching browser with its ticket
         --end-->  POST .../meetings/:id/end   refused with 409 while committed segments are missing
```

A bare HTTP 200 or 201 never counts as saved. A segment is persisted only when the API says so
explicitly, and the API refuses to end a meeting whose stored segments are fewer than the sessions
say they committed (see [meeting-lifecycle.md](meeting-lifecycle.md)).

The transport never holds the admin token. It holds a meeting-scoped ticket, which is issued by an
operator and cannot read or change anything beyond its meeting.

## Contract rules

- `audio/speech/schema.py` is the only canonical transcript shape. `validate_transcript()` runs before
  a transcript crosses into persistence or intelligence processing.
- `TranscriptReconciler` and `LiveSpeechSession` own provisional hypothesis state and stable
  canonical segment ids.
- Only `TranscriptStage.FINAL` creates a canonical segment.
- Persistence is reached through interfaces: `MeetingPersistence` (HTTP) in the sidecar, and
  services over repositories in the API. No SQL is written in the WebSocket handler, the ASR, the
  VAD, or the reconciler.
- Diarization is optional. Unknown and overlap attribution are valid outcomes.

## Configuration — **Implemented**

| Variable | Where | Purpose |
|---|---|---|
| `MEETING_API_TOKEN` | API (`.env.secrets`) | Admin credential (≥ 32 chars). Unset = admin routes return 503 |
| `MEETING_TICKET_SECRET` | API (`.env.secrets`) | Signs meeting tickets (≥ 32 chars). Unset = tickets unavailable |
| `MEETING_TICKET_TTL_S` | API | Ticket lifetime in seconds (default 43200) |
| `SPEECH_DATABASE_PATH` | API | SQLite file (default `./data/speech.sqlite`; compose: `/data/speech.sqlite`) |
| `MEETING_API_URL` | Sidecar | Server origin, e.g. `http://127.0.0.1:3103`. Must not include `/api/v1`. Unset: meeting-bound sessions are refused and `/health` reports `persistence.state: disabled` |
| `MEETING_TICKET` | Outbox tool only | A meeting ticket for `npm run outbox:replay`. Read from the environment, never the command line |
| `LIVE_OUTBOX_DIR` | Sidecar | Durable outbox directory (default `audio/outbox/`, gitignored) |
| `LIVE_RECORDINGS_DIR` | Sidecar | Opt-in WAV recordings. Unset = never written |

The sidecar's systemd unit reads `.env` and `.env.secrets` through `EnvironmentFile`, so setting
`MEETING_API_URL` in `.env` and `LIVE_OUTBOX_DIR` there is enough.

## Resource findings — **measured** on this host (swap-saturated, 7.7 GB RAM)

- `torch`, `torchaudio` and `silero-vad` were installed for the sidecar but were not used. Nothing in
  the project imports them. ctranslate2 imports torch only when it is present (guarded), so removing it
  is safe. Confirmed by running the Python test suite (37 tests at the time) with those modules blocked. Peak RSS at sidecar
  import drops from 248 MB to 73 MB. They were removed from `audio/requirements.txt` and from the venv.
- `onnxruntime` stays: it is a hard dependency of faster-whisper, which runs the bundled Silero VAD on it.
- Torch is still needed only by the optional pyannote diarization extra (`requirements.diarization.txt`).
- Measured 2026-10-08: the `small` int8 Whisper model costs about 450 MB (14 MB resident plus 437 MB swapped
  out on a host whose swap was full). The first request after a long idle has to page it back in.
- Measured production speech performance requires a realistically provisioned machine. Latencies
  observed here (2–3 s per clip, occasional long decodes) reflect host memory pressure as well as the code.

## Current gaps

**Partially implemented:**

- Live segment times are the stream positions of the first and last frame handed to the recognizer, so
  they include up to 0.3 s of lead-in and the 0.7 s of silence that ends a turn: accurate to about a second,
  not to the word. (Until 2026-10-09 they also lost every pause: each utterance started where the previous
  one ended.) Word times are on the same clock.
- The outbox is per sidecar host and file-based. It is not replicated.
- The voice assistant's hold-to-talk and conversation path does not create speech sessions. It uses the
  batch `/api/v1/assistant/stt` endpoint.

**Planned:**

- User authentication. Meetings are created by an operator today.
- Reconnect protocol with explicit idempotency keys. Idempotency currently rests on deterministic ids.
- Bounded queues and backpressure. Persistence calls are synchronous with short timeouts inside the
  WebSocket handler.
- A background outbox replay daemon. Waiting segments are retried when a session for the same meeting
  starts or stops, or by hand with `npm run outbox:replay`.
- Structured metrics and correlation ids across Python and Node.
- A production WSGI server for the sidecar. It runs under Flask's development server today (`npm run dev:audio`).
- Retention, deletion, export, and access-control policy.
- A separate final-intelligence job and validated report schema.
