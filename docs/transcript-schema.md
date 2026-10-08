# Canonical Transcript Schema

The Speech / Meeting Intelligence subsystem uses `audio/speech/schema.py` as its canonical transcript contract. The current schema version is `1.0`.

## Transcript

```json
{
  "schemaVersion": "1.0",
  "source": "live-session:abc123",
  "durationS": 12.5,
  "language": "en",
  "speakers": ["speaker_00"],
  "segments": [],
  "meta": {}
}
```

## Segment

Every segment has a stable `id`, ordered timestamps, text, optional speaker attribution, optional word timestamps, and uncertainty metadata.

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

`speaker` may be a real label, `"overlap"`, or `null`. `overlap` and `null` are honest uncertain states and must not be silently converted to a guessed speaker.

## Live events

Live ASR emits `partial`, `stabilizing`, and `final` events. Partials can change and never enter `segments`. A final event is reconciled into the next stable segment ID (`seg_0001`, `seg_0002`, ...). The reconciler clears the provisional hypothesis after committing a final event.

## Validation

`validate_transcript()` rejects:

- unsupported schema versions
- missing or invalid duration
- missing or duplicate segment IDs
- invalid, reversed, or out-of-bounds timestamps
- segments that are not ordered
- non-string segment text

Validation is deliberately structural. Confidence calibration and semantic grounding belong to later processing stages.
