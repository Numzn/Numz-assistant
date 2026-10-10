"""
Opt-in capture of a session's audio (so a real meeting can be replayed and scored later).

It is a diagnostic aid for a host with little memory and a user in the room, so what these tests pin down is
restraint: nothing is written unless BOTH the operator and the client opt in, the audio is streamed to disk
and not held in memory, files are private, and no problem with it can reach the meeting as an error.
"""

import json
import os
import stat
import tempfile
import unittest
import wave

import numpy as np

import live_speech_ws
from speech.audio_io import WavWriter
from speech.live.outbox import Outbox
from speech.live.session import LiveSpeechSession
from tests.fakes_live import EnergyVad, ScriptedAsr, silence_frames, speech_frames

START = {"sampleRate": 16000, "channels": 1, "format": "f32le"}


class FakeSocket:
    def __init__(self):
        self.frames = []

    def send(self, data):
        self.frames.append(json.loads(data))

    def close(self):
        pass

    def of_type(self, kind):
        return [f for f in self.frames if f.get("type") == kind]


def make_session(**kwargs):
    return LiveSpeechSession(streaming_asr=ScriptedAsr(prefix="utt"), frame_vad=EnergyVad(), **kwargs)


def read_wav(path):
    with wave.open(path) as wav:
        params = (wav.getnchannels(), wav.getsampwidth(), wav.getframerate())
        return params, np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")


class WavWriterTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._dir.name, "a.wav")

    def tearDown(self):
        self._dir.cleanup()

    def test_what_is_written_reads_back_as_16_bit_mono_wav(self):
        writer = WavWriter(self.path, 16000)
        writer.write(np.full(1600, 0.5, dtype=np.float32))
        writer.write(np.full(1600, -0.25, dtype=np.float32))
        writer.close()
        params, samples = read_wav(self.path)
        self.assertEqual(params, (1, 2, 16000))
        self.assertEqual(samples.size, 3200)
        self.assertAlmostEqual(samples[0] / 32767, 0.5, places=3)
        self.assertAlmostEqual(samples[-1] / 32767, -0.25, places=3)

    def test_the_file_is_valid_after_every_write_even_if_the_process_never_closes_it(self):
        writer = WavWriter(self.path, 16000)
        writer.write(np.zeros(1600, dtype=np.float32))
        writer.write(np.zeros(1600, dtype=np.float32))
        # not closed: a crash here must still leave a playable file with the right length
        params, samples = read_wav(self.path)
        self.assertEqual((params, samples.size), ((1, 2, 16000), 3200))
        writer.close()

    def test_it_is_private_and_refuses_to_overwrite(self):
        writer = WavWriter(self.path, 16000)
        writer.close()
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            WavWriter(self.path, 16000)

    def test_out_of_range_and_non_finite_samples_do_not_corrupt_it(self):
        writer = WavWriter(self.path, 16000)
        writer.write(np.array([2.0, -2.0, np.nan, np.inf], dtype=np.float32))
        writer.close()
        _, samples = read_wav(self.path)
        self.assertEqual(list(samples[:2]), [32767, -32767])
        self.assertEqual(samples.size, 4)

    def test_close_is_idempotent_and_a_closed_recording_refuses_writes(self):
        writer = WavWriter(self.path, 16000)
        writer.close()
        writer.close()
        with self.assertRaises(ValueError):
            writer.write(np.zeros(10, dtype=np.float32))


