"""
Streaming/near-real-time ASR integration point.

faster-whisper has no token-by-token incremental decode API — it is a
chunked encoder-decoder model. The practical, dependency-free way to get
near-real-time behavior out of it (the same approach the whisper_streaming
/ whisper-live open-source projects use) is: repeatedly re-decode a
growing audio buffer, and treat text that stays an exact prefix match
across consecutive re-decodes as "stabilized" (a LocalAgreement policy).
Brand-new tail text is PARTIAL; once endpointing signals the turn probably
ended, the buffer is decoded once more at higher quality and emitted FINAL.

This reuses the already-loaded faster-whisper model (speech/asr.py) — no
second model kept resident, no new dependency. It also deliberately runs
two different decode configurations (see __init__): fast/greedy for
partial ticks, higher-quality for the FINAL decode — latency and accuracy
are not forced onto the same configuration (see docs/speech-pipeline.md).
"""

from typing import Optional

import numpy as np

from speech.asr import FasterWhisperAsr
from speech.live.events import TranscriptEvent, TranscriptStage
from speech.vad import LectureVadOptions


class LocalAgreementStreamingAsr:
    """Default streaming ASR backend. Swappable: anything exposing
    push_audio()/flush() with the same TranscriptEvent shape can replace
    it — e.g. a real streaming model, once one is worth the extra
    dependency/GPU requirement."""

    name = "local-agreement-faster-whisper"

    def __init__(
        self,
        sample_rate: int = 16000,
        language: str = "",
        prompt: str = "",
        fast_asr: Optional[FasterWhisperAsr] = None,
        quality_asr: Optional[FasterWhisperAsr] = None,
        min_tick_s: float = 1.0,
    ):
        self.sample_rate = sample_rate
        self.language = language
        self.prompt = prompt
        if fast_asr is None and quality_asr is None:
            # Two real configurations: cheap greedy partial ticks, careful FINAL decode (see speech/asr.py).
            fast_asr = FasterWhisperAsr(vad_options=LectureVadOptions(), fast=True)
            quality_asr = FasterWhisperAsr(vad_options=LectureVadOptions())
        self._fast_asr = fast_asr or quality_asr
        self._quality_asr = quality_asr or self._fast_asr
        self.min_tick_s = min_tick_s

        self._buffer = np.array([], dtype=np.float32)
        self._buffer_start_s: Optional[float] = None
        self._last_decode_text = ""
        self._last_tick_len_s = 0.0

    def reset(self, at_s: Optional[float] = None):
        self._buffer = np.array([], dtype=np.float32)
        self._buffer_start_s = at_s
        self._last_decode_text = ""
        self._last_tick_len_s = 0.0

    def push_audio(self, frame: np.ndarray, timestamp_s: float) -> Optional[TranscriptEvent]:
        """timestamp_s is the stream position at the END of `frame` (i.e.
        how far the live stream has gotten), not its start."""
        if self._buffer_start_s is None:
            self._buffer_start_s = timestamp_s - (len(frame) / self.sample_rate)
        self._buffer = np.concatenate([self._buffer, frame])

        buffered_s = len(self._buffer) / self.sample_rate
        if buffered_s - self._last_tick_len_s < self.min_tick_s:
            return None
        self._last_tick_len_s = buffered_s

        return self._decode_tick(fast=True)

    def _decode_tick(self, fast: bool) -> Optional[TranscriptEvent]:
        asr = self._fast_asr if fast else self._quality_asr
        result = asr.transcribe(self._buffer, self.sample_rate, language=self.language, prompt=self.prompt)
        text = " ".join(seg.text for seg in result.segments).strip()
        if not text:
            return None

        previous = self._last_decode_text
        reconfirmed = bool(previous) and text.startswith(previous)
        self._last_decode_text = text

        stage = TranscriptStage.STABILIZING if reconfirmed else TranscriptStage.PARTIAL
        start = self._buffer_start_s or 0.0
        end = start + len(self._buffer) / self.sample_rate
        words = [w for seg in result.segments for w in seg.words]
        return TranscriptEvent(stage=stage, text=text, start=start, end=end, words=words)

    def flush(self) -> Optional[TranscriptEvent]:
        """Call when endpointing fires (LIKELY_END/FORCED_END): decode once
        more at higher quality and emit FINAL. Resets the buffer either way."""
        if self._buffer.size == 0:
            self.reset()
            return None

        event = self._decode_tick(fast=False)
        if event is None:
            self.reset()
            return None

        final_event = TranscriptEvent(
            stage=TranscriptStage.FINAL, text=event.text, start=event.start, end=event.end, words=event.words
        )
        self.reset(at_s=event.end)
        return final_event
