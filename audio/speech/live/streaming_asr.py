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

import time
from typing import Callable, Optional

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
        min_tick_s: float = 2.0,
        preview_share: float = 1 / 3,
        clock: Callable[[], float] = time.perf_counter,
        decode_observer: Optional[Callable] = None,
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
        # Partial text is only a preview. A Whisper decode costs about the same however short the audio
        # (it always encodes a 30 s window: about 1.7 s per decode on this server), so previewing every
        # second of speech made the live path 1.6-2.4x slower than real time. Previews are paced so they
        # use at most this share of real time; the FINAL decode at the end of each utterance never waits.
        self.preview_share = preview_share
        self._clock = clock
        self._last_preview_cost_s = 0.0
        # Optional callable(kind, seconds, audio_s, segments) told about every decode: "preview" or "final",
        # how long Whisper took, how much audio it covered and its raw segments (diagnostics only).
        self._decode_observer = decode_observer

        self._buffer = np.array([], dtype=np.float32)
        # Where the buffered audio sits on the stream clock: the start of its first frame and the end of
        # its last. Silence between utterances is never buffered, so the next utterance must take its
        # start from its own first frame (until 2026-10-09 it inherited the previous utterance's end, which
        # squeezed every pause out of the timeline).
        self._buffer_start_s: Optional[float] = None
        self._buffer_end_s: Optional[float] = None
        self._last_decode_text = ""
        self._last_tick_len_s = 0.0

    def reset(self):
        self._buffer = np.array([], dtype=np.float32)
        self._buffer_start_s = None
        self._buffer_end_s = None
        self._last_decode_text = ""
        self._last_tick_len_s = 0.0

    def push_audio(self, frame: np.ndarray, timestamp_s: float) -> Optional[TranscriptEvent]:
        """timestamp_s is the stream position at the END of `frame` (i.e.
        how far the live stream has gotten), not its start."""
        if self._buffer_start_s is None:
            self._buffer_start_s = timestamp_s - (len(frame) / self.sample_rate)
        self._buffer_end_s = timestamp_s
        self._buffer = np.concatenate([self._buffer, frame])

        buffered_s = len(self._buffer) / self.sample_rate
        wait_s = max(self.min_tick_s, self._last_preview_cost_s / self.preview_share)
        if buffered_s - self._last_tick_len_s < wait_s:
            return None
        self._last_tick_len_s = buffered_s

        started = self._clock()
        event = self._decode_tick(fast=True)
        self._last_preview_cost_s = self._clock() - started
        return event

    def _decode_tick(self, fast: bool) -> Optional[TranscriptEvent]:
        asr = self._fast_asr if fast else self._quality_asr
        decode_started = time.perf_counter()
        result = asr.transcribe(self._buffer, self.sample_rate, language=self.language, prompt=self.prompt)
        if self._decode_observer is not None:
            self._decode_observer(
                "preview" if fast else "final",
                time.perf_counter() - decode_started,
                len(self._buffer) / self.sample_rate,
                result.segments,
            )
        text = " ".join(seg.text for seg in result.segments).strip()
        if not text:
            return None

        previous = self._last_decode_text
        reconfirmed = bool(previous) and text.startswith(previous)
        self._last_decode_text = text

        stage = TranscriptStage.STABILIZING if reconfirmed else TranscriptStage.PARTIAL
        start = self._buffer_start_s if self._buffer_start_s is not None else 0.0
        end = self._buffer_end_s if self._buffer_end_s is not None else start
        # Whisper times words from the start of the audio it was given; the transcript wants stream time.
        words = [
            {**word, "start": round(word["start"] + start, 3), "end": round(word["end"] + start, 3)}
            for seg in result.segments
            for word in seg.words
        ]
        return TranscriptEvent(stage=stage, text=text, start=start, end=end, words=words)

    def flush_at(self, split_at_s: float) -> Optional[TranscriptEvent]:
        """Finalize the audio up to `split_at_s` (stream time) and keep everything after it as the start of the
        next utterance: for a forced cut at the length limit, which should fall in a gap between words rather
        than wherever the clock ran out. Nothing is lost or repeated: the next utterance starts at the split.
        Falls back to a full flush() when the split is not inside the buffered audio."""
        if (
            self._buffer.size < 2
            or self._buffer_start_s is None
            or self._buffer_end_s is None
            or not (self._buffer_start_s < split_at_s < self._buffer_end_s)
        ):
            return self.flush()

        count = int(round((split_at_s - self._buffer_start_s) * self.sample_rate))
        count = min(max(count, 1), self._buffer.size - 1)
        head, tail = self._buffer[:count], self._buffer[count:]
        tail_start_s = self._buffer_start_s + count / self.sample_rate
        end_s = self._buffer_end_s

        self._buffer, self._buffer_end_s = head, tail_start_s
        event = self._decode_tick(fast=False)
        self._buffer, self._buffer_start_s, self._buffer_end_s = tail, tail_start_s, end_s
        self._last_decode_text = ""
        self._last_tick_len_s = len(tail) / self.sample_rate
        if event is None:
            return None
        return TranscriptEvent(
            stage=TranscriptStage.FINAL, text=event.text, start=event.start, end=event.end, words=event.words
        )

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
        self.reset()
        return final_event
