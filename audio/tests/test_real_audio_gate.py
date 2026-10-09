"""
Real speech through the real pipeline: the gate, endpointing, timestamps and the actual Whisper model.

Everything else in this suite uses a stub recognizer. This module is the one that proves quiet speech
survives, and it was written because the live path was only ever tested with fake audio and a fake model
until 2026-10-09.

It loads the Whisper model (about 600 MB and a minute or two on this host), so it is OPT-IN:

    cd audio && NUMZ_REAL_ASR=1 .venv/bin/python -m unittest tests.test_real_audio_gate -v

Set NUMZ_REAL_ASR_REPORT=/some/file.json to also write every measurement as JSON.

The pass criteria were fixed before the first measurement and are NOT tuned to the recording:
  - word error rate at most 15%  (the clip has 22 words: three errors)
  - at most 10% of the clip's 100 ms frames never reach Whisper
  - at most one inserted word and no phrase said more often than in the reference (a hallucination or a loop)
  - noise with no speech in it: no transcript line; at most 4.5 s of it forwarded to Whisper in total (the
    one-off cost of learning a steady noise: a 3 s window, the 0.7 s turn end and 0.3 s of lead-in) and
    nothing forwarded after the first 6 s
(The noise criterion first said "at most 10% of frames" of a 30 s stream. That was mis-specified: the cost is
a fixed few seconds at the start, not a rate, so it was restated in seconds before any pipeline threshold changed.)
Limits of the evidence: ONE recording of ONE voice, and synthetic noise. A pass here does not show the
gate is right for other voices, rooms or microphones; the per-session diagnostics exist to find out.
"""

import json
import os
import sys
import unittest

from tests import real_audio as ra

REAL = os.environ.get("NUMZ_REAL_ASR") == "1"
REPORT = os.environ.get("NUMZ_REAL_ASR_REPORT", "")

MAX_WER = 0.15
MAX_DROPPED_SHARE = 0.10
MAX_INSERTIONS = 1
MAX_NOISE_FORWARDED_S = 4.5
NOISE_QUIET_AFTER_S = 6.0


class TheMeasuringInstrument(unittest.TestCase):
    """Runs without the model: the numbers in the real tests are only as good as these."""

    def test_word_error_rate_and_its_parts(self):
        reference = "ask not what your country can do for you"
        self.assertEqual(ra.word_errors(reference, reference)["wer"], 0.0)
        substituted = ra.word_errors("ask not what our country can do for you", reference)
        self.assertEqual((substituted["substitutions"], substituted["deletions"], substituted["insertions"]), (1, 0, 0))
        deleted = ra.word_errors("ask not what your country can do you", reference)
        self.assertEqual((deleted["substitutions"], deleted["deletions"], deleted["insertions"]), (0, 1, 0))
        inserted = ra.word_errors("ask not what your country can really do for you", reference)
        self.assertEqual((inserted["substitutions"], inserted["deletions"], inserted["insertions"]), (0, 0, 1))
        nothing = ra.word_errors("", reference)
        self.assertEqual((nothing["wer"], nothing["deletions"]), (1.0, 9))

    def test_case_and_punctuation_do_not_count_as_errors(self):
        self.assertEqual(ra.word_errors("And so, my fellow Americans.", "and so my fellow americans")["wer"], 0.0)

    def test_excess_repeats_ignores_what_the_reference_itself_repeats(self):
        looped = "and so my fellow americans " + "ask not " * 6 + "what your country can do for you ask what you can do for your country"
        self.assertEqual(ra.excess_repeats(looped), ["ask not ask", "not ask not"])
        self.assertEqual(ra.excess_repeats(ra.JFK_REFERENCE), [], "the clip says 'can do for' twice; that is not a loop")
        self.assertEqual(ra.excess_repeats("ask not what your country can do"), [])
        self.assertEqual(ra.excess_repeats("and so my fellow americans what your country"), [], "a deleted word is not a repeat")

    def test_the_fixture_is_the_documented_clip(self):
        clip = ra.load_clip()
        self.assertAlmostEqual(len(clip) / ra.SAMPLE_RATE, 11.0, delta=0.1)
        self.assertGreater(ra.dbfs(clip), -25)
        self.assertLess(ra.dbfs(clip), -10)

    def test_levels_are_set_exactly(self):
        for target in (-20, -44, -52):
            self.assertAlmostEqual(ra.dbfs(ra.scale_to_dbfs(ra.load_clip(), target)), target, places=1)
        self.assertAlmostEqual(ra.dbfs(ra.white_noise(16000, -63)), -63, delta=0.3)
        self.assertAlmostEqual(ra.dbfs(ra.room_tone(16000, -50)), -50, delta=0.3)


