"""
ASR (speech-to-text) with word-level timestamps.

Wraps the same faster-whisper model loading path as the live sidecar
(transcribe.py) — same model choice via WHISPER_MODEL/WHISPER_DEVICE/
WHISPER_COMPUTE_TYPE, same domain prompt — so behavior stays consistent
between the live conversational path and this batch pipeline. Decoding
still uses faster-whisper's own vad_filter=True with our tuned VadOptions
(see vad.py) rather than manual clip_timestamps slicing, to avoid
faster-whisper's 30s-per-manual-clip truncation trap on long speech runs.
"""

from dataclasses import dataclass, field
from typing import Optional

import transcribe as live_transcribe
from speech.repetition import keep_mask
from speech.schema import make_word
from speech.vad import LectureVadOptions


@dataclass
class AsrSegment:
    start: float
    end: float
    text: str
    words: list = field(default_factory=list)  # schema.make_word() dicts
    avg_logprob: float = 0.0
    no_speech_prob: float = 0.0


@dataclass
class AsrResult:
    segments: list  # list[AsrSegment]
    language: str
    language_probability: float


class FasterWhisperAsr:
    """Default ASR backend. Swappable: any object exposing
    .transcribe(pcm, sample_rate, language, prompt) -> AsrResult can
    replace this without changes to pipeline.py or reconcile.py."""

    name = "faster-whisper"

    def __init__(self, vad_options: Optional[LectureVadOptions] = None, fast: bool = False):
        self.vad_options = vad_options or LectureVadOptions()
        # fast: live partial ticks, re-decoded every second while someone speaks and shown only as
        # provisional text, so greedy, one temperature and no word timings. The default (quality) is for
        # FINAL lines and the batch pipeline: beam search with temperature fallback and word timings.
        self.fast = fast

    def transcribe(self, pcm, sample_rate: int, language: str = "", prompt: str = "") -> AsrResult:
        if pcm.size == 0:
            return AsrResult(segments=[], language=language or "", language_probability=0.0)

        raw_segments, info = live_transcribe._transcribe_segments(
            pcm,
            language=language,
            prompt=prompt,
            word_timestamps=not self.fast,
            vad_parameters=self.vad_options.to_vad_options(),
            beam_size=1 if self.fast else 5,
            temperature=0.0 if self.fast else live_transcribe.FALLBACK_TEMPERATURES,
            # Meetings and lectures are free speech: the assistant's command prompt would only bias them.
            use_assistant_prompt=False,
        )

        # Whisper emits a loop ("What's up? What's up? ...") as many short segments, so the guard has to look at
        # the words of the WHOLE decode in one pass: judged one segment at a time, a 15-segment loop passes.
        parts = []
        for seg in raw_segments:
            raw_words = [w for w in (seg.words or []) if (w.word or "").strip()]
            tokens = [w.word.strip() for w in raw_words] if raw_words else (seg.text or "").split()
            parts.append((seg, raw_words, tokens))
        keep = keep_mask([token for _, _, tokens in parts for token in tokens])

        segments = []
        offset = 0
        for seg, raw_words, tokens in parts:
            mask = keep[offset : offset + len(tokens)]
            offset += len(tokens)
            if raw_words:
                # Cut repetition loops word by word, so the kept words keep their real timings.
                if all(mask):
                    text = (seg.text or "").strip()
                else:
                    raw_words = [w for w, kept in zip(raw_words, mask) if kept]
                    text = "".join(w.word for w in raw_words).strip()
            else:
                text = (seg.text or "").strip() if all(mask) else " ".join(t for t, kept in zip(tokens, mask) if kept)
            if not text:
                continue
            words = [make_word(w.word.strip(), w.start, w.end, w.probability) for w in raw_words]
            segments.append(
                AsrSegment(
                    start=seg.start,
                    end=seg.end,
                    text=text,
                    words=words,
                    avg_logprob=seg.avg_logprob,
                    no_speech_prob=seg.no_speech_prob,
                )
            )

        return AsrResult(
            segments=segments,
            language=info.language,
            language_probability=getattr(info, "language_probability", 0.0),
        )
