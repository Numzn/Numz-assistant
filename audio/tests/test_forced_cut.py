"""
The cut at the length limit.

Continuous talk never gives the endpointer the 700 ms of quiet it needs, so an utterance is cut at 20 s.
Until now that cut fell wherever the clock ran out: in two real meetings 28% and 43% of the lines ended this
way, and at the join a word was lost ("if he's able to *get* other companies") or doubled ("to to").

Now the cut is made at the quietest 100 ms frame of the last 3 s, everything up to it is finalized and
everything after it carries over into the next utterance. These tests prove the audio is neither lost nor
repeated, the segments stay contiguous, and the limit still holds. The model is a recorder: what is under
test is which audio each decode is given.
"""

import unittest

import numpy as np

from speech.asr import AsrResult, AsrSegment
from speech.live.endpointing import CONVERSATION_PROFILE, Endpointer
from speech.live.session import LiveSpeechSession
from speech.live.streaming_asr import LocalAgreementStreamingAsr
from speech.schema import make_word

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1600
FRAME_S = 0.1
LIMIT_S = CONVERSATION_PROFILE.max_utterance_ms / 1000


class Recorder:
    """Records the audio of every decode it is given; "hears" a word per second of it."""

    def __init__(self):
        self.finals = []  # (samples, first_sample_value) per decode

    def transcribe(self, pcm, sample_rate, language="", prompt=""):
        duration = len(pcm) / sample_rate
        self.finals.append(len(pcm))
        words = [make_word("word", 0.1, min(0.4, duration))]
        segment = AsrSegment(start=0.0, end=duration, text="word", words=words)
        return AsrResult(segments=[segment], language="en", language_probability=1.0)


def speech_levels(seed=1, count=650, lull_at=None, lull_rms=0.002):
    """Frames that vary like syllables do; optionally one very quiet frame (a gap between words)."""
    rng = np.random.default_rng(seed)
    t = np.arange(FRAME_SAMPLES) / SAMPLE_RATE
    frames = []
    for i in range(count):
        rms = lull_rms if i == lull_at else float(rng.uniform(0.03, 0.09))
        frames.append((np.sin(2 * np.pi * 220 * t) * rms * np.sqrt(2)).astype(np.float32))
    return frames


def run(frames, **session_args):
    recorder = Recorder()
    asr = LocalAgreementStreamingAsr(sample_rate=SAMPLE_RATE, fast_asr=Recorder(), quality_asr=recorder)
    session = LiveSpeechSession(streaming_asr=asr, **session_args)
    for i, frame in enumerate(frames, start=1):
        session.ingest_audio_frame(frame, timestamp_s=i * FRAME_S)
    session.end()
    return session, recorder


class TheCutLandsInAGap(unittest.TestCase):
    LULL_FRAME = 184  # its middle is 18.45 s: inside the last 3 s of the 20 s limit

    def setUp(self):
        self.frames = speech_levels(count=400, lull_at=self.LULL_FRAME)
        self.session, self.recorder = run(self.frames)
        self.segments = self.session.finalized_segments

    def test_the_first_segment_ends_in_the_lull_not_at_20_seconds(self):
        first = self.segments[0]
        self.assertAlmostEqual(first["start"], 0.0, places=3)
        self.assertAlmostEqual(first["end"], 18.45, places=2)

    def test_segments_are_contiguous_ordered_and_never_overlap(self):
        for earlier, later in zip(self.segments, self.segments[1:]):
            self.assertAlmostEqual(earlier["end"], later["start"], places=3)
        self.assertAlmostEqual(self.segments[-1]["end"], 40.0, places=2)

    def test_every_sample_is_decoded_exactly_once(self):
        self.assertEqual(sum(self.recorder.finals), len(self.frames) * FRAME_SAMPLES, "nothing lost, nothing repeated")

    def test_words_belong_to_one_segment_and_follow_the_stream_clock(self):
        for earlier, later in zip(self.segments, self.segments[1:]):
            self.assertLessEqual(earlier["words"][-1]["end"], later["words"][0]["start"])
        for segment in self.segments:
            for word in segment["words"]:
                self.assertGreaterEqual(word["start"], segment["start"] - 1e-6)
                self.assertLessEqual(word["end"], segment["end"] + 1e-6)

    def test_the_cut_is_counted_in_the_diagnostics(self):
        self.assertGreaterEqual(self.session._diagnostics.summary()["forcedCuts"], 1)


