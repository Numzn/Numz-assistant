"""
The live gate (speech/live/frame_vad.py): it must open on quiet speech, follow the room's noise, not chatter
on steady noise, and not cut a quiet sentence in two.

Until 2026-10-09 the gate was an absolute floor (-34, then -42 dBFS). Speech into a laptop microphone is
often quieter than that, and the paste of a real 124-line meeting showed the result: cut-off words,
fragments and missing sentence starts. These tests use synthetic signals (tones, seeded white noise, hum),
so they prove the gate's logic; the real-Whisper measurements are in test_real_audio_gate.py.
"""

import os
import unittest
from unittest import mock

import numpy as np

from speech.live.frame_vad import DEFAULT_MIN_THRESHOLD_DBFS, MIN_DBFS_ENV, FrameVad, FrameVadConfig

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1600  # 100 ms
FRAMES_PER_S = 10
# 3 s of steady sound is declared noise, plus a little margin.
STEADY_NOISE_RELEASED_BY_FRAME = 45


def level(dbfs):
    return 10 ** (dbfs / 20)


def tone(dbfs):
    t = np.arange(FRAME_SAMPLES) / SAMPLE_RATE
    return (np.sin(2 * np.pi * 220 * t) * level(dbfs) * np.sqrt(2)).astype(np.float32)


def white(rng, dbfs):
    return (rng.standard_normal(FRAME_SAMPLES) * level(dbfs)).astype(np.float32)


def hum(rng, hum_dbfs, hiss_dbfs, hz=50):
    t = np.arange(FRAME_SAMPLES) / SAMPLE_RATE
    wave = np.sin(2 * np.pi * hz * t) * level(hum_dbfs) * np.sqrt(2)
    return (wave + rng.standard_normal(FRAME_SAMPLES) * level(hiss_dbfs)).astype(np.float32)


def flags(vad, frames):
    return [vad.is_speech(frame) for frame in frames]


def quiet_room(seconds=5, dbfs=-63, seed=1):
    """A gate that has listened to a quiet room (about -63 dBFS hiss) for a few seconds."""
    rng = np.random.default_rng(seed)
    vad = FrameVad()
    flags(vad, [white(rng, dbfs) for _ in range(int(seconds * FRAMES_PER_S))])
    return vad


class QuietSpeechOpensTheGate(unittest.TestCase):
    def test_speech_the_old_gate_refused_opens_it_in_a_quiet_room(self):
        # The old gate needed about -42 dBFS. Laptop-microphone speech is often well below that.
        for dbfs in (-44, -48, -52):
            with self.subTest(dbfs=dbfs):
                self.assertTrue(quiet_room().is_speech(tone(dbfs)))

    def test_it_does_not_open_on_the_room_itself_or_just_above_it(self):
        vad = quiet_room()
        self.assertFalse(vad.is_speech(tone(-63)))
        self.assertFalse(vad.is_speech(tone(-58)))  # under the minimum of -56 dBFS

    def test_the_threshold_follows_the_room(self):
        rng = np.random.default_rng(2)
        noisy = FrameVad()
        flags(noisy, [white(rng, -50) for _ in range(100)])  # a room at -50 dBFS
        self.assertFalse(noisy.is_speech(tone(-46)), "4 dB above the room is not speech")
        self.assertTrue(noisy.is_speech(tone(-38)), "12 dB above the room is")

    def test_the_floor_comes_back_down_when_the_room_goes_quiet(self):
        rng = np.random.default_rng(3)
        vad = FrameVad()
        flags(vad, [white(rng, -50) for _ in range(100)])
        flags(vad, [white(rng, -66) for _ in range(150)])
        self.assertTrue(vad.is_speech(tone(-52)))


class Hysteresis(unittest.TestCase):
    # In the quiet room the gate opens above ~-55 dBFS and closes below ~-59 dBFS.
    DIP = tone(-57)

    def test_a_dip_inside_an_utterance_does_not_close_it(self):
        vad = quiet_room()
        self.assertTrue(vad.is_speech(tone(-40)))
        for _ in range(8):  # 800 ms of a very soft word tail
            self.assertTrue(vad.is_speech(self.DIP))

    def test_the_same_level_does_not_open_it_from_closed(self):
        vad = quiet_room()
        for _ in range(8):
            self.assertFalse(vad.is_speech(self.DIP))

    def test_it_closes_once_the_level_really_drops(self):
        vad = quiet_room()
        vad.is_speech(tone(-40))
        self.assertFalse(vad.is_speech(tone(-70)))


