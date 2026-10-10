"""
The replay tool (replay_cli.py). Runs without the Whisper model: a scripted recognizer and a fake clock
stand in for it, so these tests check what the tool measures and reports, not how well Whisper hears.
"""

import contextlib
import io
import json
import os
import stat
import tempfile
import unittest
import wave

import numpy as np

import replay_cli
from speech.audio_io import write_wav
from tests.fakes_live import EnergyVad, ScriptedAsr, silence_frames, speech_frames

FRAME_S = 0.1


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.slept = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept += seconds
        self.now += seconds


class SlowAsr(ScriptedAsr):
    """A recognizer whose final decode costs `cost_s` of (fake) wall time."""

    def __init__(self, clock, cost_s):
        super().__init__(prefix="utt")
        self._clock, self._cost = clock, cost_s

    def flush(self):
        event = super().flush()
        if event is not None:
            self._clock.now += self._cost
        return event


def three_utterances():
    frames = []
    for _ in range(3):
        frames += speech_frames(10) + silence_frames(8)
    return frames  # 5.4 s, three utterances


class ReplayTests(unittest.TestCase):
    def test_every_utterance_becomes_a_line_and_the_audio_is_measured(self):
        clock = FakeClock()
        result = replay_cli.replay(
            three_utterances(), streaming_asr=ScriptedAsr("utt"), frame_vad=EnergyVad(), clock=clock, sleep=clock.sleep
        )
        self.assertEqual(result["audioS"], 5.4)
        self.assertEqual(result["segmentCount"], 3)
        self.assertEqual(result["text"], "utt 1 utt 2 utt 3")
        self.assertEqual([s["index"] for s in result["segments"]], [0, 1, 2])
        self.assertEqual(result["diagnostics"]["frames"]["received"], 54)

    def test_without_pacing_it_does_not_wait_and_reports_no_lag(self):
        clock = FakeClock()
        result = replay_cli.replay(
            three_utterances(), streaming_asr=ScriptedAsr("utt"), frame_vad=EnergyVad(), pace=0, clock=clock, sleep=clock.sleep
        )
        self.assertEqual(clock.slept, 0)
        self.assertIsNone(result["lagS"], "lag against a schedule that does not exist would be a made-up number")
        self.assertIsNone(result["commitLagS"])
        self.assertNotIn("lagS", result["diagnostics"], "the wall-clock lag the session measures is not meaningful here")

    def test_at_real_time_pace_the_audio_arrives_at_the_speed_of_a_microphone(self):
        clock = FakeClock()
        result = replay_cli.replay(
            three_utterances(), streaming_asr=ScriptedAsr("utt"), frame_vad=EnergyVad(), pace=1, clock=clock, sleep=clock.sleep
        )
        self.assertAlmostEqual(clock.slept, 5.4, places=6, msg="waited for each frame to be due")
        self.assertEqual(result["lagS"], {"max": 0.0, "last": 0.0}, "a recognizer that costs nothing is never late")

    def test_a_slow_decode_makes_later_audio_late_and_shows_in_the_lag(self):
        clock = FakeClock()
        result = replay_cli.replay(
            three_utterances(), streaming_asr=SlowAsr(clock, cost_s=4.0), frame_vad=EnergyVad(), pace=1, clock=clock, sleep=clock.sleep
        )
        self.assertGreaterEqual(result["lagS"]["max"], 4.0)
        self.assertGreater(result["lagS"]["last"], 4.0, "three 4 s decodes in 5.4 s of audio fall further behind")
        self.assertEqual(result["segmentCount"], 3, "being late loses nothing")
        self.assertGreater(result["commitLagS"]["max"], 4.0)
        self.assertLess(result["speedX"], 1.0, "slower than real time")

    def test_pace_two_delivers_twice_as_fast(self):
        clock = FakeClock()
        replay_cli.replay(three_utterances(), streaming_asr=ScriptedAsr("utt"), frame_vad=EnergyVad(), pace=2, clock=clock, sleep=clock.sleep)
        self.assertAlmostEqual(clock.slept, 2.7, places=6)


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._dir.cleanup()

    def path(self, name="a.wav"):
        return os.path.join(self._dir.name, name)

    def test_a_native_wav_streams_whole_frames_and_reports_the_dropped_tail(self):
        pcm = np.concatenate([np.full(1600, 0.25, dtype=np.float32)] * 3 + [np.full(800, 0.25, dtype=np.float32)])
        write_wav(self.path(), pcm, 16000)
        recording = replay_cli.Recording(self.path())
        frames = list(recording.frames())
        self.assertTrue(recording.native)
        self.assertEqual((len(frames), frames[0].size, frames[0].dtype), (3, 1600, np.float32))
        self.assertAlmostEqual(float(frames[0][0]), 0.25, places=3)
        self.assertAlmostEqual(recording.tail_s, 0.05)

    def test_other_formats_go_through_the_decoder(self):
        with wave.open(self.path("eight.wav"), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(b"\x00\x00" * 8000)
        asked = []

        def decoder(path):
            asked.append(path)
            return np.zeros(4000, dtype=np.float32)

        recording = replay_cli.Recording(self.path("eight.wav"), decoder=decoder)
        self.assertFalse(recording.native)
        self.assertEqual(len(list(recording.frames())), 2)
        self.assertEqual(asked, [self.path("eight.wav")])
        self.assertAlmostEqual(recording.tail_s, 800 / 16000)

    def test_a_file_that_is_not_a_wav_at_all_is_left_to_the_decoder(self):
        with open(self.path("x.mp3"), "wb") as handle:
            handle.write(b"ID3\x04\x00\x00not really")
        self.assertFalse(replay_cli.Recording(self.path("x.mp3"), decoder=lambda p: np.zeros(1600, dtype=np.float32)).native)


class MemoryGuardTests(unittest.TestCase):
    def test_available_memory_is_read_from_meminfo(self):
        with tempfile.NamedTemporaryFile("w", suffix=".meminfo", delete=False) as handle:
            handle.write("MemTotal:        7954000 kB\nMemFree:          500000 kB\nMemAvailable:    2621440 kB\n")
        try:
            self.assertEqual(replay_cli.available_memory_mb(handle.name), 2560)
        finally:
            os.unlink(handle.name)

    def test_an_unreadable_meminfo_skips_the_check_instead_of_failing(self):
        self.assertIsNone(replay_cli.available_memory_mb("/nonexistent/meminfo"))


class CommandTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.audio = os.path.join(self._dir.name, "meeting.wav")
        write_wav(self.audio, np.concatenate(three_utterances()), 16000)
        self.reference = os.path.join(self._dir.name, "ref.txt")
        with open(self.reference, "w") as handle:
            handle.write("Utt 1, utt 2. Utt 3")

    def tearDown(self):
        self._dir.cleanup()

    def run_cli(self, *argv, **kwargs):
        out = io.StringIO()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = replay_cli.run(
                list(argv), asr_factory=lambda: ScriptedAsr("utt"), vad_factory=EnergyVad, nice=0, out=out, **kwargs
            )
        return code, out.getvalue(), err.getvalue()

    def test_it_scores_against_a_reference_and_writes_a_private_json_report(self):
        report = os.path.join(self._dir.name, "out.json")
        code, out, _ = self.run_cli(self.audio, "--reference", self.reference, "--json", report)
        self.assertEqual(code, 0)
        self.assertIn("WER 0.0", out)
        self.assertIn("3 lines", out)
        self.assertIn("host while replaying", out)
        with open(report) as handle:
            payload = json.load(handle)
        self.assertEqual(payload["score"]["wer"], 0.0)
        self.assertEqual(payload["segmentCount"], 3)
        self.assertEqual(payload["audio"], "meeting.wav", "the file name, not the directory it lived in")
        self.assertEqual(set(payload["host"]), {"load1", "cpus", "memAvailableMb", "niceness"}, "the conditions are recorded")
        self.assertEqual(stat.S_IMODE(os.stat(report).st_mode), 0o600, "the report holds the transcript")

    def test_a_wrong_transcript_is_scored_as_errors_not_hidden(self):
        with open(self.reference, "w") as handle:
            handle.write("utt 1 utt 9 utt 3 and something more")
        code, out, _ = self.run_cli(self.audio, "--reference", self.reference)
        self.assertEqual(code, 0)
        self.assertIn("1 substituted", out)
        self.assertIn("3 deleted", out)  # "and something more" was never heard

    def test_bad_input_is_refused_with_exit_code_2(self):
        self.assertEqual(self.run_cli(os.path.join(self._dir.name, "missing.wav"))[0], 2)
        self.assertEqual(self.run_cli(self.audio, "--pace", "-1")[0], 2)
        empty = os.path.join(self._dir.name, "empty.txt")
        open(empty, "w").close()
        code, _, err = self.run_cli(self.audio, "--reference", empty)
        self.assertEqual(code, 2)
        self.assertIn("no words", err)

    def test_it_refuses_to_load_a_second_model_when_memory_is_short(self):
        saved = replay_cli.available_memory_mb
        replay_cli.available_memory_mb = lambda *a, **k: 500
        try:
            out = io.StringIO()
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = replay_cli.run([self.audio], nice=0, out=out)  # no injected recognizer: the real one would load
            self.assertEqual(code, 3)
            self.assertIn("refusing to start", err.getvalue())
            self.assertEqual(out.getvalue(), "", "it did not start")
        finally:
            replay_cli.available_memory_mb = saved


if __name__ == "__main__":
    unittest.main()
