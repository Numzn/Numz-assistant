"""
Telling "you" from "others" by which audio source was sounding while a line was spoken.

The recognizer still hears ONE mixed stream; the browser only reports, for every 100 ms frame, how loud the
microphone and the shared tab/system audio were. These tests pin the rule (see speech/live/source_labels.py),
then the way a session uses it. Thresholds are unmeasured defaults: what is pinned here is the shape of the
rule, not that the numbers suit any real room.
"""

import logging
import os
import unittest
from unittest import mock

import numpy as np

from speech.live.diarization_live import SingleSpeakerLiveDiarizer
from speech.live.session import LiveSpeechSession
from speech.live.source_labels import SourceLabelConfig, SourceLevelLabeler
from tests.fakes_live import EnergyVad, ScriptedAsr, silence_frames, speech_frames

FRAME_S = 0.1


def note_frames(labeler, count, mic, tab, start_s=0.0):
    """Notes `count` frames of 100 ms from start_s; returns where the stream is afterwards."""
    position = start_s
    for _ in range(count):
        position = round(position + FRAME_S, 6)
        labeler.note(position, FRAME_S, mic, tab)
    return position


class SourceLabelRuleTests(unittest.TestCase):
    def setUp(self):
        self.labeler = SourceLevelLabeler(SourceLabelConfig())

    def test_the_shared_tab_alone_is_others(self):
        note_frames(self.labeler, 20, mic=0.0, tab=0.1)
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), ("others", False))

    def test_the_microphone_alone_is_you(self):
        note_frames(self.labeler, 20, mic=0.1, tab=0.0)
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), ("you", False))

    def test_both_sounding_with_the_microphone_far_louder_is_you_but_uncertain(self):
        note_frames(self.labeler, 20, mic=0.2, tab=0.02)  # 10x, about 20 dB
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), ("you", True))

    def test_both_sounding_with_the_tab_far_louder_is_others_but_uncertain(self):
        note_frames(self.labeler, 20, mic=0.02, tab=0.2)
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), ("others", True))

    def test_both_sounding_about_equally_is_not_labelled(self):
        note_frames(self.labeler, 20, mic=0.1, tab=0.08)
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), (None, True))

    def test_the_edge_of_the_dominance_rule(self):
        # Exactly the configured ratio (3x) counts as dominant; just under it does not.
        note_frames(self.labeler, 10, mic=0.3, tab=0.1)
        self.assertEqual(self.labeler.speaker_for_span(0.0, 1.0), ("you", True))
        other = SourceLevelLabeler(SourceLabelConfig())
        note_frames(other, 10, mic=0.29, tab=0.1)
        self.assertEqual(other.speaker_for_span(0.0, 1.0), (None, True))

    def test_nothing_sounding_is_not_labelled(self):
        note_frames(self.labeler, 20, mic=0.0, tab=0.0)
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), (None, True))

    def test_a_line_with_no_levels_at_all_is_not_labelled(self):
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), (None, True), "nothing was ever noted")
        note_frames(self.labeler, 10, mic=0.1, tab=0.0)
        self.assertEqual(self.labeler.speaker_for_span(5.0, 6.0), (None, True), "levels exist, but not for this span")

    def test_a_line_only_looks_at_its_own_frames(self):
        position = note_frames(self.labeler, 20, mic=0.1, tab=0.0)  # you, 0 - 2 s
        note_frames(self.labeler, 20, mic=0.0, tab=0.1, start_s=position)  # others, 2 - 4 s
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), ("you", False))
        self.assertEqual(self.labeler.speaker_for_span(2.0, 4.0), ("others", False))
        self.assertEqual(self.labeler.speaker_for_span(0.0, 4.0), (None, True), "both spoke inside one line")

    def test_a_missing_reading_is_absent_not_silent(self):
        note_frames(self.labeler, 20, mic=None, tab=0.1)  # the microphone reported nothing
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), ("others", False))
        blank = SourceLevelLabeler(SourceLabelConfig())
        note_frames(blank, 20, mic=None, tab=None)
        self.assertEqual(blank.speaker_for_span(0.0, 2.0), (None, True))

    def test_a_source_must_sound_in_enough_of_the_line_to_count(self):
        # The tab sounds in 2 of 20 frames (10%): below the 25% share, so it is background, not a speaker.
        position = note_frames(self.labeler, 2, mic=0.1, tab=0.1)
        note_frames(self.labeler, 18, mic=0.1, tab=0.0, start_s=position)
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), ("you", False))

    def test_readings_that_are_not_numbers_are_ignored(self):
        for bad in (float("nan"), float("inf"), -0.5, "loud", True):
            self.labeler.note(0.1, FRAME_S, bad, bad)
        self.assertEqual(self.labeler.speaker_for_span(0.0, 1.0), (None, True))
        self.assertEqual(len(self.labeler), 5, "the frames were seen; only their readings were unusable")

    def test_the_microphone_s_own_noise_is_not_a_speaker(self):
        # A levelled microphone in a quiet room still reads well above the absolute threshold (-50 dBFS =
        # 0.003): here 0.01. Its own floor, learned from the meeting so far, is what speech must stand above.
        position = note_frames(self.labeler, 100, mic=0.01, tab=0.0)  # ten seconds of room noise
        position = note_frames(self.labeler, 30, mic=0.01, tab=0.1, start_s=position)  # the tab speaks over it
        self.assertEqual(self.labeler.speaker_for_span(10.0, position), ("others", False))
        spoken = note_frames(self.labeler, 30, mic=0.2, tab=0.0, start_s=position)  # then the user does
        self.assertEqual(self.labeler.speaker_for_span(position, spoken), ("you", False))

    def test_with_too_little_history_only_the_absolute_threshold_applies(self):
        note_frames(self.labeler, 20, mic=0.01, tab=0.0)  # two seconds: no floor can be learned yet
        self.assertEqual(self.labeler.speaker_for_span(0.0, 2.0), ("you", False))

    def test_history_is_bounded(self):
        position = note_frames(self.labeler, 4000, mic=0.0, tab=0.0)  # 400 s
        self.assertLessEqual(len(self.labeler), int(self.labeler.config.history_s / FRAME_S) + 2)
        self.assertEqual(position, 400.0)

    def test_it_satisfies_the_live_diarizer_interface(self):
        note_frames(self.labeler, 20, mic=0.0, tab=0.1)
        self.assertEqual(self.labeler.name, "source-levels")
        self.assertEqual(self.labeler.current_speaker(1.0), ("others", False))


