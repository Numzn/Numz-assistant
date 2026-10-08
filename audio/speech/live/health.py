"""
Makes the state of meeting persistence visible instead of silent.

A live session bound to a meeting fails loudly when persistence is misconfigured. This module answers the
earlier question, "is it set up so that it can work?", for the sidecar's /health and its startup log:

  disabled       MEETING_API_URL is unset. Standalone sessions still work; meeting-bound ones are refused.
  misconfigured  The URL is set but the meeting API is unreachable, is not the meeting API (for example the
                 URL includes /api/v1), or is up without its credentials configured.
  degraded       Persistence can work, but segments are waiting, were refused, or cannot be kept durably.
  ok             Nothing is waiting and the meeting API reported itself ready.

Only the origin of the URL and booleans are reported. No ticket, token or secret ever appears here.
"""

import json
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse


def origin_of(url: str):
    """scheme://host[:port] of a URL, without any credentials, path or query."""
    parsed = urlparse(url or "")
    if not parsed.scheme or not parsed.hostname:
        return None
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}"


def probe_meeting_api(api_url: str, opener=urllib.request.urlopen, timeout_s: float = 2.0) -> dict:
    """Asks the meeting API for its public health. Never raises."""
    request = urllib.request.Request(f"{api_url.rstrip('/')}/api/v1/health")
    try:
        with opener(request, timeout=timeout_s) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return {"reachable": True, "ready": False, "code": f"http-{err.code}"}
    except ValueError:
        # It answered, but not with JSON: something is listening there, and it is not the meeting API.
        return {"reachable": True, "ready": False, "code": "not-the-meeting-api"}
    except Exception:
        # Refused, timed out, DNS, anything else. A health probe must never raise into /health.
        return {"reachable": False, "ready": False, "code": "unreachable"}
    meetings = body.get("meetings") if isinstance(body, dict) else None
    if not isinstance(meetings, dict):
        return {"reachable": True, "ready": False, "code": "not-the-meeting-api"}
    if not meetings.get("ready"):
        return {"reachable": True, "ready": False, "code": "server-auth-not-configured"}
    return {"reachable": True, "ready": True, "code": None}


class PersistenceMonitor:
    def __init__(self, get_api_url, outbox, *, opener=urllib.request.urlopen, clock=time.monotonic, ttl_s: float = 30.0):
        self._get_api_url = get_api_url
        self._outbox = outbox
        self._opener = opener
        self._clock = clock
        self._ttl = ttl_s
        self._cache = None  # (api_url, taken_at, probe)

    def _probe(self, api_url: str) -> dict:
        now = self._clock()
        if self._cache and self._cache[0] == api_url and now - self._cache[1] < self._ttl:
            return self._cache[2]
        probe = probe_meeting_api(api_url, self._opener)
        self._cache = (api_url, now, probe)
        return probe

    def status(self) -> dict:
        api_url = (self._get_api_url() or "").rstrip("/")
        origin = origin_of(api_url)
        backlog = self._outbox.backlog()
        status = {
            "state": "ok",
            "configured": bool(api_url),
            "apiOrigin": origin,
            "outboxDurable": self._outbox.durable,
            "outbox": backlog,
            "meetingApi": None,
        }
        if not api_url:
            status.update(
                state="disabled",
                problem="MEETING_API_URL is unset: live sessions bound to a meeting are refused",
            )
            return status

        probe = self._probe(api_url)
        status["meetingApi"] = probe
        if not probe["ready"]:
            reasons = {
                "unreachable": f"the meeting API cannot be reached at {origin}",
                "server-auth-not-configured": "the meeting API is up but its MEETING_API_TOKEN / MEETING_TICKET_SECRET are not set",
            }
            status.update(
                state="misconfigured",
                problem=reasons.get(
                    probe["code"],
                    f"{origin} answered but is not the meeting API ({probe['code']}); MEETING_API_URL must be the server origin without /api/v1",
                ),
            )
        elif backlog["failed"] or backlog["rejected"] or backlog["unreadable"]:
            status.update(
                state="degraded",
                problem=(
                    f"{backlog['failed']} segment(s) not stored yet, {backlog['rejected']} refused, "
                    f"{backlog['unreadable']} unreadable outbox file(s)"
                ),
            )
        elif not self._outbox.durable:
            status.update(state="degraded", problem="the outbox is not durable: segments would be lost if this process stopped")
        return status

    def log_startup(self, logger):
        status = self.status()
        if status["state"] == "ok":
            logger.info("meeting persistence: ok (api=%s, outbox durable=%s)", status["apiOrigin"], status["outboxDurable"])
        else:
            logger.warning("meeting persistence: %s - %s", status["state"].upper(), status["problem"])
        return status
