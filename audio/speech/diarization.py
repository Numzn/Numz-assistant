"""
Speaker diarization.

Default is NullDiarizer: a single implicit speaker for the whole file. No
extra download, no auth, no heavy dependency — the pipeline is fully
functional without diarization. meta.diarization.enabled=false in the
canonical transcript makes clear this is a placeholder label, not a
verified speaker split.

PyannoteDiarizer is a real backend against pyannote.audio's 3.x pipeline
API, but deliberately not wired in by default:
  - pyannote.audio is NOT in audio/requirements.txt — install
    audio/requirements.diarization.txt to add it. It's a heavy, torch-based
    dependency (pytorch-lightning, speechbrain) on top of what's already
    installed for ASR.
  - pyannote/speaker-diarization-3.1 is a gated HuggingFace model: you need
    an HF account, to accept that model's terms on its model page, and an
    access token set as HF_TOKEN (or PYANNOTE_AUTH_TOKEN).

Both backends return the same shape — list[{"start", "end", "speaker",
"confidence"}] — so reconcile.py never needs to know which one ran.
"""

import os
from typing import Optional, Protocol


class Diarizer(Protocol):
    name: str

    def diarize(self, audio_path: str, duration_s: float) -> list[dict]: ...


class NullDiarizer:
    name = "none"

    def diarize(self, audio_path: str, duration_s: float) -> list[dict]:
        if duration_s <= 0:
            return []
        return [{"start": 0.0, "end": duration_s, "speaker": "speaker_00", "confidence": None}]


class PyannoteDiarizer:
    """Real diarization via pyannote.audio's pretrained pipeline. Lazily
    imports pyannote so the rest of the pipeline works without it
    installed unless this backend is explicitly selected (--diarize)."""

    name = "pyannote"

    def __init__(self, model_name: str = "pyannote/speaker-diarization-3.1", auth_token: Optional[str] = None):
        self.model_name = model_name
        self.auth_token = auth_token or os.environ.get("HF_TOKEN") or os.environ.get("PYANNOTE_AUTH_TOKEN")
        self._pipeline = None

    def _load_pipeline(self):
        if self._pipeline is not None:
            return self._pipeline

        if not self.auth_token:
            raise RuntimeError(
                "Diarization backend 'pyannote' requires a HuggingFace access token.\n"
                "  1. Create/sign in to a HuggingFace account: https://huggingface.co/join\n"
                f"  2. Accept the model terms: https://huggingface.co/{self.model_name}\n"
                "  3. Create a token: https://huggingface.co/settings/tokens\n"
                "  4. Set it as HF_TOKEN (in .env.secrets or your shell env) and retry."
            )

        try:
            from pyannote.audio import Pipeline
        except ImportError as err:
            raise RuntimeError(
                "Diarization backend 'pyannote' requires pyannote.audio, which is not installed.\n"
                "  Install it with: audio/.venv/bin/pip install -r audio/requirements.diarization.txt\n"
                "  (kept out of the default install — it's a heavy, torch-based extra)"
            ) from err

        self._pipeline = Pipeline.from_pretrained(self.model_name, use_auth_token=self.auth_token)
        return self._pipeline

    def diarize(self, audio_path: str, duration_s: float) -> list[dict]:
        pipeline = self._load_pipeline()
        annotation = pipeline(audio_path)

        turns = []
        for turn, _, speaker in annotation.itertracks(yield_label=True):
            turns.append(
                {
                    "start": float(turn.start),
                    "end": float(turn.end),
                    "speaker": speaker.replace("SPEAKER_", "speaker_").lower(),
                    "confidence": None,
                }
            )
        return turns