class SourceLabelConfigTests(unittest.TestCase):
    def test_defaults(self):
        config = SourceLabelConfig()
        self.assertAlmostEqual(20 * np.log10(config.sound_rms), -50.0, places=3)
        self.assertEqual(config.min_share, 0.25)
        self.assertAlmostEqual(config.dominance_ratio, 3.0)
        self.assertEqual(config.history_s, 120.0)

    def test_environment_overrides(self):
        env = {"LIVE_SOURCE_SOUND_DBFS": "-40", "LIVE_SOURCE_MIN_SHARE": "0.5", "LIVE_SOURCE_DOMINANCE_DB": "6"}
        with mock.patch.dict(os.environ, env):
            config = SourceLabelConfig.from_env()
        self.assertAlmostEqual(20 * np.log10(config.sound_rms), -40.0, places=3)
        self.assertEqual(config.min_share, 0.5)
        self.assertAlmostEqual(20 * np.log10(config.dominance_ratio), 6.0, places=3)

    def test_nonsense_falls_back_to_the_default_and_says_so(self):
        env = {"LIVE_SOURCE_SOUND_DBFS": "loud", "LIVE_SOURCE_MIN_SHARE": "7", "LIVE_SOURCE_DOMINANCE_DB": "-3"}
        with mock.patch.dict(os.environ, env), self.assertLogs("speech.live.source_labels", level=logging.WARNING) as logs:
            config = SourceLabelConfig.from_env()
        self.assertEqual(config, SourceLabelConfig())
        self.assertEqual(len(logs.records), 3)


