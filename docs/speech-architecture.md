# Speech and Meeting Intelligence Architecture

## Scope

This document describes the current Speech / Meeting Intelligence subsystem. The general voice assistant and Three.js renderer are separate consumers and are not part of this subsystem's domain model.

## Current canonical flow

```text
Audio input
  -> live WebSocket or batch file ingestion
  -> frame/file decoding and validation
  -> live frame VAD + endpointing, or batch VAD metadata
  -> ASR adapter
  -> optional alignment
  -> optional diarization
  -> reconciliation
  -> canonical transcript schema 1.0
  -> grounded notes or rolling intelligence
```

The canonical transcript is the source of truth. Partial ASR hypotheses are provisional; generated intelligence is derived and must retain evidence references.

## Existing module ownership

| Responsibility | Current implementation |
|---|---|
| Batch ingestion and decoding | `audio/transcribe.py`, `audio/speech/audio_io.py` |
| Batch VAD | `audio/speech/vad.py` |
| Batch ASR adapter | `audio/speech/asr.py` |
| Alignment contract | `audio/speech/alignment.py` |
| Diarization contract/backends | `audio/speech/diarization.py` |
| Batch reconciliation | `audio/speech/reconcile.py` |
| Batch orchestration | `audio/speech/pipeline.py` |
| Live frame VAD | `audio/speech/live/frame_vad.py` |
| Live endpointing | `audio/speech/live/endpointing.py` |
| Live streaming ASR | `audio/speech/live/streaming_asr.py` |
| Live hypothesis events | `audio/speech/live/events.py` |
| Live hypothesis reconciliation | `audio/speech/reconciler.py` |
| Live session lifecycle | `audio/speech/live/session.py` |
| Live transport | `audio/live_speech_ws.py` |
| Grounded notes | `server/services/speechNotesService.js` |
| Rolling intelligence seam | `server/services/rollingIntelligenceService.js` |

The live transport may persist final segments through the Node meeting API when
started with a `meetingId` and configured `MEETING_API_URL`; it remains usable as
a standalone transport when those settings are absent.

## Contract rules

- `audio/speech/schema.py` is the only canonical transcript shape.
- `validate_transcript()` must be called before a transcript crosses into persistence or intelligence processing.
- `TranscriptReconciler` owns provisional live hypothesis state and stable canonical segment IDs.
- Only `TranscriptStage.FINAL` creates a canonical segment.
- VAD, ASR, diarization, and transport implementations are injected into pipeline/session owners where practical.
- Diarization is optional. Unknown and overlap attribution remain valid outcomes.

## Current production gaps

The following are intentionally still future milestones rather than hidden behavior:

- persistent meeting, transcript, speaker, and intelligence repositories
- authenticated meeting and speech APIs
- reconnect/resume protocol with idempotency keys
- bounded queues and backpressure policy
- rolling intelligence connected to the live transport
- separate final-intelligence job and validated report schema
- structured metrics and correlation IDs across Python and Node
- retention, deletion, export, and access-control policies
- comprehensive integration, failure, and performance suites

The next vertical slice should add persistent meeting/session ownership without introducing a second transcript format.
