"""
Live Speech Intelligence transport: a WebSocket bridge between a real
audio source (browser mic, or any client) and LiveSpeechSession.

Lives on the audio sidecar (audio/server.py), not the Node API — the
session/ASR machinery is Python, and this reuses that already-warm
process rather than adding a new Node<->Python streaming bridge. Reuses
flask-sock (a thin, single-purpose WebSocket extension for Flask — see
audio/requirements.txt) rather than a parallel asyncio server, so it
coexists with the existing synchronous Flask app with minimal new surface.

One handler invocation per WebSocket connection (flask-sock: one thread
per connection) — all session state lives in local variables, cleaned up
via try/finally exactly once regardless of how the connection ends
(explicit 'stop', client disconnect, idle timeout, or an unhandled
error). A failed connection can only fail to add a NEW segment; it can
never corrupt segments already committed to the session, since those are
only handed back to the caller at the very end (via finalize()).

Audio format contract — strict, not "accept anything and hope" (see
docs/speech-pipeline.md):
  - 16000 Hz, mono, 32-bit float PCM, little-endian, raw (no container)
  - declared explicitly in the 'start' control message; anything else is
    rejected with a clear 'unsupported-format' error, not silently coerced
  - binary frames may be any length that's a multiple of 4 bytes (one
    float32 sample) — chunking cadence is the client's choice, matching
    LiveSpeechSession.ingest_audio_frame(), which has no fixed frame size

Wire protocol (JSON text control messages + binary audio frames):

  Client -> server:
    {"type": "start", "sampleRate": 16000, "channels": 1, "format": "f32le",
     "language": "en", "saveRecording": false, "reprocessOnStop": false}
    <binary frame>  (repeated)
    {"type": "pause"} / {"type": "resume"}
    {"type": "stop"}

  Server -> client:
    {"type": "ready", "sessionId": "..."}
    {"type": "transcript", "state": "PARTIAL" | "STABILIZING", "text": "..."}
    {"type": "transcript", "state": "FINAL", "segment": {"start", "end", "speaker", "text"}}
    {"type": "paused"} / {"type": "resumed"}
    {"type": "error", "code": "...", "message": "..."}
    {"type": "stopped", "transcript": {...canonical transcript...}}
"""

import json
import logging
import os
import urllib.error
import urllib.request

import numpy as np
from flask_sock import Sock
from simple_websocket import ConnectionClosed

from speech.audio_io import write_wav
from speech.live.events import TranscriptStage
from speech.live.session import LiveSpeechSession

logger = logging.getLogger(__name__)

SUPPORTED_SAMPLE_RATE = 16000
SUPPORTED_CHANNELS = 1
SUPPORTED_FORMAT = "f32le"
BYTES_PER_SAMPLE = 4
IDLE_TIMEOUT_S = 30

# Empty by default: retained audio only ever lives in memory for the life of
# the connection unless a session explicitly asks to save it (saveRecording)
# AND an operator has opted in by setting this — no recording is ever
# written to disk without both. Point it at the existing gitignored
# lectures/ scratch convention (see .gitignore) rather than a new location.
RECORDINGS_DIR = os.environ.get("LIVE_RECORDINGS_DIR", "")
MEETING_API_URL = os.environ.get("MEETING_API_URL", "").rstrip("/")


def _send(ws, payload: dict):
    try:
        ws.send(json.dumps(payload))
    except Exception:
        pass  # connection already gone — nothing to do


def _error(ws, code: str, message: str):
    logger.warning("live-speech: %s: %s", code, message)
    _send(ws, {"type": "error", "code": code, "message": message})


def _segment_payload(seg: dict) -> dict:
    return {"start": seg["start"], "end": seg["end"], "speaker": seg.get("speaker"), "text": seg["text"]}


def _persist_final_segment(meeting_id: str, segment: dict):
    """Persist one canonical final segment through the Node repository API."""
    if not MEETING_API_URL or not meeting_id:
        return
    payload = json.dumps({"segment": segment}).encode("utf-8")
    request = urllib.request.Request(
        f"{MEETING_API_URL}/api/v1/meetings/{meeting_id}/transcript/final",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"meeting transcript persistence failed: HTTP {response.status}")


