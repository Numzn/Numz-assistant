"""
Live speaker handling.

Real-time speaker diarization needs an incremental speaker-embedding +
online-clustering approach. Running the batch pyannote pipeline (speech/
diarization.py) — which diarizes a whole recording at once via global
clustering — on tiny live chunks would not produce meaningful or stable
speaker labels, and is deliberately not attempted here.

A genuine streaming implementation would need a lightweight embedding
model kept resident for the entire session, on top of the ASR model
already resident — a second simultaneously-loaded model, which conflicts
with this machine's resource constraints (see docs/speech-pipeline.md).
So for this stage, live speaker attribution defaults to a single anonymous
speaker, honestly labeled as such — matching the batch NullDiarizer
convention — rather than fabricating turn-taking guesses (e.g. rotating
"Speaker 0/1/2" on every pause would be actively misleading, not merely
incomplete).

The real, accurate multi-speaker result comes from the OPTIONAL
post-meeting reprocessing pass (session.py's finalize()), which reuses the
existing, unmodified batch PyannoteDiarizer on the complete recording once
the meeting has ended — exactly the "final offline pass may improve
speaker attribution" behavior called for.

LiveDiarizer is still a real interface so a future streaming
embedding-based implementation can be dropped into LiveSpeechSession
without changing it.
"""

from typing import Optional, Protocol, Tuple


class LiveDiarizer(Protocol):
    name: str

    def current_speaker(self, timestamp_s: float) -> Tuple[Optional[str], bool]:
        """Returns (speaker_label_or_None, uncertain)."""
        ...


class SingleSpeakerLiveDiarizer:
    """Default: everything is one anonymous speaker, honestly labeled
    (session.finalize() sets meta.diarization.enabled=false for this)."""

    name = "none"

    def current_speaker(self, timestamp_s: float) -> Tuple[Optional[str], bool]:
        return "speaker_00", False
