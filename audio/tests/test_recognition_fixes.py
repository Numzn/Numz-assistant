"""
Regression tests for the recognition failures seen on 2026-10-09:
  - meetings saved nothing or 100 ms scraps, because only frames louder than the gate reached Whisper;
  - transcripts came out as comma-separated loops ("NUMZ, NUMZ, ...", "stop, stop, ...") because every
    decode was primed with a comma-separated keyword list and the temperature fallback was off.
"""

import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

import transcribe
from speech import asr as asr_module
from speech.asr import FasterWhisperAsr
from speech.live.frame_vad import FrameVad
from speech.live.session import PRE_ROLL_S, LiveSpeechSession
from speech.live.streaming_asr import LocalAgreementStreamingAsr
from speech.repetition import collapse_repetitions, keep_mask
from tests.fakes_live import FRAME_SAMPLES, SAMPLE_RATE, EnergyVad, ScriptedAsr, feed, silence_frames, speech_frames


def level_frames(count, rms):
    """Frames of a steady tone at the given RMS level (EnergyVad calls >0.05 speech)."""
    t = np.arange(FRAME_SAMPLES) / SAMPLE_RATE
    tone = (np.sin(2 * np.pi * 220 * t) * rms * np.sqrt(2)).astype(np.float32)
    return [tone.copy() for _ in range(count)]


class RecordingAsr(ScriptedAsr):
    """Scripted ASR that also remembers every frame it was given."""

    def __init__(self):
        super().__init__(prefix="utt")
        self.frames = []

    def push_audio(self, frame, timestamp_s):
        self.frames.append((frame, timestamp_s))
        return super().push_audio(frame, timestamp_s)


def session_with(asr):
    return LiveSpeechSession(streaming_asr=asr, frame_vad=EnergyVad())


class WholeUtterancesReachTheRecognizer(unittest.TestCase):
    def test_quiet_frames_inside_an_utterance_are_passed_on_and_do_not_split_it(self):
        asr = RecordingAsr()
        session = session_with(asr)
        loud, quiet = speech_frames(5), level_frames(3, rms=0.02)  # quiet: below the gate, but it is speech
        feed(session, loud + quiet + speech_frames(5) + silence_frames(10), 0.0)
        session.end()

        pushed = [id(frame) for frame, _ in asr.frames]
        for frame in quiet:
            self.assertIn(id(frame), pushed, "a quiet syllable in the middle of an utterance reaches Whisper")
        self.assertEqual(len(session.finalized_segments), 1, "a soft moment does not cut the sentence in two")

    def test_the_moments_before_speech_are_included_so_the_first_syllable_is_not_clipped(self):
        asr = RecordingAsr()
        session = session_with(asr)
        lead_in = level_frames(6, rms=0.02)  # soft onset, below the gate
        feed(session, lead_in + speech_frames(5) + silence_frames(10), 0.0)
        session.end()

        pushed = [id(frame) for frame, _ in asr.frames]
        expected_lead = int(round(PRE_ROLL_S * SAMPLE_RATE / FRAME_SAMPLES))
        for frame in lead_in[-expected_lead:]:
            self.assertIn(id(frame), pushed, "the last 0.3 s before speech is handed over")
        for frame in lead_in[:-expected_lead]:
            self.assertNotIn(id(frame), pushed, "but not everything before it")
        first_time = asr.frames[0][1]
        self.assertAlmostEqual(first_time, len(lead_in[: len(lead_in) - expected_lead + 1]) * 0.1, places=3)

    def test_long_silence_between_utterances_is_not_sent_to_the_recognizer(self):
        asr = RecordingAsr()
        session = session_with(asr)
        feed(session, speech_frames(5) + silence_frames(40) + speech_frames(5) + silence_frames(10), 0.0)
        session.end()
        self.assertEqual(len(session.finalized_segments), 2)
        # 5 speech + up to 7 trailing silence frames (end of turn at 700 ms), twice, plus each lead-in.
        self.assertLess(len(asr.frames), 2 * (5 + 8 + 3) + 1)


