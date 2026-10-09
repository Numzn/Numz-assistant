"""
Decode audio → faster-whisper transcription (Whisper built-in VAD).
Model is loaded once at import/startup.
"""

import logging
import os
import subprocess
import tempfile
import time
from typing import Any

import numpy as np

from speech.repetition import collapse_repetitions

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

# Whisper reads its prompt as the text spoken just before the audio, and imitates it. A comma-separated
# keyword list therefore makes it answer in comma-separated single words and repeat list words
# ("no, one, NUMZ, NUMZ, NUMZ...", "stop, stop, stop..."), which is what meetings produced on 2026-10-09.
# So: one plain sentence, and only for the assistant's short spoken commands. Meetings and the batch
# pipeline get no prompt at all (see use_assistant_prompt below).
ASSISTANT_PROMPT = (
    "Numz is a voice assistant. The user asks about the fleet: vehicles, trackers, speed, fuel, "
    "location, maintenance and alerts."
)

# A decode that comes out degenerate (a repetition loop: compression ratio above 2.4, or very low
# confidence) is retried at the next temperature. A single temperature of 0.0 turns that safety net off.
FALLBACK_TEMPERATURES = (0.0, 0.2, 0.4, 0.6)

WHISPER_VAD_PARAMETERS = {
    "threshold": 0.3,
    "min_speech_duration_ms": 50,
    "min_silence_duration_ms": 800,
    "speech_pad_ms": 300,
}

_whisper_model = None


def _load_whisper():
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    from faster_whisper import WhisperModel

    logger.info(
        "Loading faster-whisper model=%s device=%s compute_type=%s",
        WHISPER_MODEL,
        WHISPER_DEVICE,
        WHISPER_COMPUTE_TYPE,
    )
    t0 = time.perf_counter()
    _whisper_model = WhisperModel(
        WHISPER_MODEL,
        device=WHISPER_DEVICE,
        compute_type=WHISPER_COMPUTE_TYPE,
    )
    logger.info("Whisper loaded in %.2fs", time.perf_counter() - t0)
    return _whisper_model


def _build_initial_prompt(client_prompt: str = "", use_assistant_prompt: bool = True):
    """The prompt for one decode: the caller's own sentence if it sent one, else the assistant sentence,
    or nothing at all for meetings and the batch pipeline."""
    client = (client_prompt or "").strip()
    if client:
        return client
    return ASSISTANT_PROMPT if use_assistant_prompt else None


def decode_audio_to_pcm(audio_bytes: bytes, mime_type: str = "audio/webm") -> np.ndarray:
    """Decode arbitrary audio blob to 16 kHz mono float32 PCM via ffmpeg."""
    ext = ".webm"
    if "ogg" in mime_type:
        ext = ".ogg"
    elif "wav" in mime_type:
        ext = ".wav"
    elif "mp4" in mime_type or "m4a" in mime_type:
        ext = ".m4a"

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as inp:
        inp.write(audio_bytes)
        inp_path = inp.name

    out_path = inp_path + ".pcm"
    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            inp_path,
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-f",
            "f32le",
            out_path,
        ]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                timeout=60,
            )
        except FileNotFoundError as err:
            raise RuntimeError(
                "ffmpeg not found on PATH — install ffmpeg and retry"
            ) from err
        if proc.returncode != 0:
            stderr = proc.stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"ffmpeg failed: {stderr[:500]}")

        pcm = np.fromfile(out_path, dtype=np.float32)
        return pcm
    finally:
        for p in (inp_path, out_path):
            try:
                os.unlink(p)
            except OSError:
                pass


MIME_BY_EXT = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "m4a": "audio/m4a",
    "mp4": "audio/mp4",
    "ogg": "audio/ogg",
    "webm": "audio/webm",
    "flac": "audio/flac",
}


def decode_audio_file(path: str) -> np.ndarray:
    """decode_audio_to_pcm for a file on disk (mime type guessed from the extension)."""
    with open(path, "rb") as f:
        audio_bytes = f.read()
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    return decode_audio_to_pcm(audio_bytes, MIME_BY_EXT.get(ext, "audio/webm"))


