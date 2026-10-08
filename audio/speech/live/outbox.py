"""
Durable outbox for canonical final segments that the meeting API has not acknowledged.

Write-ahead: a segment is appended and fsynced here before any delivery attempt, so a
crash, an outage, or an API restart cannot lose it. Acknowledgements are separate
records. A segment stays pending until it has a 'delivered' or 'rejected' record.

Replay is safe because segment ids are deterministic (speech/live/ids.py): re-sending
a delivered segment yields ALREADY_EXISTS on the server, never a duplicate.

Layout: <directory>/<meeting_id>.jsonl, one JSON record per line, append-only.
Without a directory the outbox lives in memory and is NOT durable; callers report that.
"""

import json
import logging
import os
import time
from typing import Optional

from speech.live.ids import require_uuid

logger = logging.getLogger(__name__)

OUTCOMES = ("delivered", "rejected")


class OutboxError(Exception):
    """A record conflicts with what is already queued, or the file is corrupt."""


class Outbox:
    def __init__(self, directory: Optional[str] = None):
        self._directory = os.path.abspath(directory) if directory else None
        self._memory: dict = {}
        if self._directory:
            os.makedirs(self._directory, exist_ok=True)

    @property
    def durable(self) -> bool:
        return self._directory is not None

    def _path(self, meeting_id: str) -> str:
        return os.path.join(self._directory, f"{require_uuid(meeting_id, 'meeting_id')}.jsonl")

    def _records(self, meeting_id: str) -> list:
        require_uuid(meeting_id, "meeting_id")
        if self._directory is None:
            return list(self._memory.get(meeting_id, []))
        path = self._path(meeting_id)
        if not os.path.exists(path):
            return []
        with open(path, "r", encoding="utf-8") as handle:
            lines = handle.read().splitlines()
        records = []
        for index, line in enumerate(lines):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as err:
                if index == len(lines) - 1:
                    # A torn final write. Nothing acknowledged it, so dropping it is safe.
                    logger.warning("outbox: ignoring torn trailing record in %s", path)
                    break
                raise OutboxError(f"corrupt outbox record at {path}:{index + 1}") from err
        return records

    def _append(self, meeting_id: str, record: dict):
        record = {**record, "at": time.time()}
        if self._directory is None:
            self._memory.setdefault(meeting_id, []).append(record)
            return
        line = json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n"
        with open(self._path(meeting_id), "a", encoding="utf-8") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())

    def _state(self, meeting_id: str) -> dict:
        """key -> {segment, speechSessionId, outcome (None while pending), reason}, in enqueue order."""
        state: dict = {}
        for record in self._records(meeting_id):
            if record.get("op") == "enqueue":
                state[record["key"]] = {
                    "segment": record["segment"],
                    "speechSessionId": record["speechSessionId"],
                    "outcome": None,
                    "reason": None,
                }
            elif record.get("op") == "ack" and record.get("key") in state:
                state[record["key"]]["outcome"] = record["outcome"]
                state[record["key"]]["reason"] = record.get("reason")
        return state

    def enqueue(self, meeting_id: str, speech_session_id: str, segment: dict) -> str:
        """Durably records a segment before delivery. Re-queuing the same segment is a no-op."""
        key = segment["id"]
        state = self._state(meeting_id)
        if key in state:
            if state[key]["segment"] != segment:
                raise OutboxError(f"segment {key} is already queued with different content")
            return key
        self._append(
            meeting_id,
            {"op": "enqueue", "key": key, "speechSessionId": speech_session_id, "segment": segment},
        )
        return key

    def acknowledge(self, meeting_id: str, key: str, outcome: str, reason: Optional[str] = None):
        if outcome not in OUTCOMES:
            raise ValueError(f"outcome must be one of {OUTCOMES}")
        self._append(meeting_id, {"op": "ack", "key": key, "outcome": outcome, "reason": reason})

    def entries(self, meeting_id: str, outcome: Optional[str]) -> list:
        """Entries in enqueue order. outcome=None selects pending entries."""
        return [
            {"key": key, **entry}
            for key, entry in self._state(meeting_id).items()
            if entry["outcome"] == outcome
        ]

    def pending(self, meeting_id: str) -> list:
        return self.entries(meeting_id, None)

    def meetings(self) -> list:
        """Meeting ids that have outbox records."""
        if self._directory is None:
            return sorted(self._memory)
        found = []
        for name in os.listdir(self._directory):
            if name.endswith(".jsonl"):
                try:
                    found.append(require_uuid(name[: -len(".jsonl")], "meeting_id"))
                except ValueError:
                    continue  # not one of ours
        return sorted(found)

    def backlog(self) -> dict:
        """What is waiting across every meeting: segments not stored yet (failed), segments the API
        refused (rejected, kept for inspection), and outbox files that could not be read (unreadable)."""
        failed = rejected = unreadable = 0
        meetings = self.meetings()
        for meeting_id in meetings:
            try:
                failed += len(self.pending(meeting_id))
                rejected += len(self.rejected(meeting_id))
            except (OutboxError, OSError):
                unreadable += 1
        return {"meetings": len(meetings), "failed": failed, "rejected": rejected, "unreadable": unreadable}

    def rejected(self, meeting_id: str) -> list:
        return self.entries(meeting_id, "rejected")
