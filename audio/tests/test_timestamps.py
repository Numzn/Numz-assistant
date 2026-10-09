"""
Segment and word times must follow the stream clock.

Until 2026-10-09 an utterance inherited the previous utterance's END as its start (the silence between
them is never buffered), so speech at 12-14 s and 24-26 s was stored as 2.70-5.80 and 5.80-8.80: the
order survived, but every pause was squeezed out of the stored timeline.

These tests run the real session, gate, endpointing and streaming wrapper. Only Whisper is a stub, which
is enough: the timing logic does not depend on what the model says.
"""

import unittest

import numpy as np

from speech.asr import AsrResult, AsrSegment
from speech.live.events import TranscriptStage
from speech.live.endpointing import CONVERSATION_PROFILE
from speech.live.session import PRE_ROLL_S, LiveSpeechSession
from speech.live.streaming_asr import LocalAgreementStreamingAsr
from speech.schema import make_word

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1600  # 100 ms
FRAME_S = FRAME_SAMPLES / SAMPLE_RATE
END_SILENCE_S = CONVERSATION_PROFILE.end_silence_ms / 1000


class HeardAsr:
    """Hears "hello world" in whatever it is given, with word times counted from the start of that audio
    (which is how Whisper reports them)."""

    def transcribe(self, pcm, sample_rate, language="", prompt=""):
        duration = len(pcm) / sample_rate
        words = [make_word("hello", 0.1, 0.4), make_word("world", 0.5, 0.9)]
        segment = AsrSegment(start=0.0, end=duration, text="hello world", words=words)
        return AsrResult(segments=[segment], language="en", language_probability=1.0)


def tone(rms):
    t = np.arange(FRAME_SAMPLES) / SAMPLE_RATE
    return (np.sin(2 * np.pi * 220 * t) * rms * np.sqrt(2)).astype(np.float32)


SPEECH, QUIET = tone(0.05), tone(0.0005)


def run(script):
    """script: [("speech" | "quiet", seconds)]. Returns (session, events, spans of the speech parts)."""
    asr = LocalAgreementStreamingAsr(sample_rate=SAMPLE_RATE, fast_asr=HeardAsr(), quality_asr=HeardAsr())
    session = LiveSpeechSession(streaming_asr=asr)
    events = []
    session.on_transcript_event(events.append)

    position, spans = 0.0, []
    for kind, seconds in script:
        start = position
        for _ in range(int(round(seconds / FRAME_S))):
            position += FRAME_S
            session.ingest_audio_frame(SPEECH if kind == "speech" else QUIET, timestamp_s=position)
        if kind == "speech":
            spans.append((round(start, 3), round(position, 3)))
    session.end()
    return session, events, spans


class SegmentsFollowTheStreamClock(unittest.TestCase):
    # The case that was reproduced: 2 s of speech at 0-2 s, 12-14 s and 24-26 s.
    SCRIPT = [("speech", 2), ("quiet", 10), ("speech", 2), ("quiet", 10), ("speech", 2), ("quiet", 2)]

    def setUp(self):
        self.session, self.events, self.spans = run(self.SCRIPT)
        self.segments = self.session.finalized_segments

    def test_there_is_one_segment_per_utterance_in_order(self):
        self.assertEqual(self.spans, [(0.0, 2.0), (12.0, 14.0), (24.0, 26.0)])
        self.assertEqual(len(self.segments), 3)
        starts = [s["start"] for s in self.segments]
        self.assertEqual(starts, sorted(starts))
        for earlier, later in zip(self.segments, self.segments[1:]):
            self.assertLessEqual(earlier["end"], later["start"], "segments never overlap")

    def test_each_segment_sits_on_its_own_speech_not_on_squeezed_time(self):
        for segment, (speech_start, speech_end) in zip(self.segments, self.spans):
            # The recognizer is also given up to 0.3 s of lead-in and the 0.7 s of silence that ends the turn.
            self.assertGreaterEqual(segment["start"], speech_start - PRE_ROLL_S - FRAME_S)
            self.assertLessEqual(segment["start"], speech_start + FRAME_S)
            self.assertGreaterEqual(segment["end"], speech_end - 0.001)
            self.assertLessEqual(segment["end"], speech_end + END_SILENCE_S + 2 * FRAME_S)

    def test_the_pauses_are_still_there(self):
        for earlier, later in zip(self.segments, self.segments[1:]):
            gap = later["start"] - earlier["end"]
            # 10 s of silence minus the lead-in and the turn-ending silence already inside the segments.
            self.assertGreater(gap, 10 - PRE_ROLL_S - END_SILENCE_S - 3 * FRAME_S)
            self.assertLess(gap, 10.0)

    def test_durations_match_the_audio_the_recognizer_was_given(self):
        for segment in self.segments:
            duration = segment["end"] - segment["start"]
            self.assertGreater(duration, 2.0)
            self.assertLess(duration, 2.0 + PRE_ROLL_S + END_SILENCE_S + 3 * FRAME_S)

    def test_word_times_are_stream_times_inside_their_segment(self):
        for segment in self.segments:
            first, second = segment["words"]
            self.assertAlmostEqual(first["start"], segment["start"] + 0.1, places=3)
            self.assertAlmostEqual(second["end"], segment["start"] + 0.9, places=3)
            for word in segment["words"]:
                self.assertGreaterEqual(word["start"], segment["start"])
                self.assertLessEqual(word["end"], segment["end"])

    def test_the_session_transcript_is_valid_and_covers_the_whole_stream(self):
        transcript = self.session.transcript()  # validates ordering and bounds
        self.assertEqual(transcript["durationS"], self.segments[-1]["end"])
        self.assertGreater(transcript["durationS"], 26.0)

    def test_previews_use_stream_time_too(self):
        previews = [e for e in self.events if e.stage != TranscriptStage.FINAL]
        for event in previews:
            nearest = min(self.spans, key=lambda span: abs(span[0] - event.start))
            self.assertLessEqual(abs(event.start - nearest[0]), PRE_ROLL_S + FRAME_S)


class ContinuousSpeechCutAtTheLimit(unittest.TestCase):
    def test_the_forced_cut_leaves_neither_a_gap_nor_an_overlap(self):
        session, _, spans = run([("speech", 25), ("quiet", 2)])
        first, second = session.finalized_segments
        self.assertAlmostEqual(first["start"], 0.0, places=3)
        self.assertAlmostEqual(first["end"], CONVERSATION_PROFILE.max_utterance_ms / 1000, delta=FRAME_S + 1e-6)
        self.assertAlmostEqual(second["start"], first["end"], places=3)
        self.assertGreaterEqual(second["end"], spans[0][1] - 0.001)


class ASessionThatStartsWithSilence(unittest.TestCase):
    def test_the_first_utterance_is_not_pulled_back_to_zero(self):
        session, _, spans = run([("quiet", 5), ("speech", 2), ("quiet", 2)])
        (segment,) = session.finalized_segments
        self.assertEqual(spans, [(5.0, 7.0)])
        self.assertGreaterEqual(segment["start"], 5.0 - PRE_ROLL_S - FRAME_S)
        self.assertLessEqual(segment["start"], 5.0 + FRAME_S)


if __name__ == "__main__":
    unittest.main()
