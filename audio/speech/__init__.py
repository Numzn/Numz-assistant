"""
Numz Speech Intelligence pipeline (batch/offline).

Audio -> VAD -> ASR (+ word timestamps) -> alignment -> diarization ->
reconciliation -> canonical transcript -> AI notes.

Deliberately separate from the live conversational STT path in
audio/transcribe.py + audio/server.py, which stays untouched. See
docs/speech-pipeline.md for the architecture writeup.
"""
