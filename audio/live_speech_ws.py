"""
Live Speech Intelligence transport: a WebSocket bridge between a real audio source
(browser mic, or any client) and LiveSpeechSession, with optional meeting persistence.

Lives on the audio sidecar (audio/server.py). Reuses flask-sock: one handler per
connection, all connection state held in LiveConnection.

Audio format contract (strict, see docs/speech-architecture.md):
  - 16000 Hz, mono, 32-bit float PCM, little-endian, raw frames
  - declared in the 'start' control message; anything else is rejected

Wire protocol:

  Client -> server:
    {"type": "start", "sampleRate": 16000, "channels": 1, "format": "f32le", "language": "en",
     "meetingId": "<uuid>", "meetingTicket": "<token>",      (both optional, together)
     "saveRecording": false, "reprocessOnStop": false}
    <binary frame> (repeated)
    {"type": "pause"} / {"type": "resume"} / {"type": "stop"}

  Server -> client:
    {"type": "ready", "sessionId", "meetingId", "persistence": "meeting" | "standalone", "timelineOffsetMs",
                      "recording": true | false}   (true only when this session's audio is being saved)
    {"type": "transcript", "state": "PARTIAL" | "STABILIZING", "text": "..."}
    {"type": "transcript", "state": "FINAL", "segment": {id, start, end, speaker, text},
                           "persisted": "INSERTED" | "ALREADY_EXISTS" | "REJECTED" | "FAILED" | "NOT_PERSISTED"}
    {"type": "error", "code", "message", ["segmentId"]}
    {"type": "stopped", "transcript": {...} | null, "error": null | "transcript-invalid",
                        "persistence": {"meetingBound", "durable", "committed", "inserted", "alreadyExists",
                                        "rejected", "failed"},
                        "diagnostics": {...} | null}   (numbers and ids only: see speech/live/diagnostics.py)

Persistence rules (see docs/meeting-lifecycle.md):
  - Every committed final segment is written to the durable outbox before delivery.
  - A segment is reported INSERTED or ALREADY_EXISTS only when the meeting API explicitly said so.
  - FAILED segments stay in the outbox and are retried; REJECTED segments are quarantined. Neither is dropped.
  - Committed segments are persisted before any finalization step can fail.
  - When the session ends, the number of committed segments is reported to the meeting API, which refuses
    to complete a meeting whose stored segments are fewer than the committed ones.
"""

import json
import logging
import os
import uuid

import numpy as np
from flask_sock import Sock
from simple_websocket import ConnectionClosed

from speech.audio_io import WavWriter
from speech.live.events import TranscriptStage
from speech.live.health import PersistenceMonitor
from speech.live.ids import require_uuid
from speech.live.outbox import Outbox
from speech.live.persistence import (
    ALREADY_EXISTS,
    FAILED,
    INSERTED,
    OUTCOMES,
    REJECTED,
    MeetingPersistence,
    PersistenceRejected,
    PersistenceUnavailable,
)
from speech.live.session import LiveSpeechSession

logger = logging.getLogger(__name__)

SUPPORTED_SAMPLE_RATE = 16000
SUPPORTED_CHANNELS = 1
SUPPORTED_FORMAT = "f32le"
BYTES_PER_SAMPLE = 4
IDLE_TIMEOUT_S = 30

