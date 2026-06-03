"""
Decode audio → Silero VAD trim → faster-whisper transcription.
Model is loaded once at import/startup.
"""

import io
import logging
import os
import subprocess
import tempfile
import time
from typing import Any

import numpy as np
import torch

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

VAD_MIN_SPEECH_MS = int(os.environ.get("VAD_MIN_SPEECH_MS", "250"))
VAD_MIN_SILENCE_MS = int(os.environ.get("VAD_MIN_SILENCE_MS", "300"))
VAD_SPEECH_PAD_MS = int(os.environ.get("VAD_SPEECH_PAD_MS", "80"))

_whisper_model = None
_vad_model = None
_vad_get_speech_timestamps = None


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


def _load_vad():
    """Load Silero VAD via the silero-vad PyPI package (ONNX runtime, no torchaudio)."""
    global _vad_model, _vad_get_speech_timestamps
    if _vad_model is not None:
        return _vad_model, _vad_get_speech_timestamps
    from silero_vad import get_speech_timestamps, load_silero_vad

    logger.info("Loading Silero VAD (onnx)")
    t0 = time.perf_counter()
    _vad_model = load_silero_vad(onnx=True)
    _vad_get_speech_timestamps = get_speech_timestamps
    logger.info("Silero VAD loaded in %.2fs", time.perf_counter() - t0)
    return _vad_model, _vad_get_speech_timestamps


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


def trim_with_silero(pcm: np.ndarray) -> tuple[np.ndarray, int]:
    """
    Trim leading/trailing silence using Silero VAD.
    Returns (trimmed_pcm, original_duration_ms).
    """
    if pcm.size == 0:
        return pcm, 0

    original_ms = int(len(pcm) / SAMPLE_RATE * 1000)
    model, get_speech_timestamps = _load_vad()

    wav = torch.from_numpy(pcm)
    timestamps = get_speech_timestamps(
        wav,
        model,
        sampling_rate=SAMPLE_RATE,
        min_speech_duration_ms=VAD_MIN_SPEECH_MS,
        min_silence_duration_ms=VAD_MIN_SILENCE_MS,
        speech_pad_ms=VAD_SPEECH_PAD_MS,
        return_seconds=False,
    )

    if not timestamps:
        return np.array([], dtype=np.float32), original_ms

    start = timestamps[0]["start"]
    end = timestamps[-1]["end"]
    trimmed = pcm[start:end]
    return trimmed, original_ms


def transcribe_pcm(
    pcm: np.ndarray,
    language: str = "",
    prompt: str = "",
) -> str:
    if pcm.size == 0:
        return ""

    model = _load_whisper()
    lang = language.split("-")[0] if language else None
    lang = lang if lang else None

    segments, _info = model.transcribe(
        pcm,
        language=lang,
        initial_prompt=prompt or None,
        beam_size=1,
        vad_filter=False,
    )

    parts = []
    for seg in segments:
        t = (seg.text or "").strip()
        if t:
            parts.append(t)
    return " ".join(parts).strip()


def transcribe_blob(
    audio_bytes: bytes,
    mime_type: str = "audio/webm",
    language: str = "",
    prompt: str = "",
) -> dict[str, Any]:
    """
    Full pipeline: decode → VAD trim → whisper.
    """
    t0 = time.perf_counter()
    pcm = decode_audio_to_pcm(audio_bytes, mime_type)
    t_decode = time.perf_counter()
    trimmed, original_ms = trim_with_silero(pcm)
    t_vad = time.perf_counter()
    vad_trimmed_ms = int(len(trimmed) / SAMPLE_RATE * 1000) if trimmed.size else 0
    decode_ms = int((t_decode - t0) * 1000)
    vad_ms = int((t_vad - t_decode) * 1000)

    if trimmed.size == 0:
        return {
            "text": "",
            "error": "no-speech",
            "durationMs": original_ms,
            "vadTrimmedMs": 0,
            "decodeMs": decode_ms,
            "vadMs": vad_ms,
            "whisperMs": 0,
            "elapsedMs": int((time.perf_counter() - t0) * 1000),
        }

    text = transcribe_pcm(trimmed, language=language, prompt=prompt)
    t_whisper = time.perf_counter()
    whisper_ms = int((t_whisper - t_vad) * 1000)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    logger.info(
        "transcribe ok original_ms=%s vad_trimmed_ms=%s decode_ms=%s vad_ms=%s whisper_ms=%s elapsed_ms=%s chars=%s",
        original_ms,
        vad_trimmed_ms,
        decode_ms,
        vad_ms,
        whisper_ms,
        elapsed_ms,
        len(text),
    )

    return {
        "text": text,
        "durationMs": original_ms,
        "vadTrimmedMs": vad_trimmed_ms,
        "decodeMs": decode_ms,
        "vadMs": vad_ms,
        "whisperMs": whisper_ms,
        "elapsedMs": elapsed_ms,
    }


def warmup():
    """Pre-load models at server startup."""
    _load_vad()
    _load_whisper()


def health_info() -> dict[str, Any]:
    return {
        "ok": True,
        "whisperModel": WHISPER_MODEL,
        "whisperDevice": WHISPER_DEVICE,
        "computeType": WHISPER_COMPUTE_TYPE,
        "sampleRate": SAMPLE_RATE,
    }
