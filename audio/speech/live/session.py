"""
LiveSpeechSession: the live-mode counterpart to the batch pipeline
(speech/pipeline.py). Ties frame VAD + endpointing + streaming ASR + live
speaker handling together, accumulates FINAL events into the exact same
canonical segment schema (speech/schema.py) that batch processing
produces, and can optionally reprocess the full recording through the
batch pipeline once the session ends for higher accuracy.
"""

import time
import uuid
from enum import Enum
from typing import Callable, Optional

import numpy as np

from speech.live.diarization_live import LiveDiarizer, SingleSpeakerLiveDiarizer
from speech.live.endpointing import CONVERSATION_PROFILE, Endpointer, EndpointerConfig, EndpointSignal
from speech.live.events import TranscriptEvent, TranscriptStage, validate_audio_frame
from speech.live.frame_vad import FrameVad
from speech.live.streaming_asr import LocalAgreementStreamingAsr
from speech.reconciler import TranscriptReconciler
from speech.schema import make_transcript, validate_transcript


class SessionState(str, Enum):
    LISTENING = "listening"
    ENDED = "ended"


class LiveSpeechSession:
    def __init__(
        self,
        session_id: Optional[str] = None,
        sample_rate: int = 16000,
        language: str = "",
        endpointer_config: Optional[EndpointerConfig] = None,
        streaming_asr=None,
        frame_vad: Optional[FrameVad] = None,
        diarizer: Optional[LiveDiarizer] = None,
        keep_audio_for_reprocessing: bool = False,
    ):
        self.session_id = session_id or uuid.uuid4().hex[:12]
        self.sample_rate = sample_rate
        self.language = language
        self.started_at = time.time()
        self.state = SessionState.LISTENING
        self.current_speaker: Optional[str] = None
        self.partial_transcript: Optional[TranscriptEvent] = None
        self.finalized_segments: list = []
        self.speakers: set = set()
        self.keep_audio_for_reprocessing = keep_audio_for_reprocessing

        self._streaming_asr = streaming_asr or LocalAgreementStreamingAsr(sample_rate=sample_rate, language=language)
        self._frame_vad = frame_vad or FrameVad()
        self._endpointer = Endpointer(endpointer_config or CONVERSATION_PROFILE)
        self._diarizer = diarizer or SingleSpeakerLiveDiarizer()
        self._reconciler = TranscriptReconciler(
            language=self.language,
            speaker_resolver=lambda event: self._diarizer.current_speaker(
                (event.start + event.end) / 2
            ),
        )
        self._raw_audio: list = []
        self._on_transcript_event: Optional[Callable[[TranscriptEvent], None]] = None

    def on_transcript_event(self, callback: Callable[[TranscriptEvent], None]):
        """Optional hook: called with every PARTIAL/STABILIZING/FINAL
        TranscriptEvent. This is the seam a rolling-intelligence layer or a
        live UI would subscribe to (see server/services/rollingIntelligenceService.js
        for the Node-side consumer of FINAL events)."""
        self._on_transcript_event = callback

    def ingest_audio_frame(self, frame: np.ndarray, timestamp_s: float):
        """The live audio ingestion seam: hand it raw PCM frames and the
        current stream position (seconds, at the end of `frame`) as they
        arrive — from a mic, a WebSocket, a file played back in real time,
        or a test harness. Frame VAD, endpointing, and streaming ASR are
        all handled internally."""
        if self.state != SessionState.LISTENING:
            return

        validate_audio_frame(frame, self.sample_rate, timestamp_s)

        if self.keep_audio_for_reprocessing:
            self._raw_audio.append(frame)

        if self._frame_vad.is_speech(frame):
            signal = self._endpointer.on_speech(timestamp_s)
            event = self._streaming_asr.push_audio(frame, timestamp_s)
            if event:
                self._emit(event)
            if signal == EndpointSignal.FORCED_END:
                self._flush_utterance()
            return

        signal = self._endpointer.on_silence(timestamp_s)
        if signal in (EndpointSignal.LIKELY_END, EndpointSignal.FORCED_END):
            self._flush_utterance()

    def _flush_utterance(self):
        final_event = self._streaming_asr.flush()
        self._endpointer.reset()
        if final_event:
            self._emit(final_event)
            self._commit_final(final_event)

    def _emit(self, event: TranscriptEvent):
        self.partial_transcript = None if event.stage == TranscriptStage.FINAL else event
        if self._on_transcript_event:
            self._on_transcript_event(event)

    def _commit_final(self, event: TranscriptEvent):
        result = self._reconciler.apply(event)
        if result.committed is None:
            return
        self.finalized_segments = self._reconciler.segments
        self.speakers = set(self._reconciler.speakers)
        self.current_speaker = result.committed.get("speaker")

    def snapshot(self) -> dict:
        """Current state for a live UI/consumer. Not the canonical
        transcript — partials are provisional by design and never appear
        in finalized_segments until FINAL."""
        return {
            "sessionId": self.session_id,
            "state": self.state.value,
            "currentSpeaker": self.current_speaker,
            "partial": _event_to_dict(self.partial_transcript) if self.partial_transcript else None,
            "finalizedSegmentCount": len(self.finalized_segments),
        }

    def end(self):
        """Flush anything buffered and stop accepting audio."""
        if self.state == SessionState.ENDED:
            return
        self._flush_utterance()
        self.state = SessionState.ENDED

    def get_raw_audio_pcm(self) -> Optional[np.ndarray]:
        """Concatenated raw PCM for this session if keep_audio_for_reprocessing
        was set; None otherwise. Used by finalize()'s reprocessing path and
        available to callers that want to persist the recording separately
        (e.g. the live transport's optional save-to-disk feature)."""
        if not self._raw_audio:
            return None
        return np.concatenate(self._raw_audio)

    def finalize(self, reprocess: bool = True, diarizer=None) -> dict:
        """
        Produce the canonical transcript (speech/schema.py) for this
        session — the "post-meeting processing" step.

        If `reprocess` is True and raw audio was retained
        (keep_audio_for_reprocessing=True), re-runs the batch pipeline
        (full-quality ASR + optional real diarization + reconciliation) on
        the complete recording — the "optional final alignment/diarization
        pass" that may supersede the live-provisional result. Falls back
        to the live-accumulated segments otherwise (still valid canonical
        output, just without a real diarization pass).
        """
        if self.state != SessionState.ENDED:
            self.end()

        pcm = self.get_raw_audio_pcm()
        if reprocess and pcm is not None:
            from speech.pipeline import process_pcm  # local import: batch pipeline stays optional for pure-live use

            transcript = process_pcm(
                pcm,
                self.sample_rate,
                source=f"live-session:{self.session_id}",
                language=self.language,
                diarizer=diarizer,
            )
            transcript["meta"]["sourceMode"] = "live"
            transcript["meta"]["finalization"] = "reprocessed"
            return validate_transcript(transcript)

        duration_s = self.finalized_segments[-1]["end"] if self.finalized_segments else 0.0
        transcript = make_transcript(
            source=f"live-session:{self.session_id}",
            duration_s=duration_s,
            language=self.language or None,
            segments=self.finalized_segments,
            speakers=sorted(self.speakers),
            meta={
                "asr": {"engine": self._streaming_asr.name},
                "diarization": {"engine": self._diarizer.name, "enabled": False},
                "sourceMode": "live",
                "finalization": "live-only",
            },
        )
        return validate_transcript(transcript)


def _event_to_dict(event: TranscriptEvent) -> dict:
    return {"stage": event.stage.value, "text": event.text, "start": round(event.start, 3), "end": round(event.end, 3)}
