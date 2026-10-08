import io
import json
import tempfile
import unittest
import urllib.error

from speech.live.health import PersistenceMonitor, origin_of, probe_meeting_api
from speech.live.outbox import Outbox

MEETING = "00000000-0000-4000-8000-000000000001"
URL = "http://127.0.0.1:3103"


class Answer(io.BytesIO):
    def __init__(self, body):
        super().__init__(json.dumps(body).encode("utf-8") if not isinstance(body, bytes) else body)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class FakeNetwork:
    """A scripted meeting API health endpoint that counts how often it is asked."""

    def __init__(self, outcome):
        self.outcome = outcome
        self.calls = 0

    def __call__(self, request, timeout):
        self.calls += 1
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return Answer(self.outcome)


READY = {"ok": True, "meetings": {"ready": True, "schemaVersion": 3, "auth": {"admin": True, "tickets": True}}}
NOT_READY = {"ok": True, "meetings": {"ready": False, "auth": {"admin": False, "tickets": False}, "problem": "x"}}


class PersistenceStatusTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.outbox = Outbox(self._dir.name)
        self.now = 1000.0

    def tearDown(self):
        self._dir.cleanup()

    def monitor(self, network, url=URL, outbox=None):
        return PersistenceMonitor(lambda: url, outbox or self.outbox, opener=network, clock=lambda: self.now, ttl_s=30)

    def test_unset_url_is_disabled_and_says_what_is_refused(self):
        status = self.monitor(FakeNetwork(READY), url="").status()
        self.assertEqual((status["state"], status["configured"]), ("disabled", False))
        self.assertIn("MEETING_API_URL is unset", status["problem"])
        self.assertIsNone(status["meetingApi"])

    def test_a_ready_meeting_api_and_an_empty_outbox_is_ok(self):
        status = self.monitor(FakeNetwork(READY)).status()
        self.assertEqual(status["state"], "ok")
        self.assertEqual(status["outbox"], {"meetings": 0, "failed": 0, "rejected": 0, "unreadable": 0})
        self.assertEqual(status["meetingApi"], {"reachable": True, "ready": True, "code": None})

    def test_each_way_to_be_misconfigured_is_named(self):
        cases = [
            (urllib.error.URLError("connection refused"), "unreachable", "cannot be reached"),
            (urllib.error.HTTPError(URL, 404, "nf", {}, io.BytesIO(b"")), "http-404", "without /api/v1"),
            (b"<html>not json</html>", "not-the-meeting-api", "is not the meeting API"),
            ({"ok": True}, "not-the-meeting-api", "is not the meeting API"),
            (NOT_READY, "server-auth-not-configured", "are not set"),
        ]
        for outcome, code, words in cases:
            with self.subTest(code=code):
                status = self.monitor(FakeNetwork(outcome)).status()
                self.assertEqual(status["state"], "misconfigured")
                self.assertEqual(status["meetingApi"]["code"], code)
                self.assertIn(words, status["problem"])

    def test_waiting_or_refused_segments_make_it_degraded(self):
        segment = {"id": "seg_1", "start": 0, "end": 1, "text": "x", "uncertain": False}
        self.outbox.enqueue(MEETING, "11111111-1111-4111-8111-111111111111", segment)
        status = self.monitor(FakeNetwork(READY)).status()
        self.assertEqual(status["state"], "degraded")
        self.assertEqual(status["outbox"]["failed"], 1)
        self.assertIn("1 segment(s) not stored yet", status["problem"])

        self.outbox.acknowledge(MEETING, "seg_1", "rejected", reason="invalid-segment")
        status = self.monitor(FakeNetwork(READY)).status()
        self.assertEqual((status["outbox"]["failed"], status["outbox"]["rejected"], status["state"]), (0, 1, "degraded"))

    def test_a_memory_only_outbox_is_degraded_because_nothing_survives_a_stop(self):
        status = self.monitor(FakeNetwork(READY), outbox=Outbox(None)).status()
        self.assertEqual(status["state"], "degraded")
        self.assertIn("not durable", status["problem"])

    def test_an_unreadable_outbox_file_is_reported_not_hidden(self):
        with open(f"{self._dir.name}/{MEETING}.jsonl", "w", encoding="utf-8") as handle:
            handle.write('{"op":"enqueue"\nnot json\n{"op":"ack"}\n')  # corruption that is not a torn final write
        status = self.monitor(FakeNetwork(READY)).status()
        self.assertEqual(status["outbox"]["unreadable"], 1)
        self.assertEqual(status["state"], "degraded")

    def test_the_probe_is_cached_and_refreshed_after_the_ttl(self):
        network = FakeNetwork(READY)
        monitor = self.monitor(network)
        monitor.status()
        monitor.status()
        self.assertEqual(network.calls, 1, "health polling must not hammer the meeting API")
        self.now += 31
        monitor.status()
        self.assertEqual(network.calls, 2)
        monitor_with_new_url = PersistenceMonitor(lambda: "http://other:1", self.outbox, opener=network, clock=lambda: self.now)
        monitor_with_new_url.status()
        self.assertEqual(network.calls, 3, "a different URL is never answered from another URL's cache")

    def test_only_the_origin_is_reported_never_credentials_or_paths(self):
        url = "http://user:hunter2@127.0.0.1:3103/api/v1?token=abc"
        status = self.monitor(FakeNetwork(READY), url=url).status()
        text = json.dumps(status)
        self.assertEqual(status["apiOrigin"], "http://127.0.0.1:3103")
        for secret in ("hunter2", "token=abc", "user:"):
            self.assertNotIn(secret, text)
        self.assertEqual(origin_of("not a url"), None)

    def test_the_probe_never_raises_into_health(self):
        for failure in (RuntimeError("boom"), TimeoutError("slow"), ConnectionResetError("reset")):
            with self.subTest(failure=type(failure).__name__):
                result = probe_meeting_api(URL, FakeNetwork(failure), 1)
                self.assertEqual((result["reachable"], result["ready"], result["code"]), (False, False, "unreachable"))


if __name__ == "__main__":
    unittest.main()
