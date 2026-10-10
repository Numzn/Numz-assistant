"""
Session diagnostics (speech/live/diagnostics.py): numbers about what the live path heard and how it coped.

They have to be accurate, small, free of audio and transcript text, and unable to break the audio path.
"""

import json
import logging
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

from speech.asr import AsrResult, AsrSegment
from speech.live.diagnostics import LEVEL_BINS, SessionDiagnostics
from speech.live.session import LiveSpeechSession
from speech.live.streaming_asr import LocalAgreementStreamingAsr
from speech.schema import make_word

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1600  # 100 ms
FRAME_S = 0.1
SESSION = "11111111-1111-4111-8111-111111111111"


def tone(dbfs):
    t = np.arange(FRAME_SAMPLES) / SAMPLE_RATE
    return (np.sin(2 * np.pi * 220 * t) * 10 ** (dbfs / 20) * np.sqrt(2)).astype(np.float32)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def make_diagnostics(**kwargs):
    clock = Clock()
    return SessionDiagnostics(SESSION, clock=clock, **kwargs), clock


def feed(diagnostics, clock, frames, start_s=0.0, gate_open=True, in_utterance=True, realtime=True):
    position = start_s
    for frame in frames:
        position += FRAME_S
        if realtime:
            clock.now += FRAME_S
        diagnostics.on_frame(frame, position, gate_open=gate_open, in_utterance=in_utterance)
        diagnostics.on_ingest_done(position)
    return position


class Counting(unittest.TestCase):
    def test_frames_received_forwarded_and_gate_open(self):
        diagnostics, clock = make_diagnostics()
        feed(diagnostics, clock, [tone(-30)] * 6, gate_open=True)
        feed(diagnostics, clock, [tone(-80)] * 4, start_s=0.6, gate_open=False, in_utterance=False)
        for _ in range(7):
            diagnostics.on_forwarded()
        frames = diagnostics.summary()["frames"]
        self.assertEqual((frames["received"], frames["gateOpen"], frames["forwarded"]), (10, 6, 7))
        self.assertEqual(frames["forwardedShare"], 0.7)
        self.assertEqual(diagnostics.summary()["streamS"], 1.0)

    def test_level_percentiles_come_from_a_fixed_size_histogram(self):
        diagnostics, clock = make_diagnostics()
        feed(diagnostics, clock, [tone(-60)] * 50 + [tone(-40)] * 40 + [tone(-20)] * 10)
        levels = diagnostics.summary()["levelDbfs"]
        # Upper edge of the 2 dB bin the level falls in.
        self.assertAlmostEqual(levels["p10"], -60, delta=2.5)
        self.assertAlmostEqual(levels["p50"], -60, delta=2.5)
        self.assertAlmostEqual(levels["p90"], -40, delta=2.5)
        self.assertAlmostEqual(levels["p99"], -20, delta=2.5)
        self.assertEqual(diagnostics._levels.size, LEVEL_BINS, "memory does not grow with the stream")

    def test_longest_quiet_interval_overall_and_inside_an_utterance(self):
        diagnostics, clock = make_diagnostics()
        position = feed(diagnostics, clock, [tone(-30)] * 10, gate_open=True)
        position = feed(diagnostics, clock, [tone(-80)] * 5, start_s=position, gate_open=False, in_utterance=True)
        position = feed(diagnostics, clock, [tone(-30)] * 10, start_s=position, gate_open=True)
        feed(diagnostics, clock, [tone(-80)] * 30, start_s=position, gate_open=False, in_utterance=False)
        summary = diagnostics.summary()
        self.assertAlmostEqual(summary["longestQuietS"], 3.0, places=1)
        self.assertAlmostEqual(summary["longestQuietInUtteranceS"], 0.5, places=1)


class Decodes(unittest.TestCase):
    def test_decode_count_duration_and_cost_per_audio_second(self):
        diagnostics, _ = make_diagnostics()
        diagnostics.on_decode("preview", 1.5, 3.0)
        diagnostics.on_decode("preview", 2.0, 5.0)
        diagnostics.on_decode("final", 4.0, 8.0, [])
        decodes = diagnostics.summary()["decodes"]
        self.assertEqual(decodes["preview"], {"count": 2, "seconds": 3.5, "longestS": 2.0, "audioS": 8.0, "secondsPerAudioSecond": 0.44})
        self.assertEqual(decodes["final"]["count"], 1)
        self.assertEqual(decodes["final"]["secondsPerAudioSecond"], 0.5)

    def test_segment_confidence_is_aggregated_over_final_decodes_only(self):
        diagnostics, _ = make_diagnostics()
        good = SimpleNamespace(avg_logprob=-0.3, no_speech_prob=0.05)
        poor = SimpleNamespace(avg_logprob=-1.4, no_speech_prob=0.8)
        diagnostics.on_decode("preview", 1.0, 2.0, [SimpleNamespace(avg_logprob=-3.0, no_speech_prob=0.99)])
        diagnostics.on_decode("final", 1.0, 2.0, [good, poor])
        confidence = diagnostics.summary()["confidence"]
        self.assertEqual(confidence["finalSegments"], 2)
        self.assertEqual(confidence["avgLogprobMean"], -0.85)
        self.assertEqual(confidence["avgLogprobMin"], -1.4)
        self.assertEqual(confidence["lowLogprobSegments"], 1)
        self.assertEqual(confidence["noSpeechProbMax"], 0.8)
        self.assertEqual(confidence["likelyNonSpeechSegments"], 1)

    def test_segments_without_confidence_fields_are_tolerated(self):
        diagnostics, _ = make_diagnostics()
        diagnostics.on_decode("final", 1.0, 2.0, [SimpleNamespace(text="x")])
        confidence = diagnostics.summary()["confidence"]
        self.assertEqual((confidence["finalSegments"], confidence["avgLogprobMean"]), (1, None))


