"""
Frame-level "is this frame speech?" decision for live ingestion.

An adaptive noise-floor energy gate with hysteresis. It only decides where an utterance starts and ends
(session.py hands every frame in between to the recognizer, and Whisper's own speech filter drops noise),
so it errs towards opening: a missed quiet utterance is lost for good, a false one costs one decode that
finds nothing.

  - The noise floor follows the room. If the first second is steady (the same test as below) it is taken as
    the room's noise: starting from zero, a room noisier than the minimum would hold the gate open before it
    had learned anything. A first second that varies is speech or bursts, never seeded (seeding from speech
    would teach the gate that speech is noise). From then on the floor moves towards the level of frames the
    gate did not open on.
  - The gate opens when a frame is `open_ratio` times the floor and stays open until frames fall below
    `close_ratio` times the floor (hysteresis), so the soft tail of a word or a quiet syllable between loud
    ones does not close an utterance in the middle of a sentence.
  - A frame `speech_close_ratio` (20 dB) below the speaker's recent level is a pause whatever the floor says,
    and teaches the floor quickly. The floor otherwise learns only from closed frames, so a pause noisier
    than a stale floor (auto-gain raises the noise in pauses; speech leaves a reverb tail) could never end
    an utterance. This is what the old absolute gate did for loud speech.
  - `min_threshold_dbfs` is the quietest level the gate will ever open on, so digital silence and
    microphone hiss do not open it. The default, -56 dBFS, is an experimental starting point (measured on
    one recording, not proven): set LIVE_GATE_MIN_DBFS to change it without a code change.
  - Steady sound that starts above the open threshold (a fan switched on, a hum) would hold the gate open
    forever because the floor only learns from closed frames. Speech never keeps its level that steady
    from one 100 ms frame to the next for seconds (syllables alone vary it by 6 dB or more; steady noise
    varies by about 0.5 dB), so an open run whose level barely varies is declared noise: the floor is
    re-learned from it and the gate closes. The ratio is deliberately tight: declaring real speech steady
    would re-learn the floor from it and chop everything after, the very failure this gate exists to avoid.

Until 2026-10-09 the gate was an absolute floor (about -34 dBFS, then -42 dBFS) that quiet speech never
reached: at -44 dBFS a third of the words were lost, at -48 dBFS most, and below that all of them.

Why not the Silero model from speech/vad.py: that model is designed to be run over a whole buffer at once
(get_speech_timestamps) and this pass does not verify its behavior/state handling across separate
incremental calls on small live frames. session.py only needs a bool per frame, however it is computed, so
a verified incremental Silero (or WebRTC VAD) is a drop-in replacement later.

Frames are expected to be 100 ms long (the browser worklet's frame size); the adaptation rates and the
stationarity window are counted in frames.
"""

import logging
import os
from collections import deque
from dataclasses import dataclass, field

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_MIN_THRESHOLD_DBFS = -56.0
MIN_DBFS_ENV = "LIVE_GATE_MIN_DBFS"


def _min_threshold_from_env() -> float:
    raw = os.environ.get(MIN_DBFS_ENV, "").strip()
    if not raw:
        return DEFAULT_MIN_THRESHOLD_DBFS
    try:
        value = float(raw)
    except ValueError:
        value = None
    if value is None or not (-90.0 <= value <= -20.0):
        logger.warning("%s=%r is not a level between -90 and -20 dBFS; using %.0f", MIN_DBFS_ENV, raw, DEFAULT_MIN_THRESHOLD_DBFS)
        return DEFAULT_MIN_THRESHOLD_DBFS
    return value


@dataclass
class FrameVadConfig:
    min_threshold_dbfs: float = field(default_factory=_min_threshold_from_env)  # quietest level the gate opens on
    open_ratio: float = 2.5          # open when a frame is this many times the noise floor (+8 dB)...
    close_ratio: float = 1.6         # ...and stay open until frames fall below this many times it (+4 dB)
    speech_close_ratio: float = 0.1  # a frame below this share of the recent speech level (-20 dB) is a pause
    level_alpha: float = 0.1         # how fast that speech level follows the frames the gate is open on
    level_decay: float = 0.95        # per closed frame: the speech level fades, so a quieter voice is heard soon
    noise_floor_alpha: float = 0.05  # how fast the floor follows frames the gate did not open on
    pause_floor_alpha: float = 0.2   # ...and frames that are pauses relative to the speech (learns the pause noise)
    seed_frames: int = 10            # a steady first second of this many frames is taken as the room's noise
    stationary_frames: int = 30      # an open run this long (3 s)...
    stationary_ratio: float = 1.5    # ...whose 90th/10th percentile level is within this ratio (3.5 dB) is noise


class FrameVad:
    """Stateful per-stream energy gate. One instance per live session."""

    def __init__(self, config: FrameVadConfig = None):
        self.config = config or FrameVadConfig()
        self._min_open = 10 ** (self.config.min_threshold_dbfs / 20)
        self._min_close = self._min_open * self.config.close_ratio / self.config.open_ratio
        self._floor = 0.0
        self._level = 0.0  # recent level of the frames the gate is open on; fades while it is closed
        self._open = False
        self._seed = []  # levels of the first frames, until the floor is seeded
        self._run = deque(maxlen=self.config.stationary_frames)  # frame levels of the current open run

    @property
    def noise_floor_dbfs(self) -> float:
        return 20 * float(np.log10(max(self._floor, 1e-9)))

    def is_speech(self, frame: np.ndarray) -> bool:
        if frame.size == 0:
            return False

        rms = float(np.sqrt(np.mean(np.square(frame))))
        config = self.config
        self._seed_floor(rms)

        pause = rms < self._level * config.speech_close_ratio
        if pause:
            is_open = False
        elif self._open:
            is_open = rms >= max(self._floor * config.close_ratio, self._min_close)
        else:
            is_open = rms >= max(self._floor * config.open_ratio, self._min_open)

        if is_open:
            # Built up gradually from the previous level, so one loud click cannot make quiet speech after
            # it look like a pause.
            self._level += config.level_alpha * (rms - self._level)
            self._run.append(rms)
            if len(self._run) == self._run.maxlen and self._run_is_steady():
                # A fan, a hum: learn it as the new floor and close.
                self._floor = float(np.median(self._run))
                self._level = 0.0
                self._run.clear()
                self._open = False
                return False
            self._open = True
            return True

        self._run.clear()
        self._open = False
        self._floor += (config.pause_floor_alpha if pause else config.noise_floor_alpha) * (rms - self._floor)
        self._level *= config.level_decay
        return False

    def _seed_floor(self, rms: float):
        if self._seed is None:
            return
        self._seed.append(rms)
        if len(self._seed) >= self.config.seed_frames:
            if self._is_steady(self._seed):
                self._floor = max(self._floor, float(np.median(self._seed)))
            self._seed = None

    def _run_is_steady(self) -> bool:
        return self._is_steady(self._run)

    def _is_steady(self, levels) -> bool:
        low, high = np.percentile(np.fromiter(levels, dtype=float), [10, 90])
        return low > 0 and high / low <= self.config.stationary_ratio
