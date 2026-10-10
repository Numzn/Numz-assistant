"""
Small shared audio I/O helpers. Extracted so both the batch pipeline's
PCM-to-tempfile diarization bridge and the live transport's optional
recording-save feature write WAV files the same, well-tested way.
"""

import os
import struct
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


class WavWriter:
    """Streams mono float32 PCM to a 16-bit WAV file as it arrives, so a long recording costs disk and not memory.

    The header is rewritten after every write, so a file is playable even if the process dies mid-recording.
    The file is created with mode 0600 and must not already exist.
    """

    HEADER_BYTES = 44

    def __init__(self, path: str, sample_rate: int):
        self.path = path
        self._rate = int(sample_rate)
        self._data_bytes = 0
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self._file = os.fdopen(fd, "wb")
        self._file.write(self._header())
        self._file.flush()

    def _header(self) -> bytes:
        data = min(self._data_bytes, 0xFFFFFFFF - 36)
        return (
            b"RIFF"
            + struct.pack("<I", 36 + data)
            + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, self._rate, self._rate * 2, 2, 16)
            + b"data"
            + struct.pack("<I", data)
        )

    @property
    def closed(self) -> bool:
        return self._file is None

    @property
    def seconds(self) -> float:
        return self._data_bytes / 2 / self._rate

    def write(self, pcm: np.ndarray) -> None:
        if self._file is None:
            raise ValueError("the recording is closed")
        samples = (np.clip(np.nan_to_num(pcm, nan=0.0), -1.0, 1.0) * 32767).astype("<i2")
        self._file.write(samples.tobytes())
        self._data_bytes += samples.size * 2
        end = self._file.tell()
        self._file.seek(0)
        self._file.write(self._header())
        self._file.seek(end)
        self._file.flush()

    def close(self) -> None:
        if self._file is None:
            return
        try:
            self._file.flush()
        finally:
            self._file.close()
            self._file = None