@unittest.skipUnless(REAL, "real-Whisper test: run with NUMZ_REAL_ASR=1 (loads the model; see the module docstring)")
class QuietSpeechThroughTheRealPipeline(unittest.TestCase):
    measurements = []

    @classmethod
    def tearDownClass(cls):
        print("\n\nreal-audio measurements (JFK clip, 22 reference words)", file=sys.stderr)
        header = f"{'case':<34}{'WER':>6}{'sub':>5}{'del':>5}{'ins':>5}{'dropped':>10}{'fwd%':>7}{'sec':>6}"
        print(header, file=sys.stderr)
        for m in cls.measurements:
            if "wer" in m:
                print(
                    f"{m['case']:<34}{m['wer']:>6}{m['substitutions']:>5}{m['deletions']:>5}{m['insertions']:>5}"
                    f"{m['clip_frames_dropped']:>6}/{m['clip_frames']:<3}{100 * m['forwarded_share']:>6.0f}%{m['seconds']:>6}",
                    file=sys.stderr,
                )
            else:
                print(
                    f"{m['case']:<34}  lines={len(m['lines'])} gate-open={m['gate_open_frames']} "
                    f"forwarded={m['forwarded_frames']}/{m['frames']} ({100 * m['forwarded_share']:.0f}%)",
                    file=sys.stderr,
                )
        if REPORT:
            with open(REPORT, "w") as handle:
                json.dump(cls.measurements, handle, indent=1)

    def measure_clip(self, clip_dbfs, offset_samples=0):
        stream, start_s, end_s = ra.clip_in_noise(clip_dbfs, offset_samples=offset_samples)
        result = ra.run_stream(stream, clip_start_s=start_s, clip_end_s=end_s)
        text = " ".join(result["lines"])
        result.update(ra.word_errors(text))
        result["case"] = f"clip at {clip_dbfs} dBFS, offset {offset_samples}"
        result["clip_dbfs"] = clip_dbfs
        result["offset_samples"] = offset_samples
        result["excess_repeats"] = ra.excess_repeats(text)
        self.measurements.append(result)
        return result

    def assert_speech_survived(self, result):
        label = f"{result['case']}: {result['lines']}"
        self.assertLessEqual(result["wer"], MAX_WER, f"word error rate; {label}")
        self.assertLessEqual(result["clip_frames_dropped_share"], MAX_DROPPED_SHARE, f"speech frames never sent to Whisper; {label}")
        self.assertLessEqual(result["insertions"], MAX_INSERTIONS, f"inserted words; {label}")
        self.assertEqual(result["excess_repeats"], [], f"phrases repeated more than in the reference; {label}")

    def test_normal_microphone_level(self):
        self.assert_speech_survived(self.measure_clip(-20))

    def test_quiet_speech_at_minus_40_44_and_48_dbfs(self):
        for clip_dbfs in (-40, -44, -48):
            # Offsets that are not a whole number of 100 ms frames put the speech start and end at different
            # places inside the frames the gate sees.
            for offset in (0, 800):
                with self.subTest(dbfs=clip_dbfs, offset=offset):
                    self.assert_speech_survived(self.measure_clip(clip_dbfs, offset))

    def test_speech_beginning_and_ending_near_frame_boundaries(self):
        for offset in (400, 1200):
            with self.subTest(offset=offset):
                self.assert_speech_survived(self.measure_clip(-44, offset))

    def test_below_the_floor_is_reported_not_asserted(self):
        # -52 dBFS is near the experimental -56 dBFS minimum: recorded for the report, with no pass mark.
        self.measure_clip(-52)

    def test_noise_without_speech_makes_no_lines_and_is_not_forwarded_after_the_first_seconds(self):
        seconds = 30
        samples = seconds * ra.SAMPLE_RATE
        cases = {
            "white noise -63 dBFS (quiet room)": ra.white_noise(samples, -63),
            "white noise -54 dBFS": ra.white_noise(samples, -54),
            "white noise -48 dBFS (loud room)": ra.white_noise(samples, -48),
            "room tone -50 dBFS (rumble)": ra.room_tone(samples, -50),
            "50 Hz hum -52 + hiss -66 dBFS": ra.mains_hum(samples, -52, -66),
        }
        for name, stream in cases.items():
            with self.subTest(noise=name):
                result = ra.run_stream(stream)
                result["case"] = name
                self.measurements.append(result)
                self.assertEqual(result["lines"], [], "no speech, so no transcript line")
                self.assertLessEqual(result["forwarded_frames"] * ra.FRAME_SAMPLES / ra.SAMPLE_RATE, MAX_NOISE_FORWARDED_S)
                self.assertLessEqual(max(result["forwarded_at"], default=0.0), NOISE_QUIET_AFTER_S, "no false detections later on")

    def test_segment_times_on_real_audio_follow_the_stream_clock(self):
        # The clip twice, 8 s of room noise apart, at 5 s and ~24 s into the stream.
        import numpy as np

        clip = ra.scale_to_dbfs(ra.load_clip(), -30)
        gap = ra.white_noise(8 * ra.SAMPLE_RATE, -63, seed=11)
        stream = np.concatenate(
            [ra.white_noise(5 * ra.SAMPLE_RATE, -63, seed=12), clip, gap, clip, ra.white_noise(3 * ra.SAMPLE_RATE, -63, seed=13)]
        )
        first = (5.0, 5.0 + len(clip) / ra.SAMPLE_RATE)
        second = (first[1] + 8.0, first[1] + 8.0 + len(clip) / ra.SAMPLE_RATE)
        result = ra.run_stream(stream)
        self.measurements.append({**result, "case": "clip twice, 8 s apart"})

        segments = result["segments"]
        self.assertTrue(segments, "the speech was transcribed")
        self.assertEqual(segments, sorted(segments), "in order")
        for earlier, later in zip(segments, segments[1:]):
            self.assertLessEqual(earlier[1], later[0], "never overlapping")
        for start, end in segments:
            clip_span = min((first, second), key=lambda span: abs((start + end) / 2 - (span[0] + span[1]) / 2))
            self.assertGreaterEqual(start, clip_span[0] - 0.5, f"segment {start}-{end} starts before its speech")
            self.assertLessEqual(end, clip_span[1] + 1.2, f"segment {start}-{end} ends well after its speech")
        self.assertLess(segments[0][0], first[0] + 1.5)
        self.assertGreaterEqual(segments[-1][1], second[1] - 0.5, "the second pass is stamped near 24 s, not squeezed up")
        self.assertGreater(segments[-1][0], first[1] + 4.0, "the 8 s pause is still in the timeline")


if __name__ == "__main__":
    unittest.main()
