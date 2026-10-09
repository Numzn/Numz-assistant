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


class PausesAreAlsoRelativeToTheSpeech(unittest.TestCase):
    """The floor only learns from closed frames. A pause noisier than the floor learned in the first quiet
    second (auto-gain raises the noise in pauses; speech leaves a reverb tail) must still end an utterance."""

    def loud_speech(self, rng, count=30, center=-24):
        return [tone(float(rng.uniform(center - 6, center + 6))) for _ in range(count)]

    def test_a_pause_noisier_than_the_learned_floor_closes_the_gate(self):
        rng = np.random.default_rng(10)
        vad = quiet_room(dbfs=-63)  # floor learned at -63 dBFS
        self.assertTrue(all(flags(vad, self.loud_speech(rng))))
        pause = flags(vad, [white(rng, -48) for _ in range(15)])  # 15 dB above the floor, 24 dB below the speech
        self.assertEqual(pause[:2], [False, False], "closed at once, so 700 ms of pause can end the turn")
        self.assertFalse(any(pause))

    def test_dips_inside_a_sentence_do_not_close_it(self):
        rng = np.random.default_rng(11)
        vad = quiet_room(dbfs=-63)
        flags(vad, self.loud_speech(rng, 20))
        # Word tails 10 to 16 dB under the speaker's level, several in a row: the same sentence.
        dips = [tone(-34), tone(-37), tone(-40), tone(-36), tone(-39), tone(-40)]
        self.assertTrue(all(flags(vad, dips)))

    def test_quiet_speech_is_still_governed_by_the_floor_not_by_its_own_level(self):
        rng = np.random.default_rng(12)
        vad = quiet_room(dbfs=-63)
        quiet = [tone(float(rng.uniform(-52, -44))) for _ in range(30)]
        self.assertTrue(all(flags(vad, quiet)))
        self.assertFalse(any(flags(vad, [white(rng, -63) for _ in range(5)])), "and it closes on the quiet room")

    def test_a_loud_click_does_not_swallow_the_quiet_speech_after_it(self):
        rng = np.random.default_rng(13)
        vad = quiet_room(dbfs=-63)
        self.assertTrue(vad.is_speech(tone(-10)))  # a click or a cough
        speech = flags(vad, [tone(float(rng.uniform(-50, -44))) for _ in range(30)])
        longest_closed = run = 0
        for open_ in speech:
            run = 0 if open_ else run + 1
            longest_closed = max(longest_closed, run)
        self.assertLessEqual(longest_closed, 2, "one or two frames at most, far short of the 700 ms that ends a turn")
        self.assertGreaterEqual(sum(speech), 28)


def longest_run(values, wanted):
    longest = run = 0
    for value in values:
        run = run + 1 if value == wanted else 0
        longest = max(longest, run)
    return longest


class StartingConditions(unittest.TestCase):
    """The first seconds of a stream: found with the recorded clip, where the learned floor was 15-25 dB
    below the room because the gate was open on room noise before it had learned anything."""

    def speech(self, rng, count, center=-28):
        return [tone(float(rng.uniform(center - 6, center + 6))) for _ in range(count)]

    def test_speech_from_the_very_first_frame_is_not_learned_as_noise(self):
        rng = np.random.default_rng(14)
        vad = FrameVad()
        result = flags(vad, self.speech(rng, 250))
        self.assertGreaterEqual(sum(result) / len(result), 0.98)
        self.assertLess(vad.noise_floor_dbfs, -40, "the floor did not settle on the speech")

    def test_a_noisy_room_the_gate_was_open_on_still_gets_its_floor_and_its_pauses(self):
        # Room noise at -50 dBFS is above the -56 dBFS minimum, so the gate would be open on it from the start.
        rng = np.random.default_rng(15)
        vad = FrameVad()
        flags(vad, [white(rng, -50) for _ in range(12)])  # about a second of room, then people talk
        for turn in range(3):
            self.assertGreaterEqual(sum(flags(vad, self.speech(rng, 30))), 29)
            pause = flags(vad, [white(rng, -50) for _ in range(12)])  # 1.2 s of the same room
            self.assertGreaterEqual(longest_run(pause, False), 8, f"turn {turn}: the pause closed the gate long enough to end it")

    def test_a_room_that_gets_noisier_between_turns_still_has_pauses(self):
        # Auto-gain raises the noise in pauses: 12 dB more than the first second had.
        rng = np.random.default_rng(16)
        vad = quiet_room(dbfs=-63)
        flags(vad, self.speech(rng, 30, center=-22))
        pause = flags(vad, [white(rng, -51) for _ in range(15)])
        self.assertGreaterEqual(longest_run(pause, False), 10)
        # ...and the next speaker, a little quieter, is heard.
        self.assertGreaterEqual(sum(flags(vad, self.speech(rng, 30, center=-32))), 25)

    def test_speech_over_a_fan_that_was_already_running(self):
        rng = np.random.default_rng(17)
        vad = FrameVad()
        flags(vad, [white(rng, -48) for _ in range(12)])
        self.assertGreaterEqual(sum(flags(vad, self.speech(rng, 30, center=-30))), 29)


class TheRecordedClipIsCutAtItsPauses(unittest.TestCase):
    """The JFK fixture through the real gate and endpointing (no model). The clip has two pauses of room tone
    about 1.1 s long, measured from the raw frame levels: 2.2-3.3 s and 4.3-5.4 s into the clip. At every level
    the stream must be cut at both, as the old gate cut it at normal volume."""

    FIRST_PAUSE_ENDS_AT = (2.4, 3.8)    # an utterance ends 0.7 s into the pause, give or take the frame
    SECOND_PAUSE_ENDS_AT = (4.5, 6.0)
    LEAD_S = 1.0

    def boundaries(self, clip_dbfs):
        from speech.live.session import LiveSpeechSession
        from tests import real_audio as ra
        from tests.fakes_live import ScriptedAsr

        stream, start_s, _ = ra.clip_in_noise(clip_dbfs)
        session = LiveSpeechSession(streaming_asr=ScriptedAsr())
        for i in range(0, len(stream) - FRAME_SAMPLES + 1, FRAME_SAMPLES):
            session.ingest_audio_frame(stream[i : i + FRAME_SAMPLES], timestamp_s=(i + FRAME_SAMPLES) / SAMPLE_RATE)
        session.end()
        return [round(segment["end"] - start_s, 1) for segment in session.finalized_segments]

    def test_cut_at_both_pauses_at_every_level(self):
        for clip_dbfs in (-20, -30, -36, -40, -44, -48):
            with self.subTest(dbfs=clip_dbfs):
                ends = self.boundaries(clip_dbfs)
                self.assertTrue(any(self.FIRST_PAUSE_ENDS_AT[0] <= e <= self.FIRST_PAUSE_ENDS_AT[1] for e in ends), f"first pause: {ends}")
                self.assertTrue(any(self.SECOND_PAUSE_ENDS_AT[0] <= e <= self.SECOND_PAUSE_ENDS_AT[1] for e in ends), f"second pause: {ends}")


if __name__ == "__main__":
    unittest.main()
