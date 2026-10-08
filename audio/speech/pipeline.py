"""
Speech Intelligence pipeline orchestration:
decode -> VAD (metadata) -> ASR (+ words) -> alignment -> diarization ->
reconciliation -> canonical transcript (schema.py).

Each stage is a swappable object (asr.py / alignment.py / diarization.py),
so a future ASR/diarization model change touches this file's call sites at
most, not every consumer of the canonical transcript.
"""

import os
import tempfile
import time

import transcribe as live_transcribe
from speech.alignment import WhisperNativeAlignment
from speech.asr import FasterWhisperAsr
from speech.audio_io import write_wav
from speech.diarization import NullDiarizer
from speech.reconcile import reconcile
from speech.schema import make_transcript
from speech.vad import LectureVadOptions, detect_speech_regions

def process_lecture_file(
    path: str,
    language: str = "",
    prompt: str = "",
    diarizer=None,
    asr=None,
    alignment=None,
    vad_options=None,
) -> dict:
    pcm = live_transcribe.decode_audio_file(path)

    return process_pcm(
        pcm,
        live_transcribe.SAMPLE_RATE,
        source=os.path.abspath(path),
        language=language,
        prompt=prompt,
        diarizer=diarizer,
        asr=asr,
        alignment=alignment,
        vad_options=vad_options,
        diarizer_audio_path=path,
    )


def process_pcm(
    pcm,
    sample_rate: int,
    source: str,
    language: str = "",
    prompt: str = "",
    diarizer=None,
    asr=None,
    alignment=None,
    vad_options=None,
    diarizer_audio_path: str = None,
) -> dict:
    """
    Same VAD -> ASR -> alignment -> diarization -> reconciliation pipeline
    as process_lecture_file(), operating on already-decoded PCM. Used
    directly by process_lecture_file() (decodes the file, then calls this)
    and by LiveSpeechSession.finalize()'s optional post-meeting
    reprocessing pass (speech/live/session.py), which has in-memory PCM
    and no source file.

    diarizer_audio_path: pass the real file path when one exists (as
    process_lecture_file does) so the diarizer sees the original audio
    unchanged. When None and diarization is enabled, the given PCM is
    bridged to a temporary WAV file for the diarizer instead.
    """
    vad_options = vad_options or LectureVadOptions()
    asr = asr or FasterWhisperAsr(vad_options=vad_options)
    alignment = alignment or WhisperNativeAlignment()
    diarizer = diarizer or NullDiarizer()

    duration_s = len(pcm) / sample_rate if pcm.size else 0.0
    t0 = time.perf_counter()

    speech_regions = detect_speech_regions(pcm, sample_rate, vad_options)

    asr_result = asr.transcribe(pcm, sample_rate, language=language, prompt=prompt)
    asr_result = alignment.align(pcm, sample_rate, asr_result)

    diarization_enabled = diarizer.name != "none"
    if diarizer_audio_path is not None:
        diarization_turns = diarizer.diarize(diarizer_audio_path, duration_s)
    elif diarization_enabled:
        diarization_turns = _diarize_pcm_via_tempfile(diarizer, pcm, sample_rate, duration_s)
    else:
        diarization_turns = diarizer.diarize("", duration_s)  # NullDiarizer ignores the path

    segments, speakers = reconcile(asr_result, diarization_turns, diarization_enabled)

    elapsed_s = round(time.perf_counter() - t0, 2)

    return make_transcript(
        source=source,
        duration_s=duration_s,
        language=asr_result.language,
        segments=segments,
        speakers=speakers,
        meta={
            "asr": {
                "engine": asr.name,
                "model": live_transcribe.WHISPER_MODEL,
                "computeType": live_transcribe.WHISPER_COMPUTE_TYPE,
            },
            "alignment": {"engine": alignment.name},
            "diarization": {"engine": diarizer.name, "enabled": diarization_enabled},
            "vad": {"speechRegions": len(speech_regions), "params": vars(vad_options)},
            "languageProbability": round(asr_result.language_probability, 3),
            "elapsedS": elapsed_s,
        },
    )


def _diarize_pcm_via_tempfile(diarizer, pcm, sample_rate: int, duration_s: float) -> list:
    """Bridge in-memory PCM to a temp WAV for diarizers that need a file
    path (pyannote's pipeline). Only used when there is no original source
    file (see process_pcm's diarizer_audio_path)."""
    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        write_wav(tmp_path, pcm, sample_rate)
        return diarizer.diarize(tmp_path, duration_s)
    finally:
        os.unlink(tmp_path)


def render_speaker_transcript(transcript: dict) -> str:
    """Human-readable "[HH:MM:SS] Speaker N" block view, grouping
    consecutive canonical segments that share the same speaker (the
    canonical JSON itself stays at finer per-transition granularity — see
    reconcile.py)."""
    lines = []
    current_label = None
    for seg in transcript["segments"]:
        label = _speaker_display(seg["speaker"])
        if label != current_label:
            if lines:
                lines.append("")
            lines.append(f"[{_format_timestamp(seg['start'])}] {label}")
            current_label = label
        lines.append(seg["text"])
    return "\n".join(lines)


def _speaker_display(speaker):
    if speaker == "overlap":
        return "Overlapping speech"
    if speaker is None:
        return "Unknown speaker"
    return speaker.replace("speaker_", "Speaker ")


def _format_timestamp(seconds: float) -> str:
    s = max(0, int(seconds))
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"
