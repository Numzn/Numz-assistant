"""
VAD (Voice Activity Detection) as an explicit step — not just `vad_filter=True`.

Backed by the Silero VAD model bundled with faster-whisper (the exact model
faster-whisper already uses internally), so no new dependency is required.
Promoted to its own module because:

  - Parameters are deliberately tuned for continuous lecture/meeting speech
    (longer min_silence_duration_ms) instead of faster-whisper's own
    internal default for vad_filter=True, which is min_silence_duration_ms=160 —
    aggressive enough to split on almost every breath. That default is the
    "vad_filter=true is not enough" problem this module exists to fix.
  - Speech-region boundaries are useful standalone: for diarization
    windowing, and for flagging long pauses in the canonical transcript.

Important: actual ASR decoding (asr.py) still delegates chunking to
faster-whisper's own vad_filter=True with these tuned options, rather than
manually slicing PCM by the regions detected here. faster-whisper caps any
single manually-supplied clip_timestamps region at 30s and silently
transcribes only the first 30s of anything longer — so manually merging
long speech regions and feeding them back in as decode boundaries would
risk silent data loss on a long uninterrupted lecture passage. The
library's own internal chunker already splits long speech safely (it
respects max_speech_duration_s). This module's standalone detection is for
metadata/structure, not for driving decoding.
"""

from dataclasses import dataclass
from typing import Optional

from faster_whisper.vad import VadOptions, get_speech_timestamps


@dataclass
class LectureVadOptions:
    """VAD tuning for continuous, long-form speech, as opposed to the
    short hold-to-talk utterances tuned in transcribe.py's
    WHISPER_VAD_PARAMETERS (used by the live conversational path)."""

    threshold: float = 0.3
    min_speech_duration_ms: int = 150
    min_silence_duration_ms: int = 500
    speech_pad_ms: int = 200
    # Tied to Whisper's fixed 30s attention window, not a free tunable —
    # raising this doesn't let the model "see" more audio per chunk.
    max_speech_duration_s: float = 30.0
    # Speech regions separated by a gap shorter than this are merged into
    # one logical group for endpointing metadata (not for ASR chunking).
    merge_gap_ms: int = 500

    def to_vad_options(self) -> VadOptions:
        return VadOptions(
            threshold=self.threshold,
            min_speech_duration_ms=self.min_speech_duration_ms,
            min_silence_duration_ms=self.min_silence_duration_ms,
            speech_pad_ms=self.speech_pad_ms,
            max_speech_duration_s=self.max_speech_duration_s,
        )


def detect_speech_regions(pcm, sample_rate: int, options: Optional[LectureVadOptions] = None) -> list[dict]:
    """Standalone Silero VAD pass over the whole file: merged speech
    regions in seconds. Used for endpointing metadata / diarization
    windowing (see module docstring for why this isn't fed into ASR
    decoding directly)."""
    options = options or LectureVadOptions()
    if pcm.size == 0:
        return []

    raw = get_speech_timestamps(pcm, options.to_vad_options(), sampling_rate=sample_rate)
    # get_speech_timestamps returns sample indices, not seconds.
    regions = [{"start": r["start"] / sample_rate, "end": r["end"] / sample_rate} for r in raw]
    return merge_close_regions(regions, options.merge_gap_ms / 1000)


def merge_close_regions(regions: list[dict], merge_gap_s: float) -> list[dict]:
    """Merge speech regions separated by a short pause into one logical
    group; keep long pauses as real breaks. This is the "sensible
    segmentation/endpointing" behavior: not every pause becomes a
    boundary, but a genuinely long pause stays one."""
    if not regions:
        return []

    merged = [dict(regions[0])]
    for region in regions[1:]:
        gap = region["start"] - merged[-1]["end"]
        if gap <= merge_gap_s:
            merged[-1]["end"] = region["end"]
        else:
            merged.append(dict(region))
    return merged
