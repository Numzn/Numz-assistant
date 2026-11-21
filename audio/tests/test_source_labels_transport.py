"""
The wire side of "you" / "others": what the transport accepts, advertises and sends, driven through the real
LiveConnection with a fake socket (the same way test_live_transport_unit.py does).

  start    {"sources": ["microphone", "tab"]}   the client says which sources are in the mix
  levels   {"type": "levels", "mic": 0.12, "tab": 0.0}   sent just before the audio frame it describes
  ready    {"sourceLevels": true}               the service says it will use them: a client sends none until then,
                                                because an older service answers any unknown message with an error
                                                the page treats as fatal
"""

import os
import unittest
from unittest import mock

import live_speech_ws
from speech.live.outbox import Outbox
from speech.live.session import LiveSpeechSession
from tests.fakes_live import silence_frames, speech_frames
from tests.test_live_transport_unit import FakeSocket, factory

START = {"type": "start", "sampleRate": 16000, "channels": 1, "format": "f32le", "language": "en"}
BOTH = ["microphone", "tab"]


class SourceLevelWireTests(unittest.TestCase):
    def setUp(self):
        self.socket = FakeSocket()
        self.connection = live_speech_ws.LiveConnection(self.socket, Outbox())
        self._factory = live_speech_ws.SESSION_FACTORY
        live_speech_ws.SESSION_FACTORY = factory(LiveSpeechSession)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("LIVE_SOURCE_LABELS", None)

    def tearDown(self):
        live_speech_ws.SESSION_FACTORY = self._factory

    def start(self, **extra):
        self.connection.handle_control({**START, **extra})
        (ready,) = self.socket.of_type("ready")
        return ready

    def say(self, mic, tab, silence=(0.0, 0.0)):
        """One utterance (1 s of speech, then 0.8 s of silence), each frame preceded by its levels message."""
        for frame in speech_frames(10):
            self.connection.handle_control({"type": "levels", "mic": mic, "tab": tab})
            self.connection.ingest(frame.tobytes())
        for frame in silence_frames(8):
            self.connection.handle_control({"type": "levels", "mic": silence[0], "tab": silence[1]})
            self.connection.ingest(frame.tobytes())

    def finals(self):
        return [f["segment"] for f in self.socket.of_type("transcript", state="FINAL")]

    def test_a_client_that_mixes_both_sources_is_told_levels_are_wanted(self):
        self.assertIs(self.start(sources=BOTH)["sourceLevels"], True)

    def test_a_line_is_labelled_from_the_levels_sent_with_its_frames(self):
        self.start(sources=BOTH)
        self.say(mic=0.2, tab=0.0)
        self.say(mic=0.0, tab=0.2)
        self.assertEqual([(s["speaker"], s["uncertain"]) for s in self.finals()], [("you", False), ("others", False)])
        self.assertEqual(self.socket.of_type("error"), [])

    def test_an_overlapping_line_is_sent_unlabelled_and_uncertain(self):
        self.start(sources=BOTH)
        self.say(mic=0.1, tab=0.1)
        ((segment),) = self.finals()
        self.assertEqual((segment["speaker"], segment["uncertain"]), (None, True))
        self.assertEqual(segment["text"], "utt 1")

    def test_every_final_line_says_whether_its_speaker_is_uncertain(self):
        self.start()  # no sources: the default labelling, as before
        self.say(mic=None, tab=None)
        ((segment),) = self.finals()
        self.assertEqual(set(segment), {"id", "start", "end", "speaker", "text", "uncertain"})
        self.assertEqual((segment["speaker"], segment["uncertain"]), ("speaker_00", False))

    def test_without_sources_nothing_changes_and_levels_are_ignored_quietly(self):
        self.assertIs(self.start()["sourceLevels"], False)
        self.say(mic=0.2, tab=0.0)  # a client that sends them anyway is not an error
        self.assertEqual(self.socket.of_type("error"), [])
        ((segment),) = self.finals()
        self.assertEqual((segment["speaker"], segment["uncertain"]), ("speaker_00", False))

    def test_one_source_is_not_enough_to_label_anything(self):
        for sources in (["microphone"], ["tab"], [], "microphone,tab", None, [1, 2], ["microphone", "tab", "other"]):
            with self.subTest(sources=sources):
                connection = live_speech_ws.LiveConnection(FakeSocket(), Outbox())
                connection.handle_control({**START, "sources": sources})
                (ready,) = connection.ws.of_type("ready")
                self.assertIs(ready["sourceLevels"], False)

    def test_the_switch_turns_labels_off_even_for_a_client_that_asks(self):
        for value in ("0", "false", "OFF", "no"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {"LIVE_SOURCE_LABELS": value}):
                connection = live_speech_ws.LiveConnection(FakeSocket(), Outbox())
                connection.handle_control({**START, "sources": BOTH})
                self.assertIs(connection.ws.of_type("ready")[0]["sourceLevels"], False)
        with mock.patch.dict(os.environ, {"LIVE_SOURCE_LABELS": "1"}):
            connection = live_speech_ws.LiveConnection(FakeSocket(), Outbox())
            connection.handle_control({**START, "sources": BOTH})
            self.assertIs(connection.ws.of_type("ready")[0]["sourceLevels"], True)

    def test_levels_before_start_are_refused_like_any_other_control(self):
        self.connection.handle_control({"type": "levels", "mic": 0.1, "tab": 0.1})
        (error,) = self.socket.of_type("error")
        self.assertEqual(error["code"], "no-active-session")

    def test_levels_that_are_not_numbers_are_ignored_and_the_line_stays_unlabelled(self):
        self.start(sources=BOTH)
        for frame in speech_frames(10) + silence_frames(8):
            self.connection.handle_control({"type": "levels", "mic": "loud", "tab": [1]})
            self.connection.handle_control({"type": "levels"})
            self.connection.ingest(frame.tobytes())
        self.assertEqual(self.socket.of_type("error"), [])
        ((segment),) = self.finals()
        self.assertEqual((segment["speaker"], segment["uncertain"]), (None, True))

    def test_levels_describe_the_next_frame_only(self):
        self.start(sources=BOTH)
        frame = speech_frames(1)[0].tobytes()
        self.connection.handle_control({"type": "levels", "mic": 0.2, "tab": 0.0})
        self.connection.ingest(frame)
        self.connection.ingest(frame)  # no levels for this one
        self.assertEqual(len(self.connection.session._diarizer), 1)

    def test_levels_for_a_frame_that_is_dropped_are_dropped_with_it(self):
        self.start(sources=BOTH)
        self.connection.handle_control({"type": "levels", "mic": 0.2, "tab": 0.0})
        self.connection.handle_control({"type": "pause"})
        self.connection.ingest(speech_frames(1)[0].tobytes())  # paused: the frame is ignored
        self.connection.handle_control({"type": "resume"})
        self.connection.ingest(speech_frames(1)[0].tobytes())  # must not inherit the earlier levels
        self.assertEqual(len(self.connection.session._diarizer), 0)

        self.connection.handle_control({"type": "levels", "mic": 0.2, "tab": 0.0})
        self.connection.ingest(b"\x00\x00\x00")  # not a whole number of samples: refused
        self.connection.ingest(speech_frames(1)[0].tobytes())
        self.assertEqual(len(self.connection.session._diarizer), 0)

    def test_a_failure_in_noting_levels_never_breaks_the_audio_path(self):
        self.start(sources=BOTH)
        with mock.patch.object(self.connection.session, "note_source_levels", side_effect=RuntimeError("boom")):
            self.connection.handle_control({"type": "levels", "mic": 0.2, "tab": 0.0})
            self.connection.ingest(speech_frames(1)[0].tobytes())
        self.assertEqual([e["code"] for e in self.socket.of_type("error")], [])


if __name__ == "__main__":
    unittest.main()
