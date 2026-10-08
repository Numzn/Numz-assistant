import json
import os
import tempfile
import unittest
import uuid

from speech.live.outbox import Outbox, OutboxError

MEETING = "00000000-0000-4000-8000-000000000001"
SESSION = "11111111-1111-4111-8111-111111111111"


def segment(seg_id="seg_1", text="hello"):
    return {"id": seg_id, "start": 0.0, "end": 1.0, "text": text, "uncertain": False, "speaker": None}


class OutboxDurabilityTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.dir = self._dir.name

    def tearDown(self):
        self._dir.cleanup()

    def test_pending_survives_reopening_the_outbox(self):
        first = Outbox(self.dir)
        first.enqueue(MEETING, SESSION, segment("seg_a"))
        first.enqueue(MEETING, SESSION, segment("seg_b", "second"))
        reopened = Outbox(self.dir)
        self.assertEqual([e["key"] for e in reopened.pending(MEETING)], ["seg_a", "seg_b"])

    def test_acknowledged_segments_leave_pending_and_stay_out_after_reopen(self):
        outbox = Outbox(self.dir)
        outbox.enqueue(MEETING, SESSION, segment("seg_a"))
        outbox.acknowledge(MEETING, "seg_a", "delivered")
        outbox.enqueue(MEETING, SESSION, segment("seg_b"))
        outbox.acknowledge(MEETING, "seg_b", "rejected", reason="segment-id-conflict")
        reopened = Outbox(self.dir)
        self.assertEqual(reopened.pending(MEETING), [])
        self.assertEqual([(e["key"], e["reason"]) for e in reopened.rejected(MEETING)], [("seg_b", "segment-id-conflict")])

    def test_requeuing_the_same_segment_is_idempotent(self):
        outbox = Outbox(self.dir)
        outbox.enqueue(MEETING, SESSION, segment("seg_a"))
        outbox.enqueue(MEETING, SESSION, segment("seg_a"))
        self.assertEqual(len(outbox.pending(MEETING)), 1)

    def test_same_key_with_different_content_is_refused_not_overwritten(self):
        outbox = Outbox(self.dir)
        outbox.enqueue(MEETING, SESSION, segment("seg_a", "original"))
        with self.assertRaises(OutboxError):
            outbox.enqueue(MEETING, SESSION, segment("seg_a", "different"))
        self.assertEqual(outbox.pending(MEETING)[0]["segment"]["text"], "original")

    def test_a_torn_final_write_is_ignored_but_corruption_elsewhere_is_loud(self):
        outbox = Outbox(self.dir)
        outbox.enqueue(MEETING, SESSION, segment("seg_a"))
        path = os.path.join(self.dir, f"{MEETING}.jsonl")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write('{"op":"enqueue","key":"seg_torn"')  # crash mid-write
        self.assertEqual([e["key"] for e in Outbox(self.dir).pending(MEETING)], ["seg_a"])

        with open(path, "w", encoding="utf-8") as handle:
            handle.write("not json\n" + json.dumps({"op": "enqueue", "key": "x", "speechSessionId": SESSION, "segment": segment("x")}) + "\n")
        with self.assertRaises(OutboxError):
            Outbox(self.dir).pending(MEETING)

    def test_meeting_ids_are_validated_so_they_cannot_escape_the_directory(self):
        outbox = Outbox(self.dir)
        with self.assertRaises(ValueError):
            outbox.enqueue("../../etc/passwd", SESSION, segment())
        self.assertEqual(os.listdir(self.dir), [])

    def test_without_a_directory_the_outbox_reports_it_is_not_durable(self):
        memory = Outbox(None)
        self.assertFalse(memory.durable)
        memory.enqueue(MEETING, SESSION, segment("seg_m"))
        self.assertEqual(len(memory.pending(MEETING)), 1)
        self.assertTrue(Outbox(self.dir).durable)


if __name__ == "__main__":
    unittest.main()
