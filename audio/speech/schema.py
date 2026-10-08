"""
Canonical Speech Intelligence transcript schema (versioned).

This is the one internal transcript format the rest of NUMZ AI (notes
generation, and future search/Q&A/UI) should consume, independent of which
VAD/ASR/diarization backends produced it. Bump SCHEMA_VERSION on any
incompatible field change.
"""

SCHEMA_VERSION = "1.0"


def validate_transcript(transcript):
    """Validate the minimum invariants shared by live and batch consumers.

    Raises ``ValueError`` with a field-oriented message instead of allowing a
    malformed transcript to reach persistence or grounded intelligence.
    """
    if not isinstance(transcript, dict):
        raise ValueError("transcript must be an object")
    if transcript.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("unsupported transcript schemaVersion")
    if not isinstance(transcript.get("segments"), list):
        raise ValueError("transcript.segments must be an array")
    duration = transcript.get("durationS")
    if not isinstance(duration, (int, float)) or duration < 0:
        raise ValueError("transcript.durationS must be a non-negative number")

    previous_end = 0.0
    seen_ids = set()
    for segment in transcript["segments"]:
        if not isinstance(segment, dict):
            raise ValueError("transcript segment must be an object")
        segment_id_value = segment.get("id")
        if not isinstance(segment_id_value, str) or not segment_id_value:
            raise ValueError("transcript segment id must be a non-empty string")
        if segment_id_value in seen_ids:
            raise ValueError(f"duplicate transcript segment id: {segment_id_value}")
        seen_ids.add(segment_id_value)
        start = segment.get("start")
        end = segment.get("end")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            raise ValueError(f"invalid timestamps for segment: {segment_id_value}")
        if start < 0 or end < start or end > duration:
            raise ValueError(f"timestamps out of bounds for segment: {segment_id_value}")
        if start < previous_end:
            raise ValueError(f"segments are not ordered: {segment_id_value}")
        if not isinstance(segment.get("text"), str):
            raise ValueError(f"text must be a string for segment: {segment_id_value}")
        previous_end = end

    return transcript


def make_word(text, start, end, confidence=None):
    return {
        "text": text,
        "start": round(float(start), 3),
        "end": round(float(end), 3),
        "confidence": round(float(confidence), 3) if confidence is not None else None,
    }


def make_segment(
    segment_id,
    start,
    end,
    text,
    speaker=None,
    speaker_confidence=None,
    words=None,
    confidence=None,
    language=None,
    uncertain=False,
):
    """
    segment_id: stable string id, e.g. "seg_0001"
    speaker: speaker label (e.g. "speaker_00") or None if diarization
        couldn't attribute this segment
    uncertain: True when speaker attribution is ambiguous (e.g. overlap,
        or the word fell in a gap between diarization turns) rather than
        guessed
    """
    return {
        "id": segment_id,
        "start": round(float(start), 3),
        "end": round(float(end), 3),
        "text": text,
        "speaker": speaker,
        "speakerConfidence": round(float(speaker_confidence), 3)
        if speaker_confidence is not None
        else None,
        "words": words or [],
        "confidence": round(float(confidence), 3) if confidence is not None else None,
        "language": language,
        "uncertain": bool(uncertain),
    }


def make_transcript(source, duration_s, language, segments, speakers, meta):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": source,
        "durationS": round(float(duration_s), 3),
        "language": language,
        "speakers": speakers,
        "segments": segments,
        "meta": meta,
    }


def segment_id(index: int) -> str:
    return f"seg_{index:04d}"