# Empty by default. Audio is written to disk only when an operator sets this directory AND the client asks
# to save (two opt-ins). It is streamed to the file as it arrives, never held in memory.
RECORDINGS_DIR = os.environ.get("LIVE_RECORDINGS_DIR", "")
MEETING_API_URL = os.environ.get("MEETING_API_URL", "").rstrip("/")
OUTBOX_DIR = os.environ.get("LIVE_OUTBOX_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "outbox"))

# Test seam: a callable(**kwargs) -> session. Production leaves this unset.
SESSION_FACTORY = None


def _make_session(**kwargs):
    if SESSION_FACTORY is not None:
        return SESSION_FACTORY(**kwargs)
    return LiveSpeechSession(**kwargs)


def _send(ws, payload: dict):
    try:
        ws.send(json.dumps(payload))
    except Exception:
        pass  # the connection is already gone; durable state is in the outbox


def _segment_payload(seg: dict) -> dict:
    return {
        "id": seg["id"],
        "start": seg["start"],
        "end": seg["end"],
        "speaker": seg.get("speaker"),
        "text": seg["text"],
    }


class LiveConnection:
    def __init__(self, ws, outbox: Outbox):
        self.ws = ws
        self.outbox = outbox
        self.session = None
        self.persistence = None
        self.meeting_id = ""
        self.speech_session_id = ""
        self.stream_position_s = 0.0
        self.paused = False
        self.save_recording = False
        self.recorder = None  # a WavWriter while this session's audio is being saved
        self.recording_path = None
        self.committed = 0  # final segments this connection produced, whatever happened to them next
        self.counts = {state: 0 for state in OUTCOMES}
        self.unkeyed_rejections = []  # refused before the outbox could key them (no id to retry or quarantine)
        self.memory_only = []  # outbox writes that failed; held in memory until the process ends
        self.finished = False

    # ---- wire helpers -------------------------------------------------------------

    def send(self, payload: dict):
        _send(self.ws, payload)

    def error(self, code: str, message: str, **extra):
        logger.warning("live-speech: %s: %s", code, message)
        self.send({"type": "error", "code": code, "message": message, **extra})

    # ---- control --------------------------------------------------------------------

    def handle_control(self, control: dict):
        """Returns 'stop' when the connection should end."""
        msg_type = control.get("type")
        if msg_type == "start":
            self.start(control)
            return None
        if self.session is None:
            self.error("no-active-session", f"Send 'start' before '{msg_type}'")
            return None
        if msg_type == "pause":
            self.paused = True
            self.send({"type": "paused"})
        elif msg_type == "resume":
            self.paused = False
            self.send({"type": "resumed"})
        elif msg_type == "stop":
            self.finish("stopped")
            return "stop"
        else:
            self.error("unknown-message", f"Unknown control message type: {msg_type!r}")
        return None

    def start(self, control: dict):
        if self.session is not None:
            self.error("already-started", "Session already started")
            return

        fmt = (control.get("sampleRate"), control.get("channels"), control.get("format"))
        if fmt != (SUPPORTED_SAMPLE_RATE, SUPPORTED_CHANNELS, SUPPORTED_FORMAT):
            self.error(
                "unsupported-format",
                f"This endpoint only accepts sampleRate={SUPPORTED_SAMPLE_RATE}, channels={SUPPORTED_CHANNELS}, "
                f"format={SUPPORTED_FORMAT!r} (got sampleRate={fmt[0]!r}, channels={fmt[1]!r}, format={fmt[2]!r})",
            )
            return

        meeting_id = str(control.get("meetingId") or "")
        ticket = str(control.get("meetingTicket") or "")
        self.save_recording = bool(control.get("saveRecording")) and bool(RECORDINGS_DIR)
        opened = None

        if meeting_id:
            if not MEETING_API_URL:
                self.error("persistence-unconfigured", "This server is not connected to the meeting API (MEETING_API_URL is unset)")
                return
            if not ticket:
                self.error("persistence-unauthorized", "A meetingTicket is required to persist to a meeting")
                return
            try:
                require_uuid(meeting_id, "meetingId")
            except ValueError:
                self.error("invalid-meeting-id", "meetingId must be a UUID")
                return
            persistence = MeetingPersistence(MEETING_API_URL, meeting_id, ticket, self.outbox)
            try:
                opened = persistence.open_session()
            except PersistenceRejected as err:
                self.error("persistence-rejected", f"The meeting API rejected the session: {err.code} (MEETING_API_URL must be the server origin, e.g. http://127.0.0.1:3103)")
                return
            except PersistenceUnavailable as err:
                self.error("persistence-unavailable", f"Cannot attach to the meeting now: {err}")
                return
            self.persistence = persistence
            self.meeting_id = meeting_id
            self.speech_session_id = opened["speechSessionId"]
            # Leftovers from an earlier session of this meeting go first, in order. A failure here must
            # not stop the new session: the leftovers stay pending in the outbox and are retried later.
            try:
                self.persistence.flush()
            except Exception:
                logger.exception("live-speech: could not retry pending segments at session start")
        else:
            self.speech_session_id = str(uuid.uuid4())

        # With a meeting, the server owns the transcript: reprocessing would make a second, different one.
        # (A saved recording is streamed to disk; it does not need the in-memory copy.)
        keep_audio = bool(control.get("reprocessOnStop")) and not meeting_id
        self.session = _make_session(
            speech_session_id=self.speech_session_id,
            language=str(control.get("language") or ""),
            keep_audio_for_reprocessing=keep_audio,
            meeting_id=self.meeting_id or None,
        )
        self.session.on_transcript_event(self._on_event)
        self.stream_position_s = 0.0
        self._open_recorder()
        self.send(
            {
                "type": "ready",
                "sessionId": self.speech_session_id,
                "meetingId": self.meeting_id or None,
                "persistence": "meeting" if self.meeting_id else "standalone",
                "timelineOffsetMs": opened.get("timelineOffsetMs") if opened else None,
                "recording": self.recorder is not None,
            }
        )

    # ---- optional audio capture ----------------------------------------------------
    # A diagnostic aid, so it must never disturb the meeting: a problem here is logged and shown in the
    # `recording` flag of `ready`, and is NOT sent as an `error` frame (the browser treats those as fatal).

    def _open_recorder(self):
        if not self.save_recording:
            return
        try:
            os.makedirs(RECORDINGS_DIR, mode=0o700, exist_ok=True)
            path = os.path.join(RECORDINGS_DIR, f"{self.speech_session_id}.wav")
            self.recorder = WavWriter(path, SUPPORTED_SAMPLE_RATE)
            self.recording_path = path
        except OSError:
            logger.exception("live-speech: cannot save this session's audio; the session continues without it")
            self.save_recording = False

    def _record(self, frame: np.ndarray):
        if self.recorder is None:
            return
        try:
            self.recorder.write(frame)
        except (OSError, ValueError):
            logger.exception("live-speech: saving the audio failed; the session continues without a recording")
            self._close_recorder()

    def _close_recorder(self):
        recorder, self.recorder = self.recorder, None
        if recorder is not None:
            try:
                recorder.close()
            except OSError:
                logger.exception("live-speech: closing the recording failed")

    def send_final(self, seg: dict, persisted: str):
        """A committed segment, with the explicit persistence state at the top level of the frame."""
        self.send({"type": "transcript", "state": "FINAL", "segment": _segment_payload(seg), "persisted": persisted})

    def _on_event(self, event):
        # FINAL is announced after it is committed and persisted, in persist_committed().
        if event.stage == TranscriptStage.FINAL:
            return
        self.send({"type": "transcript", "state": event.stage.value.upper(), "text": event.text})

    # ---- audio ----------------------------------------------------------------------

    def ingest(self, message: bytes):
        if self.session is None:
            self.error("no-active-session", "Send a 'start' message before audio frames")
            return
        if self.paused:
            return
        if len(message) == 0 or len(message) % BYTES_PER_SAMPLE != 0:
            self.error(
                "malformed-audio",
                f"Frame length {len(message)} bytes is not a multiple of {BYTES_PER_SAMPLE} (expected {SUPPORTED_FORMAT})",
            )
            return

        frame = np.frombuffer(message, dtype="<f4")
        self.stream_position_s += len(frame) / SUPPORTED_SAMPLE_RATE
        self._record(frame)  # exactly what the recognizer is given, so a replay reproduces the session
        try:
            self.session.ingest_audio_frame(frame, timestamp_s=self.stream_position_s)
        except Exception as err:
            # One bad decode must not drop committed segments or end the connection.
            logger.exception("live-speech: ASR/session failure")
            self.error("asr-failure", str(err))
        finally:
            # Runs even when ingest raised: a segment committed before the failure is still persisted.
            self.persist_committed()

    # ---- persistence ----------------------------------------------------------------

    def persist_committed(self):
        if self.session is None:
            return
        for seg in self.session.drain_committed():
            self._persist_one(seg)

    def _persist_one(self, seg: dict):
        self.committed += 1
        if self.persistence is None:
            self.send_final(seg, "NOT_PERSISTED")
            return

        try:
            outcome = self.persistence.persist(self.speech_session_id, seg)
        except OSError as err:
            # The outbox itself is unavailable (disk). Keep the segment in memory and say so.
            logger.exception("live-speech: outbox write failed")
            self.memory_only.append(seg)
            self.counts[FAILED] += 1
            self.error("outbox-unavailable", f"Could not write segment {seg['id']} to the outbox; held in memory only", segmentId=seg["id"])
            self.send_final(seg, FAILED)
            return

        if outcome.segment_id is None:
            self.unkeyed_rejections.append(seg)
        self.counts[outcome.state] += 1
        self.send_final(seg, outcome.state)
        if outcome.state == REJECTED:
            self.error("segment-rejected", f"The meeting API rejected segment {seg['id']}: {outcome.code}", segmentId=seg["id"])
        elif outcome.state == FAILED:
            self.error(
                "persistence-failure",
                f"Segment {seg['id']} is not saved yet ({outcome.code}); it is queued and will be retried",
                segmentId=seg["id"],
            )

    def _session_diagnostics(self):
        """The session's numbers for the stopped frame, or None. Never raises: a failure here must not cost
        the client its 'stopped' (and with it the persistence summary)."""
        summarize = getattr(self.session, "diagnostics_summary", None)
        if not callable(summarize):
            return None
        try:
            # Round-tripped through JSON so that nothing unserialisable can make the whole frame fail to send.
            return json.loads(json.dumps(summarize()))
        except Exception:
            logger.exception("live-speech: could not build the session diagnostics")
            return None

    def _summary(self) -> dict:
        """What happened to this connection's segments. `failed` is the retry backlog for the meeting:
        segments not stored yet (including earlier sessions' leftovers and any held only in memory)."""
        backlog = (len(self.outbox.pending(self.meeting_id)) if self.meeting_id else 0) + len(self.memory_only)
        return {
            "meetingBound": bool(self.meeting_id),
            "durable": self.outbox.durable,
            "committed": self.committed,
            "inserted": self.counts[INSERTED],
            "alreadyExists": self.counts[ALREADY_EXISTS],
            "rejected": self.counts[REJECTED],
            "failed": backlog,
        }

    # ---- finalization ---------------------------------------------------------------

    def finish(self, reason: str):
        """Ends the session once: flush audio, persist what was committed, retry, then report."""
        if self.session is None or self.finished:
            return
        self.finished = True

        try:
            self.session.end()
        except Exception as err:
            logger.exception("live-speech: flushing the final utterance failed")
            self.error("finalize-failure", f"The last utterance could not be flushed: {err}")
        finally:
            self.persist_committed()
            self._close_recorder()

        if self.persistence is not None:
            try:
                self.persistence.flush()
            except Exception:
                logger.exception("live-speech: retrying pending segments failed")
            ended = self.persistence.end_session(self.speech_session_id, reason, committed_segments=self.committed)
            if not ended.get("ok"):
                logger.warning("live-speech: could not end speech session %s (%s)", self.speech_session_id, ended.get("code"))

        transcript = None
        transcript_error = None
        try:
            transcript = self.session.transcript(reprocess=False)
            if self.recording_path and os.path.exists(self.recording_path):
                transcript.setdefault("meta", {})["recordingPath"] = self.recording_path
        except Exception:
            # The segments were already persisted one by one; only the summary document failed.
            logger.exception("live-speech: building the session transcript failed")
            transcript_error = "transcript-invalid"
            self.error("transcript-invalid", "The session transcript failed validation; its segments were saved individually")

        self.send(
            {
                "type": "stopped",
                "transcript": transcript,
                "persistence": self._summary(),
                "error": transcript_error,
                "diagnostics": self._session_diagnostics(),
            }
        )
        self.session = None


def register_live_speech_route(app, path: str = "/live-speech", outbox: Outbox = None):
    sock = Sock(app)
    shared_outbox = outbox if outbox is not None else Outbox(OUTBOX_DIR)
    # /health and the startup log read this, so a misconfigured persistence setup is visible, not silent.
    app.extensions["live_speech_persistence"] = PersistenceMonitor(lambda: MEETING_API_URL, shared_outbox)

    @sock.route(path)
    def live_speech(ws):
        connection = LiveConnection(ws, shared_outbox)
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
                    connection.ingest(bytes(message))
                    continue

                try:
                    control = json.loads(message)
                except (TypeError, ValueError):
                    connection.error("malformed-control", "Control messages must be valid JSON")
                    continue
                if not isinstance(control, dict):
                    connection.error("malformed-control", "Control messages must be JSON objects")
                    continue
                if connection.handle_control(control) == "stop":
                    break
        except Exception:
            logger.exception("live-speech: connection handler crashed")
        finally:
            connection.finish("disconnected")
            try:
                ws.close()
            except Exception:
                pass

    return sock