def _persist_speech_session(meeting_id: str):
    payload = b"{}"
    request = urllib.request.Request(
        f"{MEETING_API_URL}/api/v1/meetings/{meeting_id}/sessions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        if response.status != 201:
            raise RuntimeError(f"speech session persistence failed: HTTP {response.status}")


def register_live_speech_route(app, path: str = "/live-speech"):
    sock = Sock(app)

    @sock.route(path)
    def live_speech(ws):
        session = None
        meeting_id = ""
        stream_position_s = 0.0
        paused = False
        save_recording = False

        def on_event(event):
            # FINAL is sent explicitly after commit (below), with the real
            # committed segment (speaker, canonical id, etc.) — not here,
            # since commit happens after this callback fires.
            if event.stage == TranscriptStage.FINAL:
                return
            _send(ws, {"type": "transcript", "state": event.stage.value.upper(), "text": event.text})

        def finalize_and_notify():
            nonlocal session
            if session is None:
                return
            try:
                segments_before = len(session.finalized_segments)
                transcript = session.finalize()
                for seg in session.finalized_segments[segments_before:]:
                    try:
                        _persist_final_segment(meeting_id, seg)
                    except (OSError, urllib.error.URLError, RuntimeError):
                        logger.exception("live-speech: final segment persistence failed")
                        _error(ws, "persistence-failure", "Failed to persist final transcript segment")
                    _send(ws, {"type": "transcript", "state": "FINAL", "segment": _segment_payload(seg)})

                if save_recording:
                    pcm = session.get_raw_audio_pcm()
                    if pcm is not None and RECORDINGS_DIR:
                        os.makedirs(RECORDINGS_DIR, exist_ok=True)
                        wav_path = os.path.join(RECORDINGS_DIR, f"{session.session_id}.wav")
                        write_wav(wav_path, pcm, SUPPORTED_SAMPLE_RATE)
                        transcript.setdefault("meta", {})["recordingPath"] = wav_path

                _send(ws, {"type": "stopped", "transcript": transcript})
            except Exception:
                logger.exception("live-speech: finalize failed")
                _error(ws, "finalize-failure", "Failed to finalize the session")
            finally:
                session = None  # guards against double-finalize (explicit stop, then disconnect)

        try:
            while True:
                try:
                    message = ws.receive(timeout=IDLE_TIMEOUT_S)
                except ConnectionClosed:
                    break
                if message is None:
                    logger.info("live-speech: idle timeout, closing connection")
                    break

                if isinstance(message, (bytes, bytearray)):
                    if session is None:
                        _error(ws, "no-active-session", "Send a 'start' message before audio frames")
                        continue
                    if paused:
                        continue
                    if len(message) == 0 or len(message) % BYTES_PER_SAMPLE != 0:
                        _error(
                            ws,
                            "malformed-audio",
                            f"Frame length {len(message)} bytes is not a multiple of "
                            f"{BYTES_PER_SAMPLE} (expected {SUPPORTED_FORMAT})",
                        )
                        continue

                    frame = np.frombuffer(message, dtype="<f4")
                    stream_position_s += len(frame) / SUPPORTED_SAMPLE_RATE
                    try:
                        segments_before = len(session.finalized_segments)
                        session.ingest_audio_frame(frame, timestamp_s=stream_position_s)
                        for seg in session.finalized_segments[segments_before:]:
                            try:
                                _persist_final_segment(meeting_id, seg)
                            except (OSError, urllib.error.URLError, RuntimeError):
                                logger.exception("live-speech: final segment persistence failed")
                                _error(ws, "persistence-failure", "Failed to persist final transcript segment")
                            _send(ws, {"type": "transcript", "state": "FINAL", "segment": _segment_payload(seg)})
                    except Exception as err:
                        # One bad decode must not corrupt or drop already-committed
                        # segments, and must not kill the connection — log, tell the
                        # client, keep listening.
                        logger.exception("live-speech: ASR/session failure")
                        _error(ws, "asr-failure", str(err))
                    continue

                # Text control message (JSON)
                try:
                    control = json.loads(message)
                except (TypeError, ValueError):
                    _error(ws, "malformed-control", "Control messages must be valid JSON")
                    continue

                msg_type = control.get("type") if isinstance(control, dict) else None

                if msg_type == "start":
                    if session is not None:
                        _error(ws, "already-started", "Session already started")
                        continue

                    fmt = (control.get("sampleRate"), control.get("channels"), control.get("format"))
                    if fmt != (SUPPORTED_SAMPLE_RATE, SUPPORTED_CHANNELS, SUPPORTED_FORMAT):
                        _error(
                            ws,
                            "unsupported-format",
                            f"This endpoint only accepts sampleRate={SUPPORTED_SAMPLE_RATE}, "
                            f"channels={SUPPORTED_CHANNELS}, format={SUPPORTED_FORMAT!r} "
                            f"(got sampleRate={fmt[0]!r}, channels={fmt[1]!r}, format={fmt[2]!r})",
                        )
                        continue

                    save_recording = bool(control.get("saveRecording")) and bool(RECORDINGS_DIR)
                    keep_audio = save_recording or bool(control.get("reprocessOnStop"))
                    session = LiveSpeechSession(
                        sample_rate=SUPPORTED_SAMPLE_RATE,
                        language=str(control.get("language") or ""),
                        keep_audio_for_reprocessing=keep_audio,
                    )
                    meeting_id = str(control.get("meetingId") or "")
                    if meeting_id and MEETING_API_URL:
                        try:
                            _persist_speech_session(meeting_id)
                        except (OSError, urllib.error.URLError, RuntimeError):
                            logger.exception("live-speech: speech session persistence failed")
                            _error(ws, "persistence-failure", "Failed to attach speech session to meeting")
                            session = None
                            meeting_id = ""
                            continue
                    session.on_transcript_event(on_event)
                    stream_position_s = 0.0
                    _send(ws, {"type": "ready", "sessionId": session.session_id})
                    continue

                if session is None:
                    _error(ws, "no-active-session", f"Send 'start' before '{msg_type}'")
                    continue

                if msg_type == "pause":
                    paused = True
                    _send(ws, {"type": "paused"})
                elif msg_type == "resume":
                    paused = False
                    _send(ws, {"type": "resumed"})
                elif msg_type == "stop":
                    finalize_and_notify()
                    break
                else:
                    _error(ws, "unknown-message", f"Unknown control message type: {msg_type!r}")

        except Exception:
            logger.exception("live-speech: connection handler crashed")
        finally:
            finalize_and_notify()  # no-op if 'stop' already handled it (session is None by then)
            try:
                ws.close()
            except Exception:
                pass

    return sock
