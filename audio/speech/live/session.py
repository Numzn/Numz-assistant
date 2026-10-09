"""
LiveSpeechSession: the live-mode counterpart to the batch pipeline
(speech/pipeline.py). Ties frame VAD + endpointing + streaming ASR together and
commits FINAL events into the canonical segment schema (speech/schema.py).

Two guarantees the transport relies on:
  - Committed segments are never lost by a later step. drain_committed() returns each
    committed segment exactly once, and the transport drains after every ingest and
    before any finalization work, so a failure in finalization cannot discard them.
  - Segment ids are unique across sessions (see speech/live/ids.py), so the same
    meeting can accept segments from many sessions.
"""

import time
from collections import deque
from enum import Enum
from typing import Callable, Optional

import numpy as np

from speech.live.diagnostics import SessionDiagnostics
from speech.live.diarization_live import LiveDiarizer, SingleSpeakerLiveDiarizer
from speech.live.endpointing import CONVERSATION_PROFILE, Endpointer, EndpointerConfig, EndpointSignal
from speech.live.events import TranscriptEvent, TranscriptStage, validate_audio_frame
from speech.live.frame_vad import FrameVad
from speech.live.ids import new_speech_session_id, require_uuid, segment_id_for
from speech.live.streaming_asr import LocalAgreementStreamingAsr
from speech.reconciler import TranscriptReconciler
from speech.schema import make_transcript, validate_transcript


# Audio kept from just before an utterance starts, so its first syllable (often quieter than the gate)
# reaches the recognizer instead of being clipped.
PRE_ROLL_S = 0.3


class SessionState(str, Enum):
    LISTENING = "listening"
    ENDED = "ended"


