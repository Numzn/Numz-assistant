import contextlib
import io
import json
import tempfile
import unittest

import outbox_cli
from speech.live.outbox import Outbox
from tests.test_live_persistence import MEETING, SESSION, FakeApi, segment

TICKET = "ticket-must-never-be-printed"
OTHER_MEETING = "00000000-0000-4000-8000-000000000002"


class OutboxCliTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.outbox = Outbox(self._dir.name)

    def tearDown(self):
        self._dir.cleanup()

    def env(self, **extra):
        return {"LIVE_OUTBOX_DIR": self._dir.name, "MEETING_API_URL": "http://api.test", "MEETING_TICKET": TICKET, **extra}

    def run_cli(self, argv, opener=None, **env):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err):
            code = outbox_cli.main(argv, env=self.env(**env), out=out, opener=opener or FakeApi())
        return code, out.getvalue(), err.getvalue()

    def queue(self, meeting, seg_id, outcome=None, reason=None):
        self.outbox.enqueue(meeting, SESSION, segment(seg_id))
        if outcome:
            self.outbox.acknowledge(meeting, seg_id, outcome, reason=reason)

    def test_status_shows_what_is_waiting_or_refused_per_meeting_without_any_network_call(self):
        self.queue(MEETING, "seg_waiting")
        self.queue(MEETING, "seg_done", "delivered", "INSERTED")
        self.queue(OTHER_MEETING, "seg_refused", "rejected", "invalid-segment")
        api = FakeApi()
        code, out, _ = self.run_cli(["status"], opener=api)
        report = json.loads(out)
        by_meeting = {m["meetingId"]: m for m in report["meetings"]}
        self.assertEqual((by_meeting[MEETING]["failed"], by_meeting[MEETING]["rejected"]), (1, 0))
        self.assertEqual(by_meeting[OTHER_MEETING]["rejectedReasons"], {"invalid-segment": 1})
        self.assertEqual(api.requests, [], "status is read-only and offline")
        self.assertEqual(code, 1, "something is waiting or refused, so the exit code says so")

    def test_status_of_an_empty_outbox_is_clean(self):
        code, out, _ = self.run_cli(["status"])
        self.assertEqual((code, json.loads(out)["meetings"]), (0, []))

    def test_replay_delivers_the_waiting_segments_and_reports_it(self):
        self.queue(MEETING, "seg_1")
        self.queue(MEETING, "seg_2")
        api = FakeApi(("ok", 201, {"status": "INSERTED"}), ("ok", 200, {"status": "ALREADY_EXISTS"}))
        code, out, _ = self.run_cli(["replay", MEETING], opener=api)
        result = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual((result["inserted"], result["alreadyExists"], result["stillWaiting"]), (1, 1, 0))
        self.assertEqual([r["auth"] for r in api.requests], [f"Bearer {TICKET}"] * 2)
        self.assertEqual(self.outbox.pending(MEETING), [])

    def test_replay_keeps_what_the_api_cannot_take_and_exits_nonzero(self):
        self.queue(MEETING, "seg_1")
        api = FakeApi(("unreachable", 0, {}), ("unreachable", 0, {}))
        code, out, _ = self.run_cli(["replay", MEETING], opener=api)
        self.assertEqual((code, json.loads(out)["stillWaiting"]), (1, 1))
        self.assertEqual(len(self.outbox.pending(MEETING)), 1, "never dropped")

    def test_replay_quarantines_a_refusal_and_says_so(self):
        self.queue(MEETING, "seg_1")
        code, out, _ = self.run_cli(["replay", MEETING], opener=FakeApi(("ok", 409, {"code": "meeting-not-accepting-transcript"})))
        result = json.loads(out)
        self.assertEqual((code, result["rejectedNow"], result["quarantinedTotal"]), (1, 1, 1))

    def test_replay_needs_url_and_ticket_and_never_prints_the_ticket(self):
        for missing in ("MEETING_API_URL", "MEETING_TICKET"):
            with self.subTest(missing=missing):
                code, out, err = self.run_cli(["replay", MEETING], **{missing: ""})
                self.assertEqual(code, 2)
                self.assertIn("MEETING_TICKET", err)
        code, out, err = self.run_cli(["replay", MEETING])
        self.assertNotIn(TICKET, out + err)

    def test_replay_refuses_a_bad_meeting_id(self):
        code, _, err = self.run_cli(["replay", "../../etc/passwd"])
        self.assertEqual(code, 2)
        self.assertIn("UUID", err)


if __name__ == "__main__":
    unittest.main()
