import io
import json
import tempfile
import unittest
import urllib.error

from speech.live.outbox import Outbox
from speech.live.persistence import (
    ALREADY_EXISTS,
    FAILED,
    INSERTED,
    REJECTED,
    MeetingPersistence,
    PersistenceRejected,
    PersistenceUnavailable,
)

MEETING = "00000000-0000-4000-8000-000000000001"
SESSION = "11111111-1111-4111-8111-111111111111"
TICKET = "ticket-abc"
BASE = "http://api.test"


def segment(seg_id="seg_1", text="hello"):
    return {"id": seg_id, "start": 1.0, "end": 2.0, "text": text, "uncertain": False, "speaker": None}


class FakeResponse(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(json.dumps(body).encode("utf-8"))
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class FakeApi:
    """Replays a scripted sequence of answers and records every request it receives."""

    def __init__(self, *script):
        self.script = list(script)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append(
            {
                "url": request.full_url,
                "auth": request.get_header("Authorization"),
                "body": json.loads(request.data.decode("utf-8")) if request.data else None,
            }
        )
        step = self.script.pop(0) if self.script else ("ok", 201, {"status": "INSERTED"})
        if step[0] == "unreachable":
            raise urllib.error.URLError("connection refused")
        if step[0] == "timeout":
            raise TimeoutError("timed out")
        _, status, body = step
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "err", {}, io.BytesIO(json.dumps(body).encode("utf-8")))
        return FakeResponse(status, body)


class PersistenceOutcomeTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.outbox = Outbox(self._dir.name)
        self.sleeps = []

    def tearDown(self):
        self._dir.cleanup()

    def setUp_outbox(self):
        """A fresh outbox, for tests that exercise several independent segments."""
        self._dir.cleanup()
        self._dir = tempfile.TemporaryDirectory()
        self.outbox = Outbox(self._dir.name)

    def client(self, api, attempts=2):
        return MeetingPersistence(
            BASE, MEETING, TICKET, self.outbox, inline_attempts=attempts, backoff_s=0.01,
            sleep=self.sleeps.append, opener=api,
        )

    def test_201_inserted_is_persisted_and_acknowledged(self):
        api = FakeApi(("ok", 201, {"status": "INSERTED", "inserted": True}))
        outcome = self.client(api).persist(SESSION, segment())
        self.assertEqual(outcome.state, INSERTED)
        self.assertTrue(outcome.persisted)
        self.assertEqual(self.outbox.pending(MEETING), [])
        self.assertEqual(api.requests[0]["auth"], f"Bearer {TICKET}", "the ticket is the only credential sent")

    def test_200_already_exists_is_persisted_but_reported_as_a_duplicate(self):
        api = FakeApi(("ok", 200, {"status": "ALREADY_EXISTS", "inserted": False}))
        outcome = self.client(api).persist(SESSION, segment())
        self.assertEqual(outcome.state, ALREADY_EXISTS, "a duplicate is not the same as a new insert")
        self.assertTrue(outcome.persisted)
        self.assertEqual(self.outbox.pending(MEETING), [])

    def test_a_success_status_without_an_explicit_outcome_is_not_persistence(self):
        # HTTP 200 with inserted:false (or no status at all) proves nothing was stored.
        for http_status, body in [
            (200, {"inserted": False}),
            (200, {}),
            (201, {"inserted": True}),
            (200, {"status": "INSERTED"}),  # an insert must be a 201
            (201, {"status": "ALREADY_EXISTS"}),  # a duplicate must be a 200
            (200, {"status": "SOMETHING_ELSE"}),
        ]:
            with self.subTest(http_status=http_status, body=body):
                self.setUp_outbox()
                api = FakeApi(("ok", http_status, body))
                outcome = self.client(api, attempts=3).persist(SESSION, segment())
                self.assertEqual((outcome.state, outcome.code), (FAILED, "unexpected-response"))
                self.assertFalse(outcome.persisted)
                self.assertEqual(len(api.requests), 1, "a deterministic answer is not retried")
                self.assertEqual([e["key"] for e in self.outbox.pending(MEETING)], ["seg_1"], "kept, never acknowledged")

    def test_409_conflict_is_rejected_quarantined_and_not_retried(self):
        api = FakeApi(("ok", 409, {"error": "exists", "code": "segment-id-conflict"}))
        outcome = self.client(api).persist(SESSION, segment())
        self.assertEqual((outcome.state, outcome.code), (REJECTED, "segment-id-conflict"))
        self.assertEqual(len(api.requests), 1)
        self.assertEqual(self.outbox.rejected(MEETING)[0]["reason"], "segment-id-conflict")

    def test_transient_failures_are_retried_then_stay_pending_visibly(self):
        api = FakeApi(("unreachable", 0, {}), ("ok", 503, {"code": "auth-not-configured"}))
        outcome = self.client(api, attempts=2).persist(SESSION, segment())
        self.assertEqual(outcome.state, FAILED)
        self.assertEqual(len(api.requests), 2)
        self.assertEqual([e["key"] for e in self.outbox.pending(MEETING)], ["seg_1"], "never dropped")

    def test_a_timeout_then_success_is_persisted_on_the_retry(self):
        api = FakeApi(("timeout", 0, {}), ("ok", 201, {"status": "INSERTED"}))
        self.assertEqual(self.client(api).persist(SESSION, segment()).state, INSERTED)

    def test_refused_credentials_stop_immediately_and_keep_the_segment(self):
        api = FakeApi(("ok", 401, {"code": "auth-required"}))
        outcome = self.client(api, attempts=3).persist(SESSION, segment())
        self.assertEqual(outcome.state, FAILED)
        self.assertEqual(len(api.requests), 1, "credentials cannot be fixed by retrying")
        self.assertEqual(len(self.outbox.pending(MEETING)), 1)

    def test_invalid_segments_are_never_sent_and_are_quarantined_with_a_reason(self):
        api = FakeApi()
        bad = {"id": "seg_bad", "start": 5, "end": 1, "text": "x", "uncertain": False}
        outcome = self.client(api).persist(SESSION, bad)
        self.assertEqual((outcome.state, outcome.code), (REJECTED, "invalid-segment"))
        self.assertEqual(api.requests, [], "no network call for a locally invalid segment")
        self.assertIn("timestamps", self.outbox.rejected(MEETING)[0]["reason"])

    def test_flush_delivers_what_was_pending_once_the_api_is_back(self):
        api = FakeApi(("unreachable", 0, {}), ("unreachable", 0, {}))
        client = self.client(api)
        self.assertEqual(client.persist(SESSION, segment("seg_1")).state, FAILED)
        api.script = [("ok", 201, {"status": "INSERTED"})]
        self.assertEqual(client.flush(), {INSERTED: 1, ALREADY_EXISTS: 0, REJECTED: 0, FAILED: 0})
        self.assertEqual(client.flush(), {INSERTED: 0, ALREADY_EXISTS: 0, REJECTED: 0, FAILED: 0}, "nothing left to resend")

    def test_open_session_maps_refusals_to_rejected_and_outages_to_unavailable(self):
        self.assertRaises(PersistenceRejected, self.client(FakeApi(("ok", 404, {"code": "meeting-not-found"}))).open_session)
        self.assertRaises(PersistenceUnavailable, self.client(FakeApi(("ok", 401, {"code": "auth-required"}))).open_session)
        self.assertRaises(PersistenceUnavailable, self.client(FakeApi(("unreachable", 0, {}), ("unreachable", 0, {}))).open_session)
        session = self.client(FakeApi(("ok", 201, {"speechSessionId": SESSION, "timelineOffsetMs": 0}))).open_session()
        self.assertEqual(session["speechSessionId"], SESSION)

    def test_end_session_reports_without_raising(self):
        self.assertEqual(
            self.client(FakeApi(("ok", 200, {"status": "ENDED"}))).end_session(SESSION, "stopped")["ok"], True
        )
        self.assertEqual(
            self.client(FakeApi(("unreachable", 0, {}))).end_session(SESSION, "stopped")["code"], "unreachable"
        )

    def test_end_session_tells_the_api_how_many_segments_were_committed(self):
        api = FakeApi(("ok", 200, {}), ("ok", 200, {}))
        client = self.client(api)
        client.end_session(SESSION, "stopped", committed_segments=7)
        client.end_session(SESSION, "stopped")
        self.assertEqual(api.requests[0]["body"], {"reason": "stopped", "committedSegments": 7})
        self.assertEqual(api.requests[1]["body"], {"reason": "stopped"}, "unknown stays unknown, never 0")


if __name__ == "__main__":
    unittest.main()