class CaptureOptInTests(unittest.TestCase):
    def setUp(self):
        self._outbox_dir = tempfile.TemporaryDirectory()
        self._recordings = tempfile.TemporaryDirectory()
        self.recordings_dir = os.path.join(self._recordings.name, "recordings")  # not created yet
        self._saved = (live_speech_ws.SESSION_FACTORY, live_speech_ws.RECORDINGS_DIR)
        live_speech_ws.SESSION_FACTORY = make_session

    def tearDown(self):
        live_speech_ws.SESSION_FACTORY, live_speech_ws.RECORDINGS_DIR = self._saved
        self._outbox_dir.cleanup()
        self._recordings.cleanup()

    def connect(self, recordings_dir, **control):
        live_speech_ws.RECORDINGS_DIR = recordings_dir
        socket = FakeSocket()
        connection = live_speech_ws.LiveConnection(socket, Outbox(self._outbox_dir.name))
        connection.start({**START, **control})
        return connection, socket

    def speak(self, connection, speech=10, silence=8):
        for frame in speech_frames(speech) + silence_frames(silence):
            connection.ingest(frame.tobytes())

    def files(self):
        return os.listdir(self.recordings_dir) if os.path.isdir(self.recordings_dir) else []

    # ---- two opt-ins ---------------------------------------------------------------

    def test_a_client_that_asks_is_ignored_when_the_operator_set_no_directory(self):
        connection, socket = self.connect("", saveRecording=True)
        self.speak(connection)
        connection.finish("stopped")
        self.assertIs(socket.of_type("ready")[0]["recording"], False)
        self.assertNotIn("recordingPath", (socket.of_type("stopped")[0]["transcript"] or {}).get("meta", {}))
        self.assertEqual(self.files(), [])

    def test_an_operator_directory_alone_records_nothing(self):
        connection, socket = self.connect(self.recordings_dir)  # the client did not ask
        self.speak(connection)
        connection.finish("stopped")
        self.assertIs(socket.of_type("ready")[0]["recording"], False)
        self.assertFalse(os.path.exists(self.recordings_dir), "not even the directory is created")

    # ---- what is recorded ----------------------------------------------------------

    def test_both_opt_ins_record_exactly_what_the_recognizer_received(self):
        connection, socket = self.connect(self.recordings_dir, saveRecording=True)
        self.assertIs(socket.of_type("ready")[0]["recording"], True)
        self.speak(connection, speech=10, silence=8)
        connection.finish("stopped")

        session_id = socket.of_type("ready")[0]["sessionId"]
        path = os.path.join(self.recordings_dir, f"{session_id}.wav")
        params, samples = read_wav(path)
        self.assertEqual(params, (1, 2, 16000))
        self.assertEqual(samples.size, 18 * 1600, "every frame, and nothing else")
        self.assertEqual(socket.of_type("stopped")[0]["transcript"]["meta"]["recordingPath"], path)

    def test_frames_dropped_while_paused_are_not_recorded(self):
        connection, _ = self.connect(self.recordings_dir, saveRecording=True)
        self.speak(connection, speech=5, silence=0)
        connection.handle_control({"type": "pause"})
        self.speak(connection, speech=5, silence=0)  # dropped by the transport
        connection.handle_control({"type": "resume"})
        self.speak(connection, speech=2, silence=0)
        connection.finish("stopped")
        (name,) = self.files()
        _, samples = read_wav(os.path.join(self.recordings_dir, name))
        self.assertEqual(samples.size, 7 * 1600)

    def test_a_dropped_connection_still_leaves_a_complete_file(self):
        connection, socket = self.connect(self.recordings_dir, saveRecording=True)
        self.speak(connection, speech=6, silence=0)
        connection.finish("disconnected")  # what the route handler does when the socket goes away
        (name,) = self.files()
        _, samples = read_wav(os.path.join(self.recordings_dir, name))
        self.assertEqual(samples.size, 6 * 1600)

    def test_the_audio_is_streamed_to_disk_not_held_in_memory(self):
        connection, _ = self.connect(self.recordings_dir, saveRecording=True)
        self.speak(connection)
        self.assertIsNone(connection.session.get_raw_audio_pcm(), "no in-memory copy of the meeting's audio")
        connection.finish("stopped")

    def test_the_directory_and_file_are_private(self):
        connection, _ = self.connect(self.recordings_dir, saveRecording=True)
        self.speak(connection, speech=2, silence=0)
        connection.finish("stopped")
        self.assertEqual(stat.S_IMODE(os.stat(self.recordings_dir).st_mode), 0o700)
        (name,) = self.files()
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.recordings_dir, name)).st_mode), 0o600)

    # ---- it must never disturb the meeting -----------------------------------------

    def test_a_directory_that_cannot_be_created_does_not_stop_the_session(self):
        blocker = os.path.join(self._recordings.name, "not-a-directory")
        open(blocker, "w").close()
        with self.assertLogs("live_speech_ws", level="ERROR"):
            connection, socket = self.connect(os.path.join(blocker, "recordings"), saveRecording=True)
        self.assertIs(socket.of_type("ready")[0]["recording"], False, "the flag tells the truth")
        self.speak(connection)
        connection.finish("stopped")
        self.assertEqual(len([f for f in socket.frames if f.get("state") == "FINAL"]), 1, "transcription carried on")
        self.assertEqual(socket.of_type("error"), [], "an error frame would stop the browser's microphone")

    def test_a_write_failure_midway_is_logged_not_sent_and_does_not_stop_the_session(self):
        connection, socket = self.connect(self.recordings_dir, saveRecording=True)
        self.speak(connection, speech=3, silence=0)

        def broken(_frame):
            raise OSError("no space left on device")

        connection.recorder.write = broken
        with self.assertLogs("live_speech_ws", level="ERROR"):
            self.speak(connection, speech=7, silence=8)
        connection.finish("stopped")
        self.assertEqual(socket.of_type("error"), [], "never an error frame")
        self.assertEqual(len([f for f in socket.frames if f.get("state") == "FINAL"]), 1, "transcription carried on")
        self.assertEqual(len(socket.of_type("stopped")), 1)


if __name__ == "__main__":
    unittest.main()
