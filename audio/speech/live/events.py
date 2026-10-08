"""
Live transcript event model: PARTIAL -> STABILIZING -> FINAL.

Partial/stabilizing text is provisional and must never be written into the
canonical transcript (speech/schema.py) directly. Only a FINAL event's
text ever becomes a canonical segment — see session.py's _commit_final().
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np


class TranscriptStage(str, Enum):
    PARTIAL = "partial"          # fresh decode; may still change, including already-seen words
    STABILIZING = "stabilizing"  # this decode's text reconfirmed the previous decode verbatim as a prefix
    FINAL = "final"              # endpointing fired; this is committed, re-decoded at higher quality


@dataclass
class TranscriptEvent:
    stage: TranscriptStage
    text: str
    start: float
    end: float
    words: list = field(default_factory=list)
    speaker: Optional[str] = None


def validate_audio_frame(frame, sample_rate: int, timestamp_s: float):
    """Validate one live PCM frame before it reaches VAD or ASR."""
    if not isinstance(frame, np.ndarray):
        raise TypeError("audio frame must be a numpy array")
    if frame.ndim != 1:
        raise ValueError("audio frame must be mono and one-dimensional")
    if frame.dtype != np.float32:
        raise ValueError("audio frame must use float32 samples")
    if frame.size == 0:
        raise ValueError("audio frame must not be empty")
    if not np.isfinite(frame).all():
        raise ValueError("audio frame contains non-finite samples")
    if not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError("sample_rate must be a positive integer")
    if not isinstance(timestamp_s, (int, float)) or timestamp_s < 0:
        raise ValueError("timestamp_s must be a non-negative number")
    return frame