class TheGateHearsALaptopMicrophone(unittest.TestCase):
    def test_speech_at_minus_40_dbfs_opens_an_utterance_in_a_quiet_room(self):
        vad = FrameVad()
        for frame in level_frames(30, rms=0.001):  # quiet room, about -60 dBFS
            self.assertFalse(vad.is_speech(frame))
        speech = level_frames(1, rms=0.01)[0]  # normal speech into a laptop mic without gain control
        self.assertTrue(vad.is_speech(speech), "the old 0.02 floor (about -34 dBFS) refused this")

    def test_steady_room_noise_is_not_speech(self):
        vad = FrameVad()
        for frame in level_frames(50, rms=0.004):
            vad.is_speech(frame)  # the noise floor adapts
        self.assertFalse(vad.is_speech(level_frames(1, rms=0.004)[0]))


class RepetitionLoopsAreCollapsed(unittest.TestCase):
    def test_the_loops_seen_in_meetings(self):
        self.assertEqual(collapse_repetitions("no, one, " + "NUMZ, " * 20), "no, one, NUMZ,")
        self.assertEqual(collapse_repetitions("stop, " * 90 + "right now."), "stop, right now.")
        self.assertEqual(collapse_repetitions("I don't know, I don't know, I don't know, I don't know."), "I don't know,")

    def test_ordinary_repeats_are_kept(self):
        for text in [
            "no, no, I said so", "very very good", "it is what it is", "bye bye",
            "no, no, no is not an answer",  # emphasis: three in a row
            "Yeah, I like that. I like that. I like that great thing about this one.",  # said so in a real meeting
        ]:
            self.assertEqual(collapse_repetitions(text), text)

    def test_mask_lines_up_with_words(self):
        self.assertEqual(keep_mask(["a", "b", "b", "b", "b", "c"]), [True, True, False, False, False, True])
        self.assertEqual(keep_mask(["a", "b", "b", "b", "c"]), [True] * 5, "three in a row is speech, not a loop")


def fake_segment(text, words=None):
    return SimpleNamespace(
        text=text,
        start=0.0,
        end=1.0,
        words=[SimpleNamespace(word=w, start=i * 0.2, end=i * 0.2 + 0.1, probability=0.9) for i, w in enumerate(words or [])],
        avg_logprob=-0.2,
        no_speech_prob=0.01,
    )


class PreviewsArePaced(unittest.TestCase):
    """Each decode costs about 1.7 s on this server whatever the audio length, so previews must be rationed."""

    def test_slow_previews_are_spaced_out_but_the_final_line_is_always_decoded(self):
        now = [0.0]

        class SlowAsr:
            calls = []

            def transcribe(self, pcm, sample_rate, language="", prompt=""):
                SlowAsr.calls.append(len(pcm) / sample_rate)
                now[0] += 1.7  # what a decode costs here
                return SimpleNamespace(segments=[SimpleNamespace(text="hello there", words=[])])

        live = LocalAgreementStreamingAsr(fast_asr=SlowAsr(), quality_asr=SlowAsr(), clock=lambda: now[0])
        position = 0.0
        for frame in speech_frames(200):  # 20 s of continuous speech
            position += 0.1
            live.push_audio(frame, position)
        previews = list(SlowAsr.calls)
        self.assertEqual(previews[0], 2.0, "the first preview after 2 s of speech")
        gaps = [b - a for a, b in zip(previews, previews[1:])]
        self.assertTrue(all(gap >= 5.0 for gap in gaps), f"then at least 1.7 s / (1/3) = 5.1 s apart: {gaps}")
        self.assertLessEqual(len(previews) * 1.7, 20 / 3 + 1.7, "previews use about a third of real time")

        final = live.flush()
        self.assertIsNotNone(final, "the FINAL line is decoded regardless")
        self.assertEqual(SlowAsr.calls[-1], 20.0)

    def test_fast_previews_still_tick_every_two_seconds(self):
        now = [0.0]

        class QuickAsr:
            calls = []

            def transcribe(self, pcm, sample_rate, language="", prompt=""):
                QuickAsr.calls.append(len(pcm) / sample_rate)
                now[0] += 0.2
                return SimpleNamespace(segments=[SimpleNamespace(text="hi", words=[])])

        live = LocalAgreementStreamingAsr(fast_asr=QuickAsr(), quality_asr=QuickAsr(), clock=lambda: now[0])
        position = 0.0
        for frame in speech_frames(100):
            position += 0.1
            live.push_audio(frame, position)
        self.assertEqual([round(c, 1) for c in QuickAsr.calls], [2.0, 4.0, 6.0, 8.0, 10.0])


