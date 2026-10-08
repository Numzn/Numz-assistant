"""
Word-level alignment.

faster-whisper's word_timestamps=True (cross-attention based) already
produces real per-word timestamps — the default backend here just passes
that through, at zero extra dependency/compute cost. The interface stays
open for a real forced-alignment backend (e.g. a wav2vec2/CTC model, the
approach WhisperX uses) if cross-attention timestamps prove too imprecise
for a future feature (tight audio-highlighting/karaoke-style sync).
Swapping backends only touches this file — asr.py and reconcile.py don't
change.
"""

from typing import Protocol

from speech.asr import AsrResult


class AlignmentEngine(Protocol):
    name: str

    def align(self, pcm, sample_rate: int, asr_result: AsrResult) -> AsrResult: ...


class WhisperNativeAlignment:
    """Default: trust faster-whisper's own word timestamps as-is."""

    name = "whisper-native"

    def align(self, pcm, sample_rate: int, asr_result: AsrResult) -> AsrResult:
        return asr_result
