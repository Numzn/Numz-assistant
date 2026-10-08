import unittest

import numpy as np

from speech.live.events import TranscriptEvent, TranscriptStage, validate_audio_frame
from speech.reconciler import TranscriptReconciler
from speech.schema import make_segment, make_transcript, validate_transcript


class TranscriptReconcilerTests(unittest.TestCase):
    def test_partial_updates_never_enter_committed_segments(self):
        reconciler = TranscriptReconciler(language="en")

        first = TranscriptEvent(TranscriptStage.PARTIAL, "we deploy", 0.0, 1.0)
        changed = TranscriptEvent(TranscriptStage.STABILIZING, "we deploy Friday", 0.0, 1.5)

        self.assertIsNone(reconciler.apply(first).committed)
        self.assertEqual(reconciler.partial.text, "we deploy")
        self.assertIsNone(reconciler.apply(changed).committed)
        self.assertEqual(reconciler.partial.text, "we deploy Friday")
        self.assertEqual(reconciler.segments, [])

    def test_final_commits_once_with_stable_id_and_clears_partial(self):
        reconciler = TranscriptReconciler(
            language="en",
            speaker_resolver=lambda _event: ("speaker_01", False),
        )
        reconciler.apply(TranscriptEvent(TranscriptStage.PARTIAL, "hello", 0.0, 0.5))

        result = reconciler.apply(
            TranscriptEvent(TranscriptStage.FINAL, "hello world", 0.0, 1.0)
        )

        self.assertEqual(result.committed["id"], "seg_0001")
        self.assertIsNone(reconciler.partial)
        self.assertEqual(reconciler.speakers, ["speaker_01"])
        self.assertEqual(len(reconciler.segments), 1)

        second = reconciler.apply(
            TranscriptEvent(TranscriptStage.FINAL, "next", 1.0, 1.5)
        )
        self.assertEqual(second.committed["id"], "seg_0002")

    def test_final_event_speaker_metadata_takes_precedence(self):
        reconciler = TranscriptReconciler(
            speaker_resolver=lambda _event: ("resolver-speaker", False)
        )
        result = reconciler.apply(
            TranscriptEvent(
                TranscriptStage.FINAL,
                "hello",
                0.0,
                0.5,
                speaker="event-speaker",
            )
        )
        self.assertEqual(result.committed["speaker"], "event-speaker")

    def test_invalid_event_timestamps_are_rejected(self):
        reconciler = TranscriptReconciler()
        with self.assertRaises(ValueError):
            reconciler.apply(TranscriptEvent(TranscriptStage.FINAL, "bad", 2.0, 1.0))


class TranscriptSchemaTests(unittest.TestCase):
    def test_valid_transcript_passes(self):
        transcript = make_transcript(
            source="fixture",
            duration_s=2.0,
            language="en",
            segments=[make_segment("seg_0001", 0.0, 1.0, "hello")],
            speakers=[],
            meta={},
        )
        self.assertIs(validate_transcript(transcript), transcript)

    def test_duplicate_ids_are_rejected(self):
        segment = make_segment("seg_0001", 0.0, 1.0, "hello")
        transcript = make_transcript(
            source="fixture",
            duration_s=2.0,
            language="en",
            segments=[segment, dict(segment, start=1.0, end=2.0)],
            speakers=[],
            meta={},
        )
        with self.assertRaisesRegex(ValueError, "duplicate"):
            validate_transcript(transcript)

    def test_out_of_bounds_segments_are_rejected(self):
        transcript = make_transcript(
            source="fixture",
            duration_s=1.0,
            language="en",
            segments=[make_segment("seg_0001", 0.0, 1.1, "hello")],
            speakers=[],
            meta={},
        )
        with self.assertRaisesRegex(ValueError, "out of bounds"):
            validate_transcript(transcript)


class AudioFrameContractTests(unittest.TestCase):
    def test_valid_float32_mono_frame_passes(self):
        frame = np.zeros(1600, dtype=np.float32)
        self.assertIs(validate_audio_frame(frame, 16000, 0.1), frame)

    def test_non_finite_frame_is_rejected(self):
        frame = np.array([0.0, np.nan], dtype=np.float32)
        with self.assertRaisesRegex(ValueError, "non-finite"):
            validate_audio_frame(frame, 16000, 0.1)

    def test_wrong_shape_and_dtype_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "one-dimensional"):
            validate_audio_frame(np.zeros((2, 2), dtype=np.float32), 16000, 0.1)
        with self.assertRaisesRegex(ValueError, "float32"):
            validate_audio_frame(np.zeros(2, dtype=np.float64), 16000, 0.1)


if __name__ == "__main__":
    unittest.main()
