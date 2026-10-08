"""Deterministic reconciliation of provisional live transcript hypotheses.

Only FINAL events become canonical transcript segments. PARTIAL and STABILIZING
updates replace the current hypothesis and are observable through ``partial``;
they never mutate committed history.
"""

from dataclasses import dataclass
from typing import Optional

from speech.live.events import TranscriptEvent, TranscriptStage
from speech.schema import make_segment, segment_id


@dataclass(frozen=True)
class ReconciliationResult:
    """Result of applying one live transcript event."""

    event: TranscriptEvent
    committed: Optional[dict]
    partial: Optional[TranscriptEvent]


class TranscriptReconciler:
    """Own live hypothesis state and canonical segment allocation.

    The reconciler is intentionally independent of ASR, VAD, transport, and
    persistence. A caller can therefore feed it recorded fixture events or
    events from a real streaming decoder with identical results.
    """

    def __init__(self, language: str = "", speaker_resolver=None, id_factory=None):
        self.language = language
        self._speaker_resolver = speaker_resolver or (lambda event: (None, True))
        # Default numbering (seg_0001, seg_0002, ...) is only unique within one reconciler.
        # Live sessions inject an id_factory that is unique across sessions and meetings.
        self._id_factory = id_factory or segment_id
        self._partial: Optional[TranscriptEvent] = None
        self._segments: list[dict] = []
        self._speakers: set[str] = set()

    @property
    def partial(self) -> Optional[TranscriptEvent]:
        return self._partial

    @property
    def segments(self) -> list[dict]:
        return list(self._segments)

    @property
    def speakers(self) -> list[str]:
        return sorted(self._speakers)

    def apply(self, event: TranscriptEvent) -> ReconciliationResult:
        if not isinstance(event, TranscriptEvent):
            raise TypeError("event must be a TranscriptEvent")
        if event.end < event.start:
            raise ValueError("transcript event end must be >= start")

        if event.stage in (TranscriptStage.PARTIAL, TranscriptStage.STABILIZING):
            self._partial = event
            return ReconciliationResult(event, None, event)

        if event.stage is not TranscriptStage.FINAL:
            raise ValueError(f"unsupported transcript stage: {event.stage}")

        if event.speaker is not None:
            speaker, uncertain = event.speaker, False
        else:
            speaker, uncertain = self._speaker_resolver(event)
        segment = make_segment(
            self._id_factory(len(self._segments) + 1),
            event.start,
            event.end,
            event.text.strip(),
            speaker=speaker,
            words=event.words,
            language=self.language or None,
            uncertain=uncertain,
        )
        self._segments.append(segment)
        if speaker and speaker != "overlap":
            self._speakers.add(speaker)
        self._partial = None
        return ReconciliationResult(event, segment, None)
