"""
Segment identity for live transcripts.

A canonical segment id must be unique within a meeting, and a retried delivery of the
same event must produce the same id. Both come from deriving the id from the speech
session's UUID plus the event's sequence number:

  - two sessions (or two meetings) can only collide if their UUIDs collide;
  - a retry of one event re-derives the identical id, so the server can recognise it.

The sequence number is never relied on for uniqueness across sessions.
"""

import uuid

SEGMENT_ID_PREFIX = "seg_"


def new_speech_session_id() -> str:
    return str(uuid.uuid4())


def require_uuid(value, label: str = "speech_session_id") -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as err:
        raise ValueError(f"{label} must be a UUID") from err


def segment_id_for(speech_session_id: str, sequence: int) -> str:
    if not isinstance(sequence, int) or sequence < 1:
        raise ValueError("sequence must be a positive integer")
    namespace = uuid.UUID(require_uuid(speech_session_id))
    return SEGMENT_ID_PREFIX + uuid.uuid5(namespace, f"segment:{sequence}").hex
