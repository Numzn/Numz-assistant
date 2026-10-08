"""
Delivers canonical final segments to the meeting API with explicit outcomes.

  INSERTED       - the API answered 201 and reported status INSERTED: stored now.
  ALREADY_EXISTS - the API answered 200 and reported status ALREADY_EXISTS: an identical segment
                   was already stored (a safe duplicate delivery).
  REJECTED       - a permanent refusal: 400 invalid, 404 unknown session or meeting, 409 segment-id
                   conflict or meeting not accepting transcript. Quarantined in the outbox with the
                   reason; never retried automatically.
  FAILED         - not stored: unreachable, timeout, 5xx, credentials refused (401/403/503), or an
                   answer that does not explicitly say INSERTED or ALREADY_EXISTS. The segment stays
                   in the outbox and flush() retries it. It is never reported as saved.

A bare HTTP 200 or 201 proves nothing. A segment counts as persisted only when the answer names
INSERTED (with 201) or ALREADY_EXISTS (with 200), so a response such as `inserted: false` without an
explicit duplicate is FAILED, not success.

Every segment is written to the outbox before the first attempt (write-ahead).
Credentials: a meeting ticket, sent as a Bearer token. The transport never holds the admin token.
"""

import json
import math
import time
import urllib.error
import urllib.request
from typing import NamedTuple, Optional

from speech.live.ids import require_uuid
from speech.live.outbox import OutboxError

INSERTED = "INSERTED"
ALREADY_EXISTS = "ALREADY_EXISTS"
REJECTED = "REJECTED"
FAILED = "FAILED"

PERSISTED = (INSERTED, ALREADY_EXISTS)
OUTCOMES = (INSERTED, ALREADY_EXISTS, REJECTED, FAILED)


class PersistenceUnavailable(Exception):
    """The meeting API cannot be reached or refuses this ticket right now. Transient."""


