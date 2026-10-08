"""
Regression tests for the transport's finalization and ingest failure paths, driven through the real
LiveConnection with a fake socket. A committed segment must never disappear because a later step fails.
"""

import json
import tempfile
import unittest

import live_speech_ws
from speech.live.outbox import Outbox
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


if __name__ == "__main__":
    unittest.main()
