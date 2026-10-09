"""
The repetition guard must judge a whole decode, not one Whisper segment at a time.

Found in a real meeting on 2026-10-09: a saved line said "What's up guys? What's up? What's up? ..." fifteen
times. Whisper emits a loop as many short segments, each of which looks fine alone, so the per-segment guard
let all of them through (the same loop inside ONE segment was already collapsed). The model is mocked here:
what is under test is how the guard treats the segments the model returns.
"""

import unittest
from types import SimpleNamespace as NS
from unittest import mock

import numpy as np

import transcribe
from speech import asr as asr_module
from speech.asr import FasterWhisperAsr

PCM = np.zeros(16000, dtype=np.float32)
INFO = NS(language="en", language_probability=1.0)


def segment(text, start=0.0, with_words=True):
    """One Whisper segment; word k of the segment is timed at start + 0.3 k."""
    tokens = text.split()
    words = [NS(word=" " + t, start=start + 0.3 * i, end=start + 0.3 * i + 0.25, probability=0.9) for i, t in enumerate(tokens)] if with_words else []
    return NS(text=" " + text, start=start, end=start + 0.3 * len(tokens), words=words, avg_logprob=-0.4, no_speech_prob=0.1)


def decode(segments):
    with mock.patch.object(asr_module.live_transcribe, "_transcribe_segments", return_value=(iter(segments), INFO)):
        return FasterWhisperAsr().transcribe(PCM, 16000, language="en")


def line(result):
    return " ".join(s.text for s in result.segments)


class ALoopSplitIntoManySegments(unittest.TestCase):
    LOOP = [segment("What's up guys?")] + [segment("What's up?", start=1.2 * k) for k in range(1, 15)]

    def test_the_loop_from_the_meeting_is_collapsed(self):
        self.assertEqual(line(decode(self.LOOP)), "What's up guys? What's up?")

    def test_the_same_loop_in_one_segment_still_is(self):
        one = [segment("What's up? " * 15)]
        self.assertEqual(line(decode(one)), "What's up?")

    def test_a_loop_of_a_longer_phrase_across_segments(self):
        segments = [segment("they'll all go to the grave,", start=2 * k) for k in range(6)]  # a six-word phrase
        self.assertEqual(line(decode(segments)), "they'll all go to the grave,")

    def test_a_loop_that_starts_inside_one_segment_and_continues_in_the_next(self):
        segments = [segment("stop stop"), segment("stop stop stop right now", start=2)]  # five in a row
        result = decode(segments)
        self.assertEqual(line(result), "stop right now")

    def test_a_loop_of_three_is_speech_not_a_loop(self):
        segments = [segment("I like that."), segment("I like that.", start=2), segment("I like that great thing.", start=4)]
        self.assertEqual(line(decode(segments)), "I like that. I like that. I like that great thing.")

    def test_segments_that_were_only_loop_disappear_and_the_rest_keep_their_timings(self):
        result = decode(self.LOOP)
        self.assertEqual(len(result.segments), 2)
        first, second = result.segments
        self.assertEqual([w["text"] for w in first["words"]] if isinstance(first, dict) else [w["text"] for w in first.words], ["What's", "up", "guys?"])
        self.assertEqual([w["text"] for w in second.words], ["What's", "up?"])
        self.assertAlmostEqual(second.words[0]["start"], 1.2, places=3, msg="the kept words keep the time Whisper gave them")


class OrdinarySpeechIsLeftAlone(unittest.TestCase):
    def test_short_repeats_across_segments_are_kept(self):
        segments = [segment("No,"), segment("no, I said so", start=1)]
        self.assertEqual(line(decode(segments)), "No, no, I said so")

    def test_the_same_word_in_neighbouring_sentences_is_kept(self):
        segments = [segment("We will go."), segment("Go now, go.", start=2)]
        self.assertEqual(line(decode(segments)), "We will go. Go now, go.")

    def test_untouched_segments_keep_their_original_text(self):
        segments = [segment("And so, my fellow Americans."), segment("Ask not what your country can do for you.", start=3)]
        self.assertEqual([s.text for s in decode(segments).segments], ["And so, my fellow Americans.", "Ask not what your country can do for you."])


class WithoutWordTimings(unittest.TestCase):
    def test_the_guard_works_on_the_text_when_there_are_no_words(self):
        segments = [segment("What's up guys?", with_words=False)] + [segment("What's up?", start=k, with_words=False) for k in range(1, 15)]
        self.assertEqual(line(decode(segments)), "What's up guys? What's up?")

    def test_a_mix_of_segments_with_and_without_words(self):
        segments = [segment("stop stop", with_words=False), segment("stop stop stop right now", start=2)]
        self.assertEqual(line(decode(segments)), "stop right now")


class TheAssistantTextPath(unittest.TestCase):
    """transcribe_pcm (the assistant's speech-to-text) has the same blind spot and the same fix."""

    def test_a_loop_across_segments_is_collapsed(self):
        segments = [segment("What's up guys?")] + [segment("What's up?", start=k) for k in range(1, 15)]
        with mock.patch.object(transcribe, "_transcribe_segments", return_value=(iter(segments), INFO)):
            self.assertEqual(transcribe.transcribe_pcm(PCM, language="en"), "What's up guys? What's up?")

    def test_ordinary_text_is_joined_unchanged(self):
        segments = [segment("Turn left."), segment("Then stop.", start=2)]
        with mock.patch.object(transcribe, "_transcribe_segments", return_value=(iter(segments), INFO)):
            self.assertEqual(transcribe.transcribe_pcm(PCM, language="en"), "Turn left. Then stop.")


if __name__ == "__main__":
    unittest.main()