def _transcribe_segments(
    pcm: np.ndarray,
    language: str = "",
    prompt: str = "",
    word_timestamps: bool = False,
    vad_parameters=None,
    beam_size: int = 5,
    temperature=FALLBACK_TEMPERATURES,
    use_assistant_prompt: bool = True,
):
    """Run faster-whisper and return its (raw segment iterator, info).

    The one place decode parameters live. Shared by transcribe_pcm (live
    sidecar, text only), transcribe_pcm_with_timestamps (Lecture Engine CLI)
    and speech/asr.py (Speech Intelligence pipeline + live streaming ASR), so
    all of them stay on identical model/decode parameters. Callers vary
    word_timestamps, vad_parameters, and for live partial ticks a cheaper
    greedy decode (beam_size=1, temperature=0.0); meetings and the pipeline
    pass use_assistant_prompt=False.
    """
    model = _load_whisper()
    lang = language.split("-")[0] if language else None
    lang = lang if lang else None
    initial_prompt = _build_initial_prompt(prompt, use_assistant_prompt)

    return model.transcribe(
        pcm,
        language=lang,
        initial_prompt=initial_prompt,
        beam_size=beam_size,
        temperature=temperature,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        condition_on_previous_text=False,
        word_timestamps=word_timestamps,
        vad_filter=True,
        vad_parameters=WHISPER_VAD_PARAMETERS if vad_parameters is None else vad_parameters,
        no_speech_threshold=0.4,
    )


def transcribe_pcm(
    pcm: np.ndarray,
    language: str = "",
    prompt: str = "",
) -> str:
    if pcm.size == 0:
        return ""

    segments, _info = _transcribe_segments(pcm, language=language, prompt=prompt)

    parts = []
    for seg in segments:
        t = collapse_repetitions((seg.text or "").strip())
        if t:
            parts.append(t)
    return " ".join(parts).strip()


def transcribe_pcm_with_timestamps(
    pcm: np.ndarray,
    language: str = "",
    prompt: str = "",
) -> tuple[list[dict[str, Any]], str]:
    """
    Same model/VAD path as transcribe_pcm, but keeps per-segment start/end
    timestamps. Used by the offline Lecture Engine CLI (lecture_cli.py) —
    the live sidecar keeps using transcribe_pcm/transcribe_blob unchanged.
    """
    if pcm.size == 0:
        return [], ""

    segments, _info = _transcribe_segments(pcm, language=language, prompt=prompt)

    timestamped = []
    parts = []
    for seg in segments:
        t = collapse_repetitions((seg.text or "").strip())
        if t:
            timestamped.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": t})
            parts.append(t)
    return timestamped, " ".join(parts).strip()


def transcribe_blob(
    audio_bytes: bytes,
    mime_type: str = "audio/webm",
    language: str = "",
    prompt: str = "",
) -> dict[str, Any]:
    """
    Full pipeline: decode → whisper (full PCM, Whisper VAD).
    """
    t0 = time.perf_counter()
    pcm = decode_audio_to_pcm(audio_bytes, mime_type)
    t_decode = time.perf_counter()
    original_ms = int(len(pcm) / SAMPLE_RATE * 1000) if pcm.size else 0
    decode_ms = int((t_decode - t0) * 1000)

    if pcm.size == 0:
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info(
            '[AUDIO] duration=0.0s words=0 latency=%sms text=""',
            elapsed_ms,
        )
        return {
            "text": "",
            "error": "no-speech",
            "durationMs": 0,
            "vadTrimmedMs": original_ms,
            "decodeMs": decode_ms,
            "vadMs": 0,
            "whisperMs": 0,
            "elapsedMs": elapsed_ms,
        }

    text = transcribe_pcm(pcm, language=language, prompt=prompt)
    t_whisper = time.perf_counter()
    whisper_ms = int((t_whisper - t_decode) * 1000)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    word_count = len(text.split()) if text else 0
    audio_duration_s = round(len(pcm) / SAMPLE_RATE, 2)

    logger.info(
        '[AUDIO] duration=%.1fs words=%s latency=%sms text="%s"',
        audio_duration_s,
        word_count,
        elapsed_ms,
        text,
    )

    result: dict[str, Any] = {
        "text": text,
        "durationMs": original_ms,
        "vadTrimmedMs": original_ms,
        "decodeMs": decode_ms,
        "vadMs": 0,
        "whisperMs": whisper_ms,
        "elapsedMs": elapsed_ms,
        "audioDurationS": audio_duration_s,
        "wordCount": word_count,
    }

    if not text:
        result["error"] = "no-speech"

    return result


def warmup():
    """Pre-load Whisper at server startup."""
    _load_whisper()


def health_info() -> dict[str, Any]:
    return {
        "ok": True,
        "whisperModel": WHISPER_MODEL,
        "whisperDevice": WHISPER_DEVICE,
        "computeType": WHISPER_COMPUTE_TYPE,
        "sampleRate": SAMPLE_RATE,
        "vadMode": "whisper",
    }
