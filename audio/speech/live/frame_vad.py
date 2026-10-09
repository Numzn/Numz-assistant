"""
Frame-level "is this frame speech?" decision for live ingestion.

Deliberately a running-noise-floor RMS energy gate — the same approach
already tuned and shipping for live VAD on the browser side of this app
(src/config/settings.js's vad* options, src/interfaces/voice/voiceInputLocal.js),
re-implemented here rather than invented fresh.

Why not the Silero model from speech/vad.py: that model (bundled with
faster-whisper) is designed to be run over a whole buffer at once
(get_speech_timestamps) and this pass does not verify its behavior/state
handling across separate incremental calls on small live frames — getting
that subtly wrong would be worse than a simple, well-understood energy
gate. This is the live ingestion seam's default; session.py only needs a
bool per frame, however it's computed, so a verified incremental Silero
(or WebRTC VAD, or a GPU model) is a drop-in replacement later.
"""

from dataclasses import dataclass

import numpy as np


@dataclass
class FrameVadConfig:
    # Only decides where utterances start and end (session.py feeds every frame in between to the
    # recognizer, and Whisper's own speech filter drops noise). It used to be 0.02 (about -34 dBFS), which
    # normal speech into a laptop microphone often never reached, so meetings saved nothing.
    energy_threshold: float = 0.008  # about -42 dBFS
    noise_floor_alpha: float = 0.05  # how fast the noise floor adapts during silence
    speech_ratio: float = 2.2        # speech must exceed the noise floor by this ratio...
    speech_min_delta: float = 0.006  # ...or this absolute delta, whichever is easier to clear


class FrameVad:
    """Stateful per-stream energy gate. One instance per live session."""

    def __init__(self, config: FrameVadConfig = None):
        self.config = config or FrameVadConfig()
        self._noise_floor = self.config.energy_threshold

    def is_speech(self, frame: np.ndarray) -> bool:
        if frame.size == 0:
            return False

        rms = float(np.sqrt(np.mean(np.square(frame))))
        threshold = max(
            self._noise_floor * self.config.speech_ratio,
            self._noise_floor + self.config.speech_min_delta,
            self.config.energy_threshold,
        )
        speech = rms >= threshold
        if not speech:
            self._noise_floor = (
                self._noise_floor * (1 - self.config.noise_floor_alpha) + rms * self.config.noise_floor_alpha
            )
        return speech
