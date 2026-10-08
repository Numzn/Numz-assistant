import unittest
import uuid

from speech.live.session import LiveSpeechSession
from tests.fakes_live import EnergyVad, ScriptedAsr, feed, silence_frames, speech_frames

SESSION_A = "11111111-1111-4111-8111-111111111111"
SESSION_B = "22222222-2222-4222-8222-222222222222"


def make_session(speech_session_id=None, prefix="utt"):
    return LiveSpeechSession(
        speech_session_id=speech_session_id,
        streaming_asr=ScriptedAsr(prefix=prefix),
        frame_vad=EnergyVad(),
    )


class LiveSessionIdentityTests(unittest.TestCase):
    def test_session_identity_is_a_uuid_and_bad_values_are_refused(self):
        session = make_session(SESSION_A)
        self.assertEqual(session.session_id, SESSION_A)
        generated = make_session()
        self.assertEqual(str(uuid.UUID(generated.session_id)), generated.session_id)
        with self.assertRaises(ValueError):
            make_session("not-a-uuid")

    def test_two_sessions_of_one_meeting_never_share_a_segment_id(self):
        a = make_session(SESSION_A, prefix="a")
        b = make_session(SESSION_B, prefix="b")
        position_a = feed(a, speech_frames(10) + silence_frames(8), 0.0)
        position_b = feed(b, speech_frames(10) + silence_frames(8), 0.0)
        a.end()
        b.end()
        ids_a = [s["id"] for s in a.finalized_segments]
        ids_b = [s["id"] for s in b.finalized_segments]
        self.assertTrue(ids_a and ids_b)
        self.assertEqual(set(ids_a) & set(ids_b), set(), "per-session counters must not collide")
        self.assertGreater(position_a, 0)
        self.assertGreater(position_b, 0)

    def test_the_same_session_and_sequence_always_yields_the_same_id(self):
        first = make_session(SESSION_A)
        feed(first, speech_frames(10) + silence_frames(8), 0.0)
        first.end()
        second = make_session(SESSION_A)
        feed(second, speech_frames(10) + silence_frames(8), 0.0)
        second.end()
        self.assertEqual(
            [s["id"] for s in first.finalized_segments],
            [s["id"] for s in second.finalized_segments],
            "a retried session re-derives identical ids, so the server can recognise duplicates",
        )


class LiveSessionDrainTests(unittest.TestCase):
    def test_each_committed_segment_is_drained_exactly_once(self):
        session = make_session(SESSION_A)
        position = feed(session, speech_frames(10) + silence_frames(8), 0.0)
        first = session.drain_committed()
        self.assertEqual(len(first), 1)
        self.assertEqual(session.drain_committed(), [], "nothing is returned twice")

        position = feed(session, speech_frames(10) + silence_frames(8), position)
        session.end()
        second = session.drain_committed()
        self.assertEqual(len(second), 1)
        self.assertNotEqual(first[0]["id"], second[0]["id"])
        self.assertGreater(position, 0)

    def test_committed_segments_are_available_without_any_finalization_step(self):
        session = make_session(SESSION_A)
        feed(session, speech_frames(10) + silence_frames(8), 0.0)
        drained = session.drain_committed()
        self.assertEqual(len(drained), 1, "the transport can persist before (or instead of) building a transcript")

    def test_building_a_transcript_does_not_end_or_change_the_session(self):
        session = make_session(SESSION_A)
        feed(session, speech_frames(10) + silence_frames(8), 0.0)
        before = [s["id"] for s in session.finalized_segments]
        transcript = session.transcript()
        self.assertEqual(transcript["schemaVersion"], "1.0")
        self.assertEqual(session.state.value, "listening")
        self.assertEqual([s["id"] for s in session.finalized_segments], before)

    def test_finalize_still_ends_and_returns_a_valid_transcript(self):
        session = make_session(SESSION_A)
        feed(session, speech_frames(10) + silence_frames(8), 0.0)
        transcript = session.finalize(reprocess=False)
        self.assertEqual(session.state.value, "ended")
        self.assertEqual(len(transcript["segments"]), 1)


if __name__ == "__main__":
    unittest.main()