class WithNoLullAtAll(unittest.TestCase):
    def test_it_still_cuts_inside_the_last_window_and_never_after_the_limit(self):
        session, recorder = run(speech_levels(seed=2, count=450))
        first = session.finalized_segments[0]
        self.assertGreaterEqual(first["end"], LIMIT_S - 3.0 - 1e-6)
        self.assertLessEqual(first["end"], LIMIT_S + 1e-6)
        self.assertEqual(sum(recorder.finals), 450 * FRAME_SAMPLES)

    def test_a_long_stream_keeps_every_segment_within_the_limit_and_contiguous(self):
        session, recorder = run(speech_levels(seed=3, count=900))  # 90 s
        segments = session.finalized_segments
        self.assertGreaterEqual(len(segments), 5)
        for segment in segments:
            self.assertLessEqual(segment["end"] - segment["start"], LIMIT_S + FRAME_S + 1e-6)
        for earlier, later in zip(segments, segments[1:]):
            self.assertAlmostEqual(earlier["end"], later["start"], places=3)
        self.assertEqual(sum(recorder.finals), 900 * FRAME_SAMPLES)


class TheFixedCutStillExists(unittest.TestCase):
    def test_a_zero_window_cuts_exactly_at_the_limit_as_before(self):
        session, recorder = run(speech_levels(count=450, lull_at=184), forced_cut_window_s=0)
        self.assertAlmostEqual(session.finalized_segments[0]["end"], LIMIT_S, delta=FRAME_S + 1e-6)

    def test_a_recognizer_without_flush_at_gets_the_old_behaviour(self):
        from tests.fakes_live import ScriptedAsr

        session = LiveSpeechSession(streaming_asr=ScriptedAsr(), frame_vad=None)
        for i, frame in enumerate(speech_levels(count=450), start=1):
            session.ingest_audio_frame(frame, timestamp_s=i * FRAME_S)
        session.end()
        self.assertAlmostEqual(session.finalized_segments[0]["end"], LIMIT_S, delta=FRAME_S + 1e-6)


class FlushAtOnTheRecognizer(unittest.TestCase):
    def build(self):
        recorder = Recorder()
        asr = LocalAgreementStreamingAsr(sample_rate=SAMPLE_RATE, fast_asr=Recorder(), quality_asr=recorder)
        for i, frame in enumerate(speech_levels(count=60), start=1):  # 6 s
            asr.push_audio(frame, i * FRAME_S)
        return asr, recorder

    def test_splits_the_buffer_and_keeps_the_rest(self):
        asr, recorder = self.build()
        event = asr.flush_at(2.55)
        self.assertEqual((round(event.start, 3), round(event.end, 3)), (0.0, 2.55))
        self.assertEqual(recorder.finals, [int(round(2.55 * SAMPLE_RATE))])
        rest = asr.flush()
        self.assertEqual((round(rest.start, 3), round(rest.end, 3)), (2.55, 6.0))
        self.assertEqual(sum(recorder.finals), 60 * FRAME_SAMPLES)

    def test_a_split_outside_the_buffer_flushes_everything(self):
        asr, recorder = self.build()
        event = asr.flush_at(99.0)
        self.assertEqual((round(event.start, 3), round(event.end, 3)), (0.0, 6.0))
        self.assertIsNone(asr.flush())

    def test_an_empty_recognizer_returns_nothing(self):
        asr = LocalAgreementStreamingAsr(sample_rate=SAMPLE_RATE, fast_asr=Recorder(), quality_asr=Recorder())
        self.assertIsNone(asr.flush_at(1.0))


class EndpointerContinuesFromACut(unittest.TestCase):
    def test_the_next_limit_is_counted_from_the_cut_and_the_turn_stays_open(self):
        endpointer = Endpointer()
        endpointer.on_speech(0.0)
        endpointer.on_speech(20.0)
        endpointer.continue_from(start_s=18.45, now_s=20.0)
        self.assertTrue(endpointer.in_progress())
        self.assertEqual(endpointer.on_speech(38.0).value, "continue")
        self.assertEqual(endpointer.on_speech(38.5).value, "forced_end")


if __name__ == "__main__":
    unittest.main()