class MinimumThreshold(unittest.TestCase):
    def test_default_is_the_experimental_minus_56_dbfs(self):
        self.assertEqual(FrameVadConfig().min_threshold_dbfs, DEFAULT_MIN_THRESHOLD_DBFS)
        self.assertEqual(DEFAULT_MIN_THRESHOLD_DBFS, -56.0)

    def test_digital_silence_opens_only_above_the_minimum(self):
        vad = FrameVad()
        for _ in range(20):
            vad.is_speech(np.zeros(FRAME_SAMPLES, dtype=np.float32))
        self.assertFalse(FrameVad().is_speech(tone(-58)))
        self.assertTrue(FrameVad().is_speech(tone(-54)))

    def test_the_minimum_is_configurable(self):
        strict = FrameVadConfig(min_threshold_dbfs=-50)
        self.assertFalse(FrameVad(strict).is_speech(tone(-53)))
        self.assertTrue(FrameVad(strict).is_speech(tone(-47)))

    def test_it_can_be_set_from_the_environment(self):
        with mock.patch.dict(os.environ, {MIN_DBFS_ENV: "-50"}):
            self.assertEqual(FrameVadConfig().min_threshold_dbfs, -50.0)
            self.assertFalse(FrameVad().is_speech(tone(-53)))

    def test_nonsense_in_the_environment_falls_back_to_the_default(self):
        for bad in ("loud", "-5", "-120", "nan"):
            with self.subTest(value=bad), mock.patch.dict(os.environ, {MIN_DBFS_ENV: bad}):
                with self.assertLogs("speech.live.frame_vad", level="WARNING"):
                    self.assertEqual(FrameVadConfig().min_threshold_dbfs, DEFAULT_MIN_THRESHOLD_DBFS)


class SteadyNoiseIsNotSpeech(unittest.TestCase):
    def run_noise(self, make_frame, seconds=60):
        rng = np.random.default_rng(4)
        return flags(FrameVad(), [make_frame(rng) for _ in range(seconds * FRAMES_PER_S)])

    def test_white_noise_at_room_levels(self):
        for dbfs in (-70, -63, -60, -54, -50, -46, -40):
            with self.subTest(dbfs=dbfs):
                result = self.run_noise(lambda rng: white(rng, dbfs))
                self.assertEqual(sum(result[STEADY_NOISE_RELEASED_BY_FRAME:]), 0, "closed and stays closed")
                if dbfs <= -60:
                    self.assertEqual(sum(result), 0, "a quiet room never opens it")
                else:
                    self.assertLessEqual(sum(result), STEADY_NOISE_RELEASED_BY_FRAME, "at most the first seconds")

    def test_mains_hum_with_hiss(self):
        for hz in (50, 60):
            with self.subTest(hz=hz):
                result = self.run_noise(lambda rng: hum(rng, -52, -66, hz))
                self.assertEqual(sum(result[STEADY_NOISE_RELEASED_BY_FRAME:]), 0)

    def test_a_fan_switching_on_mid_session(self):
        rng = np.random.default_rng(5)
        vad = FrameVad()
        flags(vad, [white(rng, -63) for _ in range(50)])
        fan = flags(vad, [white(rng, -48) for _ in range(300)])
        self.assertEqual(sum(fan[STEADY_NOISE_RELEASED_BY_FRAME:]), 0, "the fan is learned as the new floor")
        self.assertTrue(vad.is_speech(tone(-36)), "speech over the fan still opens it")

    def test_a_room_that_slowly_gets_louder(self):
        rng = np.random.default_rng(6)
        vad = FrameVad()
        ramp = [white(rng, -66 + 16 * i / 600) for i in range(600)]  # 60 s, 16 dB
        self.assertEqual(sum(flags(vad, ramp)), 0)


class SpeechIsNotMistakenForNoise(unittest.TestCase):
    def speech_like(self, rng, low_dbfs, high_dbfs, seconds=30):
        # Frame levels vary the way syllables do: several dB from one 100 ms frame to the next.
        return [tone(float(rng.uniform(low_dbfs, high_dbfs))) for _ in range(int(seconds * FRAMES_PER_S))]

    def test_continuous_loud_speech_stays_open_for_its_whole_length(self):
        rng = np.random.default_rng(7)
        result = flags(quiet_room(), self.speech_like(rng, -48, -28))
        self.assertEqual(sum(result), len(result))

    def test_continuous_quiet_speech_is_not_chopped(self):
        rng = np.random.default_rng(8)
        result = flags(quiet_room(), self.speech_like(rng, -54, -44))
        self.assertGreaterEqual(sum(result) / len(result), 0.99)

    def test_quiet_speech_with_pauses_opens_each_time(self):
        rng = np.random.default_rng(9)
        vad = quiet_room()
        for _ in range(5):
            self.assertTrue(all(flags(vad, self.speech_like(rng, -52, -44, seconds=2))))
            self.assertFalse(any(flags(vad, [white(rng, -63) for _ in range(10)])))


if __name__ == "__main__":
    unittest.main()
