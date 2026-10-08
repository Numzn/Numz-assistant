"""
Live-mode speech processing: audio frames -> VAD -> endpointing ->
streaming ASR -> partial/final transcript events -> LiveSpeechSession.

Separate subpackage from audio/speech/*.py (batch) by design — clean
separation between live and batch processing. Both converge on the same
canonical transcript format (speech/schema.py, unmodified by this
subpackage) via session.py's finalize().
"""
