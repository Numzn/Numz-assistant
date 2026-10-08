"""
Endpointing: "has this person probably finished their turn?" — a
different question from VAD's "is speech occurring right now?"
(frame_vad.py / vad.py answer that one).

A stateful, per-turn detector fed a stream of speech/silence observations.
Uses configurable tiers rather than one hardcoded silence threshold,
because a breath, a mid-sentence "thinking" pause, and an actually-finished
turn all look identical to VAD alone — only accumulated duration (and,
eventually, other signals this stage deliberately does not attempt, like
prosody) tells them apart.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class EndpointSignal(str, Enum):
    CONTINUE = "continue"        # within a normal pause (short, or still in the thinking-pause grace window)
    LIKELY_END = "likely_end"    # silence exceeded end_silence_ms — probably a finished turn
    FORCED_END = "forced_end"    # max utterance duration hit — end regardless of silence


@dataclass
class EndpointerConfig:
    """All durations in milliseconds."""

    short_pause_ms: int = 250
    """Breaths/word gaps below this are never treated as meaningful — informational only, callers
    aren't required to check it since end_silence_ms already implies it."""

    end_silence_ms: int = 700
    """Silence beyond this looks like a finished turn -> LIKELY_END."""

    thinking_grace_ms: int = 1500
    """Reserved: a future prosody/incompleteness-aware policy could extend the grace period before
    LIKELY_END for pauses that look like "still thinking" rather than "done". Not used by the
    threshold-only policy below; documents the intended extension point."""

    max_utterance_ms: int = 20000
    """Bounds latency/segment length even with no silence at all (continuous speech) -> FORCED_END."""


# Tighter thresholds: back-and-forth conversation/meeting turn-taking.
CONVERSATION_PROFILE = EndpointerConfig()

# Looser thresholds: one person talking continuously, natural pauses shouldn't fragment segments.
# max_utterance_ms matches Whisper's own 30s attention window (see speech/vad.py).
LECTURE_PROFILE = EndpointerConfig(
    short_pause_ms=400,
    end_silence_ms=1200,
    thinking_grace_ms=2500,
    max_utterance_ms=30000,
)


class Endpointer:
    """One instance per active turn-in-progress (one per speaker slot, in a session)."""

    def __init__(self, config: Optional[EndpointerConfig] = None):
        self.config = config or CONVERSATION_PROFILE
        self._utterance_start: Optional[float] = None
        self._last_speech_at: Optional[float] = None
        self._silence_since: Optional[float] = None

    def reset(self):
        self._utterance_start = None
        self._last_speech_at = None
        self._silence_since = None

    def in_progress(self) -> bool:
        return self._utterance_start is not None

    def on_speech(self, timestamp_s: float) -> EndpointSignal:
        """Call for every frame/region a VAD marks as speech. Returns
        FORCED_END if the utterance has run past max_utterance_ms even
        with zero silence — continuous lecture speech must still get
        endpointed eventually, not just pause-triggered turns."""
        if self._utterance_start is None:
            self._utterance_start = timestamp_s
        self._last_speech_at = timestamp_s
        self._silence_since = None

        utterance_ms = (timestamp_s - self._utterance_start) * 1000
        if utterance_ms >= self.config.max_utterance_ms:
            return EndpointSignal.FORCED_END
        return EndpointSignal.CONTINUE

    def on_silence(self, timestamp_s: float) -> EndpointSignal:
        """Call for every frame/region a VAD marks as silence. Returns the
        current signal given accumulated silence/utterance duration."""
        if self._utterance_start is None:
            return EndpointSignal.CONTINUE  # nothing in progress yet

        if self._silence_since is None:
            self._silence_since = self._last_speech_at if self._last_speech_at is not None else timestamp_s

        silence_ms = (timestamp_s - self._silence_since) * 1000
        utterance_ms = (timestamp_s - self._utterance_start) * 1000

        if utterance_ms >= self.config.max_utterance_ms:
            return EndpointSignal.FORCED_END
        if silence_ms >= self.config.end_silence_ms:
            return EndpointSignal.LIKELY_END
        return EndpointSignal.CONTINUE
