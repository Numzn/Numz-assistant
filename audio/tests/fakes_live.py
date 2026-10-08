"""Deterministic stand-ins for the model-dependent parts of the live path (no Whisper weights needed)."""

import numpy as np

from speech.live.events import TranscriptEvent, TranscriptStage

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1600  # 100 ms


class EnergyVad:
    """Frame is speech when its RMS exceeds 0.05. Used in place of the calibrated energy gate."""

    def is_speech(self, frame):
        return float(np.sqrt(np.mean(np.square(frame)))) > 0.05


class ScriptedAsr:
    """Streaming ASR stand-in: every endpointed utterance becomes one FINAL event named '<prefix> <n>'."""

    name = "scripted-asr"

    def __init__(self, prefix="utt"):
        self._prefix = prefix
        self._count = 0
        self._start = None
        self._end = None

    def push_audio(self, frame, timestamp_s):
        if self._start is None:
            self._start = timestamp_s - len(frame) / SAMPLE_RATE
        self._end = timestamp_s
        return None

    def flush(self):
        if self._start is None:
            return None
        self._count += 1
        event = TranscriptEvent(
            stage=TranscriptStage.FINAL,
            text=f"{self._prefix} {self._count}",
            start=self._start,
            end=self._end,
            words=[],
        )
        self._start = None
        self._end = None
        return event


def speech_frames(count):
    return [np.full(FRAME_SAMPLES, 0.2, dtype=np.float32) for _ in range(count)]


def silence_frames(count):
    return [np.zeros(FRAME_SAMPLES, dtype=np.float32) for _ in range(count)]


def feed(session, frames, position):
    """Feeds frames at 100 ms cadence. Returns the new stream position in seconds."""
    for frame in frames:
        position += len(frame) / SAMPLE_RATE
        session.ingest_audio_frame(frame, timestamp_s=position)
    return position


def fake_session_factory(prefix_iter, **defaults):
    """Session factory for live_speech_ws.SESSION_FACTORY: fake ASR and VAD, real endpointing and reconciliation."""
    from speech.live.session import LiveSpeechSession

    def factory(**kwargs):
        return LiveSpeechSession(
            streaming_asr=ScriptedAsr(prefix=next(prefix_iter)),
            frame_vad=EnergyVad(),
            **{**defaults, **kwargs},
        )

    return factory
