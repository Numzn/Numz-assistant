# Local audio sidecar (Phase 1)

Silero VAD + faster-whisper for offline STT. Node proxies `POST /api/v1/assistant/stt` here when `STT_BACKEND=local`.

## Prerequisites

- Python 3.10+
- **ffmpeg** on PATH (`ffmpeg -version`)
- ~1–1.5 GB RAM for `small` int8 model (first run downloads weights)

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

- `GET /health` — service and model info
- `POST /transcribe` — raw audio body (`audio/webm`), headers `X-Stt-Lang`, `X-Stt-Prompt`

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
