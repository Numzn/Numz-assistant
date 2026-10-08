# Canonical Transcript Schema

Status labels: **Implemented**, **Partially implemented**, **Planned** (see
[meeting-lifecycle.md](meeting-lifecycle.md) for the labelling rule).

The canonical contract is `audio/speech/schema.py`, schema version **`1.0`**
(**Implemented**). Batch and live-standalone transcripts use it unchanged. Meeting-stored segments
add the optional fields described below. Adding optional fields keeps version `1.0`. Any
incompatible change bumps the version.

## Transcript document — **Implemented**

```json
{
  "schemaVersion": "1.0",
  "source": "live-session:4f2b…",
  "durationS": 12.5,
  "language": "en",
  "speakers": ["speaker_00"],
  "segments": [],
  "meta": {}
}
```

`meta` records how the transcript was produced: ASR engine, diarization engine, `sourceMode`
(`live` or batch), and `finalization` (`live-only` or `reprocessed`).

## Segment — **Implemented**

```json
{
  "id": "seg_0001",
  "start": 1.2,
  "end": 4.7,
  "text": "We will deploy on Friday.",
  "speaker": "speaker_00",
  "speakerConfidence": null,
  "words": [],
  "confidence": null,
  "language": "en",
  "uncertain": false
}
```

- `speaker` may be a real label, `"overlap"`, or `null`. `overlap` and `null` are honest uncertain
  states and are never silently converted to a guessed speaker.
- `words` holds word-level timings when the ASR provides them. Times are in the same timeline as the
  segment.
- `uncertain` is required on every segment.

## Identity — **Implemented**

- Batch segment ids are sequential (`seg_0001`, …) and local to one transcript.
- Live segment ids are `seg_` + 32 hex characters: `uuid5(speechSessionId, "segment:<n>")`. They are
  unique across sessions and meetings, and a retried event re-derives the same id. See
  [meeting-lifecycle.md](meeting-lifecycle.md#segment-identity).
- Only `(meeting_id, segment_id)` is unique in storage. Order is never derived from the id.

## Meeting-stored segments — **Implemented** [`persistenceOutcomes.test.js`]

A segment written to a meeting is the canonical segment with:

| Field | Meaning |
|---|---|
| `start`, `end` | Seconds on the **meeting timeline** (not the session's own clock) |
| `timeline` | Always `"meeting"` |
| `speechSessionId` | The speech session that produced it |
| `sessionStart`, `sessionEnd` | The original session-relative times, kept for traceability |
| `words[].start`, `words[].end` | Shifted onto the meeting timeline as well |

Stored relational columns: `start_ms` and `end_ms` (integers, rounded from the meeting times),
`content_hash` (SHA-256 of the stored object's canonical JSON), and `speech_session_id`.
`segment_json` holds the object itself, so the stored form is recoverable.

## Live events — **Implemented**

The live engine emits `partial`, `stabilizing`, and `final` events. Only a **final** event becomes a
canonical segment. Partial and stabilizing text is provisional and is never stored. After a final
commit the provisional hypothesis is cleared.

## Validation — **Implemented**, two validators with different strictness

**Python `validate_transcript`** (whole transcript, applied before persistence or intelligence):

- `schemaVersion` is exactly `"1.0"`; `segments` is an array; `durationS` is a non-negative number.
- Segment `id` is a non-empty string and unique within the transcript.
- `start` and `end` are numbers with `0 <= start <= end <= durationS`.
- Segments are ordered: each `start` is at or after the previous `end`.
- `text` is a string. Empty text is allowed by this validator.

**Node `validateFinalSegment`** (each meeting write, `server/meetings/segmentValidation.js`):

- `id` matches `^[A-Za-z0-9_.:-]{1,128}$`.
- `start` and `end` are finite numbers with `0 <= start <= end <= 7 days`.
- `text` is a non-empty string of at most 8000 characters.
- `speaker` is `null` or a string of at most 64 characters.
- `uncertain` is a boolean (required). `words` is an array if present. `confidence` is a finite number
  or `null`. `language` is a string or `null`.
- The whole JSON object is at most 64 KiB.

The speech sidecar mirrors the Node rules before it sends anything (non-empty text, boolean
`uncertain`, ordered timestamps). A segment that fails them is quarantined in the outbox with its
reason and is never sent. Nothing is dropped silently.

## Compatibility — **Implemented**

- Readers must ignore unknown optional fields.
- A change that alters the meaning of an existing field requires a new `schemaVersion` and a
  migration note in this document.
