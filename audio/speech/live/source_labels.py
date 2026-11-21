"""
"You" or "others", from which audio source was sounding while a line was spoken.

A meeting can be recorded from the microphone and from a shared tab or the system's audio at once. The browser
sums the two into ONE stream for the recognizer (nothing about what Whisper hears changes), but it also reports,
for every 100 ms frame, how loud each source was. That is enough to say, for a finished line:

  tab sounding, microphone quiet     ->  "others"   (the people on the call)
  microphone sounding, tab quiet     ->  "you"      (the person recording)
  both sounding, one far louder      ->  that one, marked uncertain (someone talked over the call)
  both sounding about equally,
  or neither sounding                ->  no label, marked uncertain

It never claims more than that. "Others" can be several different people; this does not tell them apart (that
needs speaker diarization over kept audio). It cannot tell the user from a second person in the same room, and
with loudspeakers instead of headphones the microphone hears the call too, which makes lines uncertain rather
than wrong. A microphone that is levelled by the browser reads high even in a quiet room, so "sounding" is judged
against each source's own floor, learned from the meeting so far, as well as an absolute level.

Every threshold below is an UNMEASURED default: none has been tried on real audio from a real call. They can be
changed from the environment without a release (LIVE_SOURCE_*), and the whole feature can be switched off in the
transport (LIVE_SOURCE_LABELS=0).

It plugs into LiveSpeechSession as the diarizer: see diarization_live.py for the interface.
"""

import logging
import math
import os
from collections import deque
from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

YOU = "you"
OTHERS = "others"

SOUND_DBFS_ENV = "LIVE_SOURCE_SOUND_DBFS"
MIN_SHARE_ENV = "LIVE_SOURCE_MIN_SHARE"
DOMINANCE_DB_ENV = "LIVE_SOURCE_DOMINANCE_DB"

_EPS = 1e-6
_RATIO_TOLERANCE = 1e-9  # 0.3 / 0.1 is 2.9999999999999996: "exactly 3x" must still count as 3x
_AROUND_S = 0.5  # current_speaker(t) looks this far either side of t


def _db_to_amplitude(db: float) -> float:
    return 10 ** (db / 20)


@dataclass(frozen=True)
class SourceLabelConfig:
    sound_rms: float = _db_to_amplitude(-50.0)  # a source is "sounding" in a frame at or above this (about -50 dBFS)
    min_share: float = 0.25  # share of a line's frames a source must sound in to count as present
    dominance_ratio: float = 3.0  # when both are present, one must be this much louder (3x is about 9.5 dB)
    history_s: float = 120.0  # how much level history is kept (a line is at most 30 s, plus decode lag)
    floor_percentile: float = 5.0  # a source's own floor: this percentile of its levels so far
    floor_ratio: float = 3.0  # speech must stand this far above that floor ...
    gate_cap_rms: float = _db_to_amplitude(-35.0)  # ... but never needs to be louder than this
    floor_min_frames: int = 50  # a floor is only learned from at least 5 s of readings

    @classmethod
    def from_env(cls) -> "SourceLabelConfig":
        defaults = cls()

        def read(name, low, high, default, convert=float):
            raw = os.environ.get(name, "").strip()
            if not raw:
                return default
            try:
                value = float(raw)
            except ValueError:
                value = None
            if value is None or not (low <= value <= high):
                logger.warning("%s=%r is not a number between %s and %s; using the default", name, raw, low, high)
                return default
            return convert(value)

        return cls(
            sound_rms=read(SOUND_DBFS_ENV, -90.0, -20.0, defaults.sound_rms, _db_to_amplitude),
            min_share=read(MIN_SHARE_ENV, 0.01, 1.0, defaults.min_share),
            dominance_ratio=read(DOMINANCE_DB_ENV, 1.0, 40.0, defaults.dominance_ratio, _db_to_amplitude),
        )


def _clean(reading) -> Optional[float]:
    """A level (RMS, 0..1) as a float, or None for anything that is not a usable reading."""
    if isinstance(reading, bool) or not isinstance(reading, (int, float)):
        return None
    value = float(reading)
    return value if math.isfinite(value) and value >= 0 else None


class SourceLevelLabeler:
    """Implements the LiveDiarizer interface (and speaker_for_span, which a session prefers: a line has a span)."""

    name = "source-levels"

    def __init__(self, config: Optional[SourceLabelConfig] = None):
        self.config = config or SourceLabelConfig()
        self._frames: deque = deque()  # (end_s, duration_s, mic, tab), oldest first

    def __len__(self) -> int:
        return len(self._frames)

    def __bool__(self) -> bool:
        return True  # an empty history is still a labeller (len() is 0, which would otherwise read as "none")

    def note(self, timestamp_s: float, duration_s: float, mic, tab):
        """The levels of the frame that ENDS at timestamp_s (the stream clock the recognizer's events use)."""
        self._frames.append((float(timestamp_s), float(duration_s), _clean(mic), _clean(tab)))
        horizon = float(timestamp_s) - self.config.history_s
        while self._frames and self._frames[0][0] < horizon:
            self._frames.popleft()

    def _gate(self, column: int) -> float:
        """How loud a frame of this source must be to count as sounding."""
        config = self.config
        readings = [frame[column] for frame in self._frames if frame[column] is not None]
        floor = 0.0
        if len(readings) >= config.floor_min_frames:
            floor = float(np.percentile(readings, config.floor_percentile))
        return min(max(config.sound_rms, floor * config.floor_ratio), max(config.sound_rms, config.gate_cap_rms))

    def speaker_for_span(self, start_s: float, end_s: float) -> Tuple[Optional[str], bool]:
        """-> (label or None, uncertain) for a line that ran from start_s to end_s on the stream clock."""
        frames = [
            frame
            for frame in self._frames
            if frame[0] > start_s + _EPS and (frame[0] - frame[1]) < end_s - _EPS and (frame[2] is not None or frame[3] is not None)
        ]
        if not frames:
            return None, True

        config = self.config
        present = []
        means = []
        for column in (2, 3):
            gate = self._gate(column)
            sounding = [frame[column] for frame in frames if frame[column] is not None and frame[column] >= gate]
            present.append(len(sounding) / len(frames) >= config.min_share)
            means.append(sum(sounding) / len(sounding) if sounding else 0.0)
        mic_present, tab_present = present
        mic_mean, tab_mean = means

        if tab_present and not mic_present:
            return OTHERS, False
        if mic_present and not tab_present:
            return YOU, False
        if not mic_present and not tab_present:
            return None, True
        # Both were sounding in this line.
        if mic_mean >= tab_mean * config.dominance_ratio * (1 - _RATIO_TOLERANCE):
            return YOU, True
        if tab_mean >= mic_mean * config.dominance_ratio * (1 - _RATIO_TOLERANCE):
            return OTHERS, True
        return None, True

    def current_speaker(self, timestamp_s: float) -> Tuple[Optional[str], bool]:
        return self.speaker_for_span(timestamp_s - _AROUND_S, timestamp_s + _AROUND_S)