class SlowDecodes(unittest.TestCase):
    """A 30-45 s decode of a few seconds of speech was seen in a real meeting; the log has to say why."""

    def retried(self, temperature, compression):
        return SimpleNamespace(
            text="secret words", avg_logprob=-0.9, no_speech_prob=0.1, temperature=temperature, compression_ratio=compression
        )

    def test_a_slow_decode_is_logged_with_its_retry_evidence_and_never_its_text(self):
        diagnostics, _ = make_diagnostics()
        with self.assertLogs("speech.live.diagnostics", level="WARNING") as logged:
            diagnostics.on_decode("final", 34.7, 20.0, [self.retried(0.6, 3.4), self.retried(0.0, 1.2)])
        (line,) = logged.output
        payload = json.loads(line.split("slow-decode ", 1)[1])
        self.assertEqual(
            (payload["seconds"], payload["audioS"], payload["segments"], payload["maxTemperature"], payload["maxCompressionRatio"]),
            (34.7, 20.0, 2, 0.6, 3.4),
        )
        self.assertNotIn("secret", line)

    def test_normal_decodes_are_not_logged_individually(self):
        diagnostics, _ = make_diagnostics()
        with self.assertNoLogs("speech.live.diagnostics", level="WARNING"):
            diagnostics.on_decode("final", 4.9, 20.0, [self.retried(0.0, 1.5)])
            diagnostics.on_decode("preview", 2.0, 6.0, [])

    def test_the_summary_counts_slow_decodes_and_keeps_the_worst_retry(self):
        diagnostics, _ = make_diagnostics()
        with self.assertLogs("speech.live.diagnostics", level="WARNING"):
            diagnostics.on_decode("final", 45.2, 20.0, [self.retried(0.4, 2.9)])
            diagnostics.on_decode("final", 12.0, 8.0, [self.retried(0.2, 2.5)])
        diagnostics.on_decode("final", 3.0, 8.0, [self.retried(0.0, 1.1)])
        decodes = diagnostics.summary()["decodes"]
        self.assertEqual((decodes["slow"], decodes["maxTemperature"], decodes["maxCompressionRatio"]), (2, 0.4, 2.9))

    def test_a_runaway_session_cannot_flood_the_log(self):
        diagnostics, _ = make_diagnostics()
        with self.assertLogs("speech.live.diagnostics", level="WARNING") as logged:
            for _ in range(60):
                diagnostics.on_decode("final", 30.0, 20.0, [])
        self.assertEqual(len(logged.output), 20)
        self.assertEqual(diagnostics.summary()["decodes"]["slow"], 60, "all are still counted")


class Lag(unittest.TestCase):
    def test_no_lag_while_processing_keeps_up_with_real_time(self):
        diagnostics, clock = make_diagnostics()
        feed(diagnostics, clock, [tone(-30)] * 50)
        self.assertEqual(diagnostics.summary()["lagS"], {"last": 0.0, "max": 0.0})

    def test_a_slow_decode_shows_up_as_lag_and_recovers(self):
        diagnostics, clock = make_diagnostics()
        position = feed(diagnostics, clock, [tone(-30)] * 10)
        clock.now += 3.0  # a decode blocked the receive loop for 3 s
        position = feed(diagnostics, clock, [tone(-30)] * 1, start_s=position)
        self.assertAlmostEqual(diagnostics.summary()["lagS"]["max"], 3.0, places=1)
        # The sender paces audio at real time, so a frame that arrives late has queued behind others and
        # the backlog drains as the service processes them faster than real time.
        feed(diagnostics, clock, [tone(-30)] * 5, start_s=position, realtime=False)
        summary = diagnostics.summary()["lagS"]
        self.assertLess(summary["last"], summary["max"])

    def test_audio_replayed_faster_than_real_time_reports_zero_not_negative(self):
        diagnostics, clock = make_diagnostics()
        feed(diagnostics, clock, [tone(-30)] * 100, realtime=False)
        self.assertEqual(diagnostics.summary()["lagS"]["max"], 0.0)