class LiveSpeechSession:
    def __init__(
        self,
        speech_session_id: Optional[str] = None,
        sample_rate: int = 16000,
        language: str = "",
        endpointer_config: Optional[EndpointerConfig] = None,
        streaming_asr=None,
        frame_vad: Optional[FrameVad] = None,
        diarizer: Optional[LiveDiarizer] = None,
        keep_audio_for_reprocessing: bool = False,
    ):
        self.session_id = require_uuid(speech_session_id or new_speech_session_id())
        self.sample_rate = sample_rate
        self.language = language
        self.started_at = time.time()
        self.state = SessionState.LISTENING
        self.current_speaker: Optional[str] = None
        self.partial_transcript: Optional[TranscriptEvent] = None
        self.finalized_segments: list = []
        self.speakers: set = set()
        self.keep_audio_for_reprocessing = keep_audio_for_reprocessing

        self._diagnostics = SessionDiagnostics(self.session_id, sample_rate=sample_rate)
        self._streaming_asr = streaming_asr or LocalAgreementStreamingAsr(
            sample_rate=sample_rate, language=language, decode_observer=self._diagnostics.on_decode
        )
        self._frame_vad = frame_vad or FrameVad()
        self._endpointer = Endpointer(endpointer_config or CONVERSATION_PROFILE)
        self._diarizer = diarizer or SingleSpeakerLiveDiarizer()
        self._reconciler = TranscriptReconciler(
            language=self.language,
            speaker_resolver=lambda event: self._diarizer.current_speaker((event.start + event.end) / 2),
            id_factory=lambda sequence: segment_id_for(self.session_id, sequence),
        )
        self._drained = 0
        self._raw_audio: list = []
        self._pre_roll: deque = deque()  # (frame, timestamp_s) from the moments before an utterance
        self._pre_roll_s = 0.0
        self._on_transcript_event: Optional[Callable[[TranscriptEvent], None]] = None

    def on_transcript_event(self, callback: Callable[[TranscriptEvent], None]):
        """Optional hook: called with every PARTIAL/STABILIZING/FINAL TranscriptEvent."""
        self._on_transcript_event = callback

    def ingest_audio_frame(self, frame: np.ndarray, timestamp_s: float):
        """Hand it raw PCM frames and the stream position (seconds, at the end of `frame`)."""
        if self.state != SessionState.LISTENING:
            return

        validate_audio_frame(frame, self.sample_rate, timestamp_s)

        if self.keep_audio_for_reprocessing:
            self._raw_audio.append(frame)

        speech = self._frame_vad.is_speech(frame)
        self._diagnostics.on_frame(
            frame,
            timestamp_s,
            gate_open=speech,
            in_utterance=self._endpointer.in_progress(),
            vad=self._frame_vad,
        )
        try:
            self._route(frame, timestamp_s, speech)
        finally:
            self._diagnostics.on_ingest_done(timestamp_s)

    def _route(self, frame: np.ndarray, timestamp_s: float, speech: bool):
        # The gate only decides where an utterance starts and ends. Everything between those points goes to
        # the recognizer, quiet frames included: soft syllables and the gaps between words are part of the
        # speech. (Until 2026-10-09 only frames above the gate were passed on, so quiet speech never reached
        # Whisper and loud speech arrived chopped into 100 ms scraps.)
        if speech:
            if not self._endpointer.in_progress():
                for held_frame, held_at in self._pre_roll:
                    self._push(held_frame, held_at)
                self._pre_roll.clear()
                self._pre_roll_s = 0.0
            signal = self._endpointer.on_speech(timestamp_s)
            self._push(frame, timestamp_s)
            if signal == EndpointSignal.FORCED_END:
                self._flush_utterance()
            return

        if self._endpointer.in_progress():
            self._push(frame, timestamp_s)
            signal = self._endpointer.on_silence(timestamp_s)
            if signal in (EndpointSignal.LIKELY_END, EndpointSignal.FORCED_END):
                self._flush_utterance()
            return

        self._hold_pre_roll(frame, timestamp_s)

    def _push(self, frame: np.ndarray, timestamp_s: float):
        self._diagnostics.on_forwarded()
        event = self._streaming_asr.push_audio(frame, timestamp_s)
        if event:
            self._emit(event)

    def _hold_pre_roll(self, frame: np.ndarray, timestamp_s: float):
        self._pre_roll.append((frame, timestamp_s))
        self._pre_roll_s += len(frame) / self.sample_rate
        while self._pre_roll and self._pre_roll_s - len(self._pre_roll[0][0]) / self.sample_rate >= PRE_ROLL_S:
            dropped, _ = self._pre_roll.popleft()
            self._pre_roll_s -= len(dropped) / self.sample_rate

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

    def drain_committed(self) -> list:
        """Committed segments not yet returned by a previous call, each exactly once, in commit order."""
        pending = self.finalized_segments[self._drained :]
        self._drained = len(self.finalized_segments)
        return pending

    def snapshot(self) -> dict:
        """Current state for a live UI/consumer. Partials are provisional and never persisted."""
        return {
            "sessionId": self.session_id,
            "state": self.state.value,
            "currentSpeaker": self.current_speaker,
            "partial": _event_to_dict(self.partial_transcript) if self.partial_transcript else None,
            "finalizedSegmentCount": len(self.finalized_segments),
        }

    def end(self):
        """Flush anything buffered and stop accepting audio. Newly committed segments are drainable afterwards."""
        if self.state == SessionState.ENDED:
            return
        self._flush_utterance()
        self.state = SessionState.ENDED
        self._diagnostics.log_summary(final=True)

    def get_raw_audio_pcm(self) -> Optional[np.ndarray]:
        """Concatenated raw PCM when keep_audio_for_reprocessing was set; None otherwise."""
        if not self._raw_audio:
            return None
        return np.concatenate(self._raw_audio)

    def transcript(self, reprocess: bool = False, diarizer=None) -> dict:
        """
        Canonical transcript for this session. Does not end the session and does not
        change committed segments. With reprocess=True and retained audio, the batch
        pipeline re-runs over the full recording; otherwise the live segments are used.
        """
        pcm = self.get_raw_audio_pcm()
        if reprocess and pcm is not None:
            from speech.pipeline import process_pcm  # local import: the batch pipeline stays optional for live use

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

    def finalize(self, reprocess: bool = True, diarizer=None) -> dict:
        """End the session, then build its transcript (kept for callers that want both steps)."""
        self.end()
        return self.transcript(reprocess=reprocess, diarizer=diarizer)


def _event_to_dict(event: TranscriptEvent) -> dict:
    return {"stage": event.stage.value, "text": event.text, "start": round(event.start, 3), "end": round(event.end, 3)}
