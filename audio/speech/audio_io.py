"""
Small shared audio I/O helpers. Extracted so both the batch pipeline's
PCM-to-tempfile diarization bridge and the live transport's optional
recording-save feature write WAV files the same, well-tested way.
"""

import wave

import numpy as np


def write_wav(path: str, pcm: np.ndarray, sample_rate: int) -> None:
    """Write mono float32 PCM (range [-1, 1]) to a 16-bit PCM WAV file."""
    pcm_int16 = (np.clip(pcm, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_int16.tobytes())