def feed_with_levels(session, frames, position, mic, tab):
    """Feeds frames at 100 ms cadence, telling the session each frame's source levels first, as the transport does."""
    for frame in frames:
        position = round(position + len(frame) / 16000, 6)
        session.note_source_levels(position, len(frame) / 16000, mic, tab)
        session.ingest_audio_frame(frame, timestamp_s=position)
    return position


def labelled_session():
    return LiveSpeechSession(streaming_asr=ScriptedAsr(), frame_vad=EnergyVad(), diarizer=SourceLevelLabeler())


class SessionLabelTests(unittest.TestCase):
    def test_each_line_is_labelled_from_the_levels_of_its_own_span(self):
        session = labelled_session()
        position = feed_with_levels(session, speech_frames(10), 0.0, mic=0.2, tab=0.0)
        position = feed_with_levels(session, silence_frames(8), position, mic=0.0, tab=0.0)  # the user pauses
        position = feed_with_levels(session, speech_frames(10), position, mic=0.0, tab=0.2)
        feed_with_levels(session, silence_frames(8), position, mic=0.0, tab=0.0)
        session.end()
        segments = session.finalized_segments
        self.assertEqual([(s["speaker"], s["uncertain"]) for s in segments], [("you", False), ("others", False)])
        self.assertEqual(session.speakers, {"you", "others"})

    def test_an_overlapping_line_is_kept_but_marked_uncertain(self):
        session = labelled_session()
        position = feed_with_levels(session, speech_frames(10), 0.0, mic=0.1, tab=0.1)
        feed_with_levels(session, silence_frames(8), position, mic=0.0, tab=0.0)
        session.end()
        (segment,) = session.finalized_segments
        self.assertEqual((segment["speaker"], segment["uncertain"]), (None, True))
        self.assertEqual(segment["text"], "utt 1", "what was said is never dropped for want of a label")

    def test_the_transcript_says_which_engine_labelled_it(self):
        session = labelled_session()
        position = feed_with_levels(session, speech_frames(10), 0.0, mic=0.2, tab=0.0)
        feed_with_levels(session, silence_frames(8), position, mic=0.0, tab=0.0)
        session.end()
        transcript = session.transcript()
        self.assertEqual(transcript["speakers"], ["you"])
        self.assertEqual(transcript["meta"]["diarization"], {"engine": "source-levels", "enabled": True})

    def test_a_session_without_a_labeller_is_exactly_what_it_was(self):
        session = LiveSpeechSession(streaming_asr=ScriptedAsr(), frame_vad=EnergyVad())
        position = feed_with_levels(session, speech_frames(10), 0.0, mic=0.2, tab=0.0)  # levels are accepted and unused
        feed_with_levels(session, silence_frames(8), position, mic=0.0, tab=0.0)
        session.end()
        (segment,) = session.finalized_segments
        self.assertEqual((segment["speaker"], segment["uncertain"]), ("speaker_00", False))
        self.assertEqual(session.transcript()["meta"]["diarization"], {"engine": "none", "enabled": False})

    def test_a_diarizer_that_only_knows_a_moment_is_still_asked_for_the_middle_of_the_line(self):
        class AtAMoment:
            name = "at-a-moment"

            def __init__(self):
                self.asked = []

            def current_speaker(self, timestamp_s):
                self.asked.append(timestamp_s)
                return "speaker_07", False

        diarizer = AtAMoment()
        session = LiveSpeechSession(streaming_asr=ScriptedAsr(), frame_vad=EnergyVad(), diarizer=diarizer)
        position = feed_with_levels(session, speech_frames(10), 0.0, mic=0.2, tab=0.0)
        feed_with_levels(session, silence_frames(8), position, mic=0.0, tab=0.0)
        session.end()
        (segment,) = session.finalized_segments
        self.assertEqual(segment["speaker"], "speaker_07")
        self.assertEqual(len(diarizer.asked), 1)
        self.assertAlmostEqual(diarizer.asked[0], (segment["start"] + segment["end"]) / 2, places=3)

    def test_the_default_diarizer_is_unchanged(self):
        self.assertEqual(SingleSpeakerLiveDiarizer().current_speaker(3.0), ("speaker_00", False))


if __name__ == "__main__":
    unittest.main()
