"""The scorer every accuracy number in this repository comes from (speech/scoring.py)."""

import unittest

from speech import scoring


class WordErrorTests(unittest.TestCase):
    def test_a_perfect_match_scores_zero(self):
        result = scoring.word_errors("the budget is approved", "the budget is approved")
        self.assertEqual((result["wer"], result["substitutions"], result["deletions"], result["insertions"]), (0.0, 0, 0, 0))
        self.assertEqual(result["reference_words"], 4)

    def test_substitution_deletion_and_insertion_are_told_apart(self):
        reference = "we ship the release on friday"
        self.assertEqual(scoring.word_errors("we ship the release on monday", reference)["substitutions"], 1)
        self.assertEqual(scoring.word_errors("we ship release on friday", reference)["deletions"], 1)
        self.assertEqual(scoring.word_errors("we ship the new release on friday", reference)["insertions"], 1)

    def test_case_and_punctuation_are_not_errors(self):
        self.assertEqual(scoring.word_errors("We ship, the release: on FRIDAY!", "we ship the release on friday")["wer"], 0.0)

    def test_digits_count_as_words(self):
        # A scorer that dropped digits would score "unit 42" and "unit 17" as identical.
        result = scoring.word_errors("move unit 17 to bay 3", "move unit 42 to bay 3")
        self.assertEqual((result["substitutions"], result["reference_words"]), (1, 6))
        self.assertGreater(result["wer"], 0.0)

    def test_nothing_heard_is_every_word_deleted(self):
        result = scoring.word_errors("", "one two three")
        self.assertEqual((result["wer"], result["deletions"]), (1.0, 3))

    def test_an_empty_reference_is_refused_rather_than_scored_as_perfect(self):
        with self.assertRaises(ValueError):
            scoring.word_errors("anything", "  ...  ")


class ExcessRepeatTests(unittest.TestCase):
    def test_a_loop_is_reported(self):
        looped = "what's up what's up what's up what's up"
        self.assertTrue(scoring.excess_repeats(looped, "what's up"))

    def test_a_phrase_the_reference_repeats_is_not_a_loop(self):
        reference = "can do for you and what you can do for your country"
        self.assertEqual(scoring.excess_repeats(reference, reference), [])

    def test_a_deleted_word_is_not_a_repeat(self):
        self.assertEqual(scoring.excess_repeats("and so my fellow", "and so my fellow americans"), [])


if __name__ == "__main__":
    unittest.main()
