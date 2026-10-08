"""
Regression tests for the transport's finalization and ingest failure paths, driven through the real
LiveConnection with a fake socket. A committed segment must never disappear because a later step fails.
"""

import json
import tempfile
import unittest

import live_speech_ws
from speech.live.outbox import Outbox
from speech.live.persistence import ALREADY_EXISTS, FAILED, INSERTED, REJECTED, PersistOutcome
from speech.live.session import LiveSpeechSession
from tests.fakes_live import EnergyVad, ScriptedAsr, silence_frames, speech_frames


class FakeSocket:
    def __init__(self):
        self.frames = []

    def send(self, data):
        self.frames.append(json.loads(data))

    def close(self):
        pass

    def of_type(self, kind, **match):
        return [f for f in self.frames if f.get("type") == kind and all(f.get(k) == v for k, v in match.items())]


class TranscriptBuildFails(LiveSpeechSession):
    """Finalization fails after segments were committed (the transcript document cannot be built)."""

    def transcript(self, reprocess=False, diarizer=None):
        raise ValueError("transcript validation failed")


class IngestFailsAfterCommit(LiveSpeechSession):
    """The decoder commits an utterance and then raises on the same call."""

    def ingest_audio_frame(self, frame, timestamp_s):
        super().ingest_audio_frame(frame, timestamp_s)
        raise RuntimeError("decoder failed after the commit")


def factory(session_cls):
    def make(**kwargs):
        return session_cls(streaming_asr=ScriptedAsr(prefix="utt"), frame_vad=EnergyVad(), **kwargs)

    return make


def speak(connection):
    for frame in speech_frames(10) + silence_frames(8):
        connection.ingest(frame.tobytes())


class FinalizationFailureTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._saved_factory = live_speech_ws.SESSION_FACTORY

    def tearDown(self):
        live_speech_ws.SESSION_FACTORY = self._saved_factory
        self._dir.cleanup()

    def connection(self, session_cls):
        live_speech_ws.SESSION_FACTORY = factory(session_cls)
        socket = FakeSocket()
        connection = live_speech_ws.LiveConnection(socket, Outbox(self._dir.name))
        connection.start({"sampleRate": 16000, "channels": 1, "format": "f32le"})
        return connection, socket

    def test_a_failed_transcript_build_keeps_the_committed_segment_and_says_so(self):
        connection, socket = self.connection(TranscriptBuildFails)
        speak(connection)
        self.assertEqual(len(socket.of_type("transcript", state="FINAL")), 1, "the utterance was committed and announced")

        connection.finish("stopped")

        stopped = socket.of_type("stopped")
        self.assertEqual(len(stopped), 1, "the session still ends and reports")
        self.assertIsNone(stopped[0]["transcript"], "no document is produced when it cannot be validated")
        self.assertEqual(stopped[0]["error"], "transcript-invalid", "the failure is explicit, not silent")
        self.assertTrue(socket.of_type("error", code="transcript-invalid"))
        self.assertEqual(len(socket.of_type("transcript", state="FINAL")), 1, "the segment is not duplicated or dropped")

    def test_a_decoder_failure_after_a_commit_still_persists_that_commit(self):
        connection, socket = self.connection(IngestFailsAfterCommit)
        speak(connection)

        finals = socket.of_type("transcript", state="FINAL")
        self.assertEqual(len(finals), 1, "the commit made before the failure is delivered to the client")
        self.assertTrue(socket.of_type("error", code="asr-failure"), "the failure itself is reported")
        self.assertEqual(finals[0]["persisted"], "NOT_PERSISTED", "standalone mode never claims a save")

    def test_stop_after_a_failed_ingest_does_not_resend_or_drop_anything(self):
        connection, socket = self.connection(IngestFailsAfterCommit)
        speak(connection)
        connection.finish("stopped")
        finals = socket.of_type("transcript", state="FINAL")
        self.assertEqual(len({f["segment"]["id"] for f in finals}), len(finals), "each committed segment is announced once")
        self.assertEqual(len(socket.of_type("stopped")), 1)


MEETING = "00000000-0000-4000-8000-000000000001"


class ScriptedPersistence:
    """Stands in for MeetingPersistence: scripted outcomes, a real outbox, and a record of the end-of-session report."""

    def __init__(self, outbox, *outcomes):
        self.outbox = outbox
        self.outcomes = list(outcomes)
        self.ended = []

    def persist(self, speech_session_id, segment):
        outcome = self.outcomes.pop(0)
        if outcome.state == FAILED:
            self.outbox.enqueue(MEETING, speech_session_id, segment)  # a failed segment stays queued
        return outcome

    def flush(self):
        return {}

    def end_session(self, speech_session_id, reason, committed_segments=None):
        self.ended.append((reason, committed_segments))
        return {"ok": True}


class PersistenceReportingTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._saved_factory = live_speech_ws.SESSION_FACTORY

    def tearDown(self):
        live_speech_ws.SESSION_FACTORY = self._saved_factory
        self._dir.cleanup()

    def test_every_outcome_is_reported_distinctly_and_counted_once(self):
        live_speech_ws.SESSION_FACTORY = factory(LiveSpeechSession)
        socket = FakeSocket()
        outbox = Outbox(self._dir.name)
        connection = live_speech_ws.LiveConnection(socket, outbox)
        connection.start({"sampleRate": 16000, "channels": 1, "format": "f32le"})
        scripted = ScriptedPersistence(
            outbox,
            PersistOutcome(INSERTED, "seg_a", None),
            PersistOutcome(ALREADY_EXISTS, "seg_b", None),
            PersistOutcome(FAILED, "seg_c", "http-503"),
            PersistOutcome(REJECTED, None, "invalid-segment"),  # refused before it had a usable id
        )
        connection.persistence = scripted
        connection.meeting_id = MEETING

        for _ in range(4):
            speak(connection)
        connection.finish("stopped")

        self.assertEqual(
            [f["persisted"] for f in socket.of_type("transcript", state="FINAL")],
            ["INSERTED", "ALREADY_EXISTS", "FAILED", "REJECTED"],
        )
        self.assertTrue(socket.of_type("error", code="persistence-failure"), "a failed segment is explained")
        self.assertTrue(socket.of_type("error", code="segment-rejected"), "a rejected segment is explained")
        summary = socket.of_type("stopped")[0]["persistence"]
        self.assertEqual(
            summary,
            {
                "meetingBound": True,
                "durable": True,
                "committed": 4,
                "inserted": 1,
                "alreadyExists": 1,
                "rejected": 1,  # counted once, even though it never had an id
                "failed": 1,  # the retry backlog: seg_c is still queued
            },
        )
        self.assertEqual(scripted.ended, [("stopped", 4)], "the API is told how many segments were committed")


if __name__ == "__main__":
    unittest.main()