class DecodeSettings(unittest.TestCase):
    def test_meetings_never_get_the_assistant_prompt_and_the_safety_net_is_on(self):
        calls = []

        def fake_transcribe_segments(pcm, **kwargs):
            calls.append(kwargs)
            return iter([]), SimpleNamespace(language="en", language_probability=1.0)

        with mock.patch.object(asr_module.live_transcribe, "_transcribe_segments", fake_transcribe_segments):
            FasterWhisperAsr().transcribe(np.ones(1600, dtype=np.float32), SAMPLE_RATE, language="en")
            FasterWhisperAsr(fast=True).transcribe(np.ones(1600, dtype=np.float32), SAMPLE_RATE, language="en")

        quality, fast = calls
        self.assertFalse(quality["use_assistant_prompt"])
        self.assertFalse(fast["use_assistant_prompt"])
        self.assertEqual(quality["beam_size"], 5)
        self.assertEqual(quality["temperature"], transcribe.FALLBACK_TEMPERATURES, "loops get retried")
        self.assertTrue(quality["word_timestamps"])
        self.assertEqual((fast["beam_size"], fast["temperature"], fast["word_timestamps"]), (1, 0.0, False))

    def test_a_loop_is_collapsed_and_its_words_stay_in_step(self):
        words = [" no,", " one,"] + [" NUMZ,"] * 12
        segment = fake_segment("no, one," + " NUMZ," * 12, words)
        with mock.patch.object(
            asr_module.live_transcribe,
            "_transcribe_segments",
            lambda pcm, **kw: (iter([segment]), SimpleNamespace(language="en", language_probability=1.0)),
        ):
            result = FasterWhisperAsr().transcribe(np.ones(1600, dtype=np.float32), SAMPLE_RATE)
        self.assertEqual(result.segments[0].text, "no, one, NUMZ,")
        self.assertEqual([w["text"] for w in result.segments[0].words], ["no,", "one,", "NUMZ,"])

    def test_the_live_recognizer_uses_cheap_partials_and_careful_finals(self):
        live = LocalAgreementStreamingAsr()
        self.assertTrue(live._fast_asr.fast)
        self.assertFalse(live._quality_asr.fast)

    def test_prompt_choice(self):
        self.assertIsNone(transcribe._build_initial_prompt("", use_assistant_prompt=False))
        assistant = transcribe._build_initial_prompt("", use_assistant_prompt=True)
        self.assertNotIn(", NUMZ,", assistant, "no keyword list")
        self.assertEqual(transcribe._build_initial_prompt("My own sentence.", True), "My own sentence.")

    def test_the_whisper_call_carries_the_fallback(self):
        captured = {}

        class FakeModel:
            def transcribe(self, pcm, **kwargs):
                captured.update(kwargs)
                return iter([]), SimpleNamespace(language="en")

        with mock.patch.object(transcribe, "_load_whisper", lambda: FakeModel()):
            transcribe._transcribe_segments(np.ones(1600, dtype=np.float32), language="en-US", use_assistant_prompt=False)
        self.assertEqual(captured["temperature"], transcribe.FALLBACK_TEMPERATURES)
        self.assertEqual(captured["compression_ratio_threshold"], 2.4)
        self.assertIsNone(captured["initial_prompt"])
        self.assertEqual(captured["language"], "en")


if __name__ == "__main__":
    unittest.main()