class PersistenceRejected(Exception):
    """The meeting API permanently refused the request (for example, unknown meeting)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class PersistOutcome(NamedTuple):
    state: str  # INSERTED | ALREADY_EXISTS | REJECTED | FAILED
    segment_id: Optional[str]
    code: Optional[str]  # why, for REJECTED and FAILED; None when the segment is persisted

    @property
    def persisted(self) -> bool:
        return self.state in PERSISTED


def segment_problem(segment) -> Optional[str]:
    """Reason a segment must never reach the API, or None. Mirrors the server-side validation."""
    if not isinstance(segment, dict):
        return "segment must be an object"
    if not isinstance(segment.get("id"), str) or not segment["id"]:
        return "segment.id is required"
    start, end = segment.get("start"), segment.get("end")
    if not (isinstance(start, (int, float)) and isinstance(end, (int, float))):
        return "start and end must be numbers"
    if not (math.isfinite(start) and math.isfinite(end)) or start < 0 or end < start:
        return "timestamps must satisfy 0 <= start <= end"
    if not isinstance(segment.get("text"), str) or not segment["text"].strip():
        return "text must be a non-empty string"
    if not isinstance(segment.get("uncertain"), bool):
        return "uncertain must be a boolean"
    return None


def persisted_state(http_status: int, body) -> Optional[str]:
    """The persisted state an answer explicitly proves (INSERTED or ALREADY_EXISTS), else None."""
    reported = body.get("status") if isinstance(body, dict) else None
    if http_status == 201 and reported == INSERTED:
        return INSERTED
    if http_status == 200 and reported == ALREADY_EXISTS:
        return ALREADY_EXISTS
    return None


def _decode(raw: bytes) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"raw": raw[:200].decode("utf-8", errors="replace")}
    return value if isinstance(value, dict) else {"value": value}


class MeetingPersistence:
    def __init__(
        self,
        base_url: str,
        meeting_id: str,
        ticket: str,
        outbox,
        *,
        timeout_s: float = 3.0,
        inline_attempts: int = 2,
        backoff_s: float = 0.25,
        sleep=time.sleep,
        opener=urllib.request.urlopen,
    ):
        if not ticket:
            raise ValueError("a meeting ticket is required")
        self._base = base_url.rstrip("/")
        self._meeting_id = require_uuid(meeting_id, "meeting_id")
        self._ticket = ticket
        self._outbox = outbox
        self._timeout = timeout_s
        self._attempts = max(1, inline_attempts)
        self._backoff = backoff_s
        self._sleep = sleep
        self._opener = opener

    @property
    def meeting_id(self) -> str:
        return self._meeting_id

    def _request(self, method: str, path: str, body: dict):
        request = urllib.request.Request(
            f"{self._base}{path}",
            data=json.dumps(body).encode("utf-8"),
            method=method,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self._ticket}"},
        )
        try:
            with self._opener(request, timeout=self._timeout) as response:
                return response.status, _decode(response.read())
        except urllib.error.HTTPError as err:
            return err.code, _decode(err.read())
        # Anything else (URLError, timeout, reset) is an OSError and propagates as transient.

    def open_session(self) -> dict:
        """Attaches a new speech session to the meeting. Returns the server's session record."""
        last_code = "unreachable"
        for _ in range(self._attempts):
            try:
                status, body = self._request("POST", f"/api/v1/meetings/{self._meeting_id}/sessions", {})
            except OSError:
                self._sleep(self._backoff)
                continue
            if status == 201:
                return body
            code = body.get("code") or f"http-{status}"
            if status in (400, 404, 409):
                raise PersistenceRejected(code)
            if status in (401, 403, 503):
                raise PersistenceUnavailable(f"meeting API refused the ticket ({code})")
            last_code = code
            self._sleep(self._backoff)
        raise PersistenceUnavailable(f"meeting API unavailable ({last_code})")

    def persist(self, speech_session_id: str, segment: dict) -> PersistOutcome:
        """Write-ahead queue, then one delivery attempt cycle. Returns the explicit outcome."""
        segment_id = segment.get("id") if isinstance(segment, dict) else None
        problem = segment_problem(segment)
        if problem is not None or not isinstance(segment_id, str):
            if isinstance(segment_id, str) and segment_id:
                # Keyed and invalid: quarantine durably with the reason, never send it.
                self._quarantine(speech_session_id, segment, f"invalid-segment: {problem}")
            return PersistOutcome(REJECTED, segment_id if isinstance(segment_id, str) else None, "invalid-segment")
        try:
            key = self._outbox.enqueue(self._meeting_id, speech_session_id, segment)
        except OutboxError as err:
            return PersistOutcome(REJECTED, segment_id, f"local-id-conflict: {err}")
        return self._deliver({"key": key, "speechSessionId": speech_session_id, "segment": segment})

    def _quarantine(self, speech_session_id: str, segment: dict, reason: str):
        try:
            key = self._outbox.enqueue(self._meeting_id, speech_session_id, segment)
            self._outbox.acknowledge(self._meeting_id, key, "rejected", reason=reason)
        except (OutboxError, OSError):
            pass  # the caller still surfaces the rejection to the client; nothing is sent

    def _deliver(self, entry: dict) -> PersistOutcome:
        key = entry["key"]
        body = {"speechSessionId": entry["speechSessionId"], "segment": entry["segment"]}
        path = f"/api/v1/meetings/{self._meeting_id}/transcript/final"
        last_code = "unreachable"
        for _ in range(self._attempts):
            try:
                status, response = self._request("POST", path, body)
            except OSError:
                self._sleep(self._backoff)
                continue
            if status in (200, 201):
                state = persisted_state(status, response)
                if state is None:
                    # A 2xx that does not say INSERTED (201) or ALREADY_EXISTS (200) proves nothing was
                    # stored. Retrying cannot change a deterministic answer: keep the segment, say so.
                    return PersistOutcome(FAILED, key, "unexpected-response")
                self._outbox.acknowledge(self._meeting_id, key, "delivered", reason=state)
                return PersistOutcome(state, key, None)
            code = response.get("code") or f"http-{status}"
            if status in (400, 404, 409):
                self._outbox.acknowledge(self._meeting_id, key, "rejected", reason=code)
                return PersistOutcome(REJECTED, key, code)
            if status in (401, 403):
                # Retrying cannot fix credentials: stop now and keep the segment pending.
                return PersistOutcome(FAILED, key, code)
            last_code = code
            self._sleep(self._backoff)
        return PersistOutcome(FAILED, key, last_code)

    def flush(self) -> dict:
        """Retries every pending segment for this meeting, including ones from earlier sessions."""
        counts = {state: 0 for state in OUTCOMES}
        for entry in self._outbox.pending(self._meeting_id):
            counts[self._deliver(entry).state] += 1
        return counts

    def end_session(self, speech_session_id: str, reason: str, committed_segments: Optional[int] = None) -> dict:
        """Ends the speech session. committed_segments is how many final segments this session produced,
        so the API can tell a complete transcript from one with segments still missing."""
        path = f"/api/v1/meetings/{self._meeting_id}/sessions/{require_uuid(speech_session_id)}/end"
        body = {"reason": reason}
        if committed_segments is not None:
            body["committedSegments"] = int(committed_segments)
        try:
            status, response = self._request("POST", path, body)
        except OSError:
            return {"ok": False, "code": "unreachable"}
        return {"ok": status == 200, "status": status, "code": response.get("code")}
