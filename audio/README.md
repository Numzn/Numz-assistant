# Local audio sidecar (Phase 1)

faster-whisper (with its bundled Silero VAD) for speech to text. Node proxies `POST /api/v1/assistant/stt` here when `STT_BACKEND=local`. The same process hosts the live speech WebSocket and its meeting persistence (see below).

## Prerequisites

- Python 3.10+
- **ffmpeg** on PATH (`ffmpeg -version`)
- About 0.5 GB RAM for the `small` int8 model (measured about 450 MB; first run downloads weights). It is paged out first on a host that is short of memory, so the first request after a long idle is slow

## Setup

```bash
cd audio
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
```

## Run

```bash
# From repo root
npm run dev:audio

# Or directly
cd audio && python server.py
```

Default URL: `http://127.0.0.1:8765`

- `GET /health` — service and model info, plus a `persistence` block: `disabled`, `misconfigured`, `degraded` or `ok` (no secrets)
- `POST /transcribe` — raw audio body (`audio/webm`), headers `X-Stt-Lang`, `X-Stt-Prompt`
- `WS /live-speech` — live transcription; optionally persisted to a meeting (see below)

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIO_HOST` | `127.0.0.1` | Bind host |
| `AUDIO_PORT` | `8765` | Bind port |
| `AUDIO_WARMUP` | `1` | Pre-load models at startup (`0` to skip) |
| `VAD_MIN_SPEECH_MS` | `250` | Silero min speech segment |
| `VAD_MIN_SILENCE_MS` | `300` | Silero min silence gap |
| `VAD_SPEECH_PAD_MS` | `80` | Padding around speech |
| `WHISPER_MODEL` | `small` | faster-whisper model name |
| `WHISPER_COMPUTE_TYPE` | `int8` | CPU quantization |
| `MEETING_API_URL` | unset | Server origin of the meeting API, e.g. `http://127.0.0.1:3103` (no `/api/v1`). Unset: meeting-bound live sessions are refused |
| `LIVE_OUTBOX_DIR` | `audio/outbox` | Durable outbox for segments not yet stored (gitignored) |
| `LIVE_RECORDINGS_DIR` | unset | Opt-in WAV recordings. Unset: audio is never written to disk |

## Meeting persistence

A client that starts a live session with a `meetingId` and a `meetingTicket` has every final segment
written to the durable outbox and then to the meeting API. Each segment is reported as `INSERTED`,
`ALREADY_EXISTS`, `REJECTED` or `FAILED`; only the first two mean it is saved. Check the state with
`GET /health` (`persistence.state`). If segments are waiting:

```bash
npm run outbox:status
MEETING_TICKET=<ticket> npm run outbox:replay -- <meeting-id>
```

See [`docs/meeting-lifecycle.md`](../docs/meeting-lifecycle.md) and [`docs/speech-architecture.md`](../docs/speech-architecture.md).

## Tests

```bash
npm test                                                        # Node: domain, persistence, auth, API, end to end
cd audio && .venv/bin/python -m unittest discover -s tests -t .  # Python: speech core, live transport, outbox, health
```

Real speech through the real Whisper model (quiet levels, noise, timestamps) is opt-in because it loads the model:
`cd audio && NUMZ_REAL_ASR=1 .venv/bin/python -m unittest tests.test_real_audio_gate -v` (see `docs/speech-pipeline.md`).
`LIVE_GATE_MIN_DBFS` (default -56) sets the quietest level the live gate opens on.

The Python integration tests start the real Node server and a real SQLite file, so they need Node on `PATH`. On a
memory-starved host the server can take a minute to start; the tests wait up to 3 minutes.

## Dev stack

```bash
npm run dev:audio   # Python :8765
npm run dev:api     # Express :3001
npm run dev         # Vite :5173
```

Set in project `.env`:

```
STT_BACKEND=local
AUDIO_SERVICE_URL=http://127.0.0.1:8765
```

Browser: set `VITE_PICOVOICE_ACCESS_KEY` in `.env` for Porcupine wake (see root `.env.example`).

Debug overlay: open the app with `?debug=1` to show state, phase, sidecar health, and timing measures.

Manual QA: see [`docs/audio-stabilization-run-sheet.md`](../docs/audio-stabilization-run-sheet.md).