class ThroughTheRealSession(unittest.TestCase):
    TEXT = "confidential words that must never be logged"

    class Heard:
        def transcribe(self, pcm, sample_rate, language="", prompt=""):
            words = [make_word("confidential", 0.1, 0.5)]
            segment = AsrSegment(
                start=0.0, end=len(pcm) / sample_rate, text=ThroughTheRealSession.TEXT, words=words, avg_logprob=-0.4, no_speech_prob=0.1
            )
            return AsrResult(segments=[segment], language="en", language_probability=1.0)

    def session(self):
        # The streaming wrapper reports to the session's diagnostics exactly as in production.
        session = LiveSpeechSession(speech_session_id=SESSION)
        session._streaming_asr = LocalAgreementStreamingAsr(
            fast_asr=self.Heard(), quality_asr=self.Heard(), decode_observer=session._diagnostics.on_decode
        )
        return session

    def run_stream(self, session, seconds_of_speech=6.0):
        levels = [tone(d) for d in (-36, -28, -33, -26, -30, -38, -27, -31)]
        position = 0.0
        for i in range(int(seconds_of_speech / FRAME_S)):
            position += FRAME_S
            session.ingest_audio_frame(levels[i % len(levels)], timestamp_s=position)
        for _ in range(20):
            position += FRAME_S
            session.ingest_audio_frame(tone(-80), timestamp_s=position)
        session.end()

    def test_the_session_reports_frames_decodes_and_confidence(self):
        session = self.session()
        with self.assertLogs("speech.live.diagnostics", level="INFO") as logged:
            self.run_stream(session)
        summary = session._diagnostics.summary(final=True)
        self.assertEqual(summary["frames"]["received"], 80)
        self.assertGreater(summary["frames"]["forwarded"], 60)
        self.assertLess(summary["frames"]["forwarded"], 80, "the long silence is not sent to the recognizer")
        self.assertGreaterEqual(summary["decodes"]["final"]["count"], 1)
        self.assertGreaterEqual(summary["decodes"]["preview"]["count"], 1)
        self.assertEqual(summary["confidence"]["avgLogprobMin"], -0.4)
        self.assertIsNotNone(summary["noiseFloorDbfs"])
        self.assertTrue(any("live-speech-diag" in line for line in logged.output))

    def test_the_log_carries_numbers_and_never_the_transcript_or_audio(self):
        session = self.session()
        with self.assertLogs("speech.live.diagnostics", level="INFO") as logged:
            self.run_stream(session)
        self.assertTrue(session.finalized_segments, "the session did produce a transcript line")
        for line in logged.output:
            self.assertNotIn("confidential", line)
            payload = json.loads(line.split("live-speech-diag ", 1)[1])
            self.assertLess(len(json.dumps(payload)), 1500, "one small line")
            self.assertEqual(payload["session"], SESSION)

    def test_one_final_line_when_the_session_ends_and_none_more_afterwards(self):
        session = self.session()
        with self.assertLogs("speech.live.diagnostics", level="INFO") as logged:
            self.run_stream(session)
            session.end()
        finals = [line for line in logged.output if '"final":true' in line]
        self.assertEqual(len(finals), 1)

    def test_a_progress_line_is_written_every_minute_of_stream(self):
        diagnostics = SessionDiagnostics(SESSION, log_every_s=60.0)
        with self.assertLogs("speech.live.diagnostics", level="INFO") as logged:
            position = 0.0
            for _ in range(1300):  # 130 s
                position += FRAME_S
                diagnostics.on_frame(tone(-40), position, gate_open=True, in_utterance=True)
                diagnostics.on_ingest_done(position)
        self.assertEqual(len(logged.output), 2)
        self.assertTrue(all('"final":false' in line for line in logged.output))


class NeverBreaksTheAudioPath(unittest.TestCase):
    def test_broken_diagnostics_do_not_stop_ingest(self):
        session = LiveSpeechSession(speech_session_id=SESSION)
        with mock.patch.object(np, "log10", side_effect=RuntimeError("diagnostics bug")):
            with self.assertLogs("speech.live.diagnostics", level="ERROR") as logged:
                for i in range(1, 6):
                    session.ingest_audio_frame(tone(-30), timestamp_s=i * FRAME_S)
        self.assertEqual(len(logged.output), 1, "reported once, not once per frame")

    def test_garbage_input_is_swallowed(self):
        diagnostics, _ = make_diagnostics()
        with self.assertLogs("speech.live.diagnostics", level="ERROR"):
            self.assertIsNone(diagnostics.on_frame(None, 0.1, gate_open=True, in_utterance=False))
        diagnostics.on_decode("final", 1.0, 1.0, None)
        diagnostics.on_ingest_done(0.2)
        self.assertIsInstance(diagnostics.summary(), dict)


if __name__ == "__main__":
    unittest.main()
