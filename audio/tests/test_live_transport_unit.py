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


class DiagnosticsFailToBuild(LiveSpeechSession):
    def diagnostics_summary(self):
        raise RuntimeError("diagnostics broke")


class DiagnosticsNotSerialisable(LiveSpeechSession):
    def diagnostics_summary(self):
        return {"session": self.session_id, "oops": object()}


class StoppedFrameDiagnosticsTests(unittest.TestCase):
    """The stopped frame carries the session's numbers, so a meeting's behaviour can be read from the meeting
    itself instead of from a log file. It must never carry text, and it must never cost the client `stopped`."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._saved = (live_speech_ws.SESSION_FACTORY, live_speech_ws.MEETING_API_URL, live_speech_ws.MeetingPersistence)

    def tearDown(self):
        live_speech_ws.SESSION_FACTORY, live_speech_ws.MEETING_API_URL, live_speech_ws.MeetingPersistence = self._saved
        self._dir.cleanup()

    def run_session(self, session_cls, control=None):
        live_speech_ws.SESSION_FACTORY = factory(session_cls)
        socket = FakeSocket()
        connection = live_speech_ws.LiveConnection(socket, Outbox(self._dir.name))
        connection.start({"sampleRate": 16000, "channels": 1, "format": "f32le", **(control or {})})
        speak(connection)
        connection.finish("stopped")
        return socket, socket.of_type("stopped")[0]

    def test_the_stopped_frame_carries_the_session_numbers(self):
        socket, stopped = self.run_session(LiveSpeechSession)
        diagnostics = stopped["diagnostics"]
        self.assertEqual(diagnostics["session"], socket.of_type("ready")[0]["sessionId"])
        self.assertTrue(diagnostics["final"], "the summary is the end-of-session one")
        self.assertEqual(diagnostics["frames"]["received"], 18, "10 speech frames and 8 of silence were ingested")
        self.assertIn("levelDbfs", diagnostics)
        self.assertIn("decodes", diagnostics)
        self.assertNotIn("meeting", diagnostics, "a standalone session has no meeting to name")

    def test_the_frame_holds_numbers_and_ids_only_never_transcript_text(self):
        socket, stopped = self.run_session(LiveSpeechSession)
        committed_text = socket.of_type("transcript", state="FINAL")[0]["segment"]["text"]
        self.assertTrue(committed_text)
        self.assertNotIn(committed_text, json.dumps(stopped["diagnostics"]))

        def leaves(value):
            if isinstance(value, dict):
                for item in value.values():
                    yield from leaves(item)
            else:
                yield value

        strings = [leaf for leaf in leaves(stopped["diagnostics"]) if isinstance(leaf, str)]
        self.assertEqual(strings, [stopped["diagnostics"]["session"]], "the only string in it is the session id")

    def test_a_meeting_bound_session_names_its_meeting(self):
        class FakePersistence:
            def __init__(self, base_url, meeting_id, ticket, outbox):
                self.meeting_id = meeting_id

            def open_session(self):
                return {"speechSessionId": "11111111-1111-4111-8111-111111111111", "timelineOffsetMs": 0}

            def flush(self):
                return {}

            def persist(self, speech_session_id, segment):
                return PersistOutcome(INSERTED, segment["id"], None)

            def end_session(self, speech_session_id, reason, committed_segments=None):
                return {"ok": True}

        live_speech_ws.MEETING_API_URL = "http://127.0.0.1:1"
        live_speech_ws.MeetingPersistence = FakePersistence
        _, stopped = self.run_session(LiveSpeechSession, {"meetingId": MEETING, "meetingTicket": "ticket"})
        self.assertEqual(stopped["diagnostics"]["meeting"], MEETING)
        self.assertEqual(stopped["persistence"]["meetingBound"], True)

    def test_diagnostics_that_fail_to_build_still_deliver_stopped(self):
        with self.assertLogs("live_speech_ws", level="ERROR"):
            _, stopped = self.run_session(DiagnosticsFailToBuild)
        self.assertIsNone(stopped["diagnostics"])
        self.assertEqual(stopped["persistence"]["committed"], 1, "the persistence summary still arrives")

    def test_diagnostics_that_cannot_be_serialised_do_not_swallow_the_frame(self):
        # _send() ignores a send failure by design (the durable state is in the outbox), so an unserialisable
        # value inside the frame would otherwise make the client wait for a 'stopped' that never comes.
        with self.assertLogs("live_speech_ws", level="ERROR"):
            socket, stopped = self.run_session(DiagnosticsNotSerialisable)
        self.assertIsNone(stopped["diagnostics"])
        self.assertEqual(len(socket.of_type("stopped")), 1)


if __name__ == "__main__":
    unittest.main()
