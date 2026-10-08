"""
Reconcile ASR word timestamps against diarization turns into the
canonical, speaker-aware transcript (schema.py).

This is what turns "one long ASR segment" into the right sequence of
shorter per-speaker segments — preserving speaker transitions instead of
assigning one speaker to a whole ASR segment. Where a word's timestamp
doesn't cleanly fall inside exactly one diarization turn (a gap between
turns, or genuine overlap between two turns), the segment is marked
speaker=None or speaker="overlap" with uncertain=True rather than
guessing an attribution.
"""

from speech.schema import make_segment, segment_id


def _speaker_at(turns: list[dict], t: float):
    """Returns (speaker, is_uncertain). speaker is a label, None (falls in
    a gap between turns), or "overlap" (2+ turns claim this timestamp)."""
    matches = [turn["speaker"] for turn in turns if turn["start"] <= t < turn["end"]]
    if len(matches) == 1:
        return matches[0], False
    if len(matches) == 0:
        return None, True
    return "overlap", True


def _confidence_from_logprob(avg_logprob: float) -> float:
    """Rough 0..1 confidence proxy from Whisper's avg_logprob (typically in
    roughly [-1, 0]). Not a calibrated probability — a practical signal for
    "does this segment look shaky", not a claim of measured accuracy."""
    return max(0.0, min(1.0, 1.0 + avg_logprob))


def reconcile(asr_result, diarization_turns: list[dict], diarization_enabled: bool):
    """
    asr_result: speech.asr.AsrResult
    diarization_turns: list[{"start","end","speaker","confidence"}]
    diarization_enabled: whether a real diarizer ran (vs. the single-
        implicit-speaker NullDiarizer default) — controls whether
        speakerConfidence claims a real measurement.

    Returns (segments: list[canonical segment dicts], speakers: list[str])
    """
    segments = []
    speakers_seen = set()
    counter = 1

    def emit(start, end, text, words, speaker, uncertain, avg_logprob):
        nonlocal counter
        segments.append(
            make_segment(
                segment_id(counter),
                start,
                end,
                text,
                speaker=speaker,
                speaker_confidence=(1.0 if (diarization_enabled and not uncertain) else None),
                words=words,
                confidence=_confidence_from_logprob(avg_logprob),
                language=asr_result.language,
                uncertain=uncertain,
            )
        )
        counter += 1
        if speaker and speaker != "overlap":
            speakers_seen.add(speaker)

    for seg in asr_result.segments:
        words = seg.words
        if not words:
            # No word-level timestamps for this segment — degrade to
            # segment-level speaker lookup rather than dropping it.
            speaker, uncertain = _speaker_at(diarization_turns, (seg.start + seg.end) / 2)
            emit(seg.start, seg.end, seg.text, [], speaker, uncertain, seg.avg_logprob)
            continue

        current_words = []
        current_speaker = None
        current_uncertain = False

        def flush_current():
            text = seg.text if len(current_words) == len(words) else " ".join(w["text"] for w in current_words)
            emit(
                current_words[0]["start"],
                current_words[-1]["end"],
                text,
                list(current_words),
                current_speaker,
                current_uncertain,
                seg.avg_logprob,
            )

        for w in words:
            speaker, uncertain = _speaker_at(diarization_turns, (w["start"] + w["end"]) / 2)

            if current_words and (speaker != current_speaker or uncertain != current_uncertain):
                flush_current()
                current_words = []

            current_speaker = speaker
            current_uncertain = uncertain
            current_words.append(w)

        if current_words:
            flush_current()

    return segments, sorted(speakers_seen)
