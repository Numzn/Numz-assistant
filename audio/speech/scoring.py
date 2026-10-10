"""
Word error rate, the one definition used everywhere in this repository: the opt-in real-audio tests
(tests/real_audio.py) and the replay tool (replay_cli.py) both score with this, so their numbers compare.

Case and punctuation do not count as errors. Digits do count as words, so write numbers in a reference the
way Whisper writes them ("42", not "forty two"); the scorer does not convert between the two forms.
"""

import re


def words(text: str) -> list:
    """Lower-case words: letters, digits and apostrophes only."""
    return re.sub(r"[^a-z0-9' ]+", " ", (text or "").lower()).split()


def word_errors(hypothesis: str, reference: str) -> dict:
    """Word error rate with its parts, by minimum edit distance: substitutions, deletions, insertions."""
    h, r = words(hypothesis), words(reference)
    if not r:
        raise ValueError("the reference has no words to score against")
    # cost[i][j] = (edits, substitutions, deletions, insertions) turning r[:i] into h[:j]
    cost = [[None] * (len(h) + 1) for _ in range(len(r) + 1)]
    cost[0][0] = (0, 0, 0, 0)
    for i in range(1, len(r) + 1):
        e = cost[i - 1][0]
        cost[i][0] = (e[0] + 1, e[1], e[2] + 1, e[3])
    for j in range(1, len(h) + 1):
        e = cost[0][j - 1]
        cost[0][j] = (e[0] + 1, e[1], e[2], e[3] + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            e = cost[i - 1][j - 1]
            sub = (e[0] + (r[i - 1] != h[j - 1]), e[1] + (r[i - 1] != h[j - 1]), e[2], e[3])
            e = cost[i - 1][j]
            dele = (e[0] + 1, e[1], e[2] + 1, e[3])
            e = cost[i][j - 1]
            ins = (e[0] + 1, e[1], e[2], e[3] + 1)
            cost[i][j] = min(sub, dele, ins)
    edits, subs, dels, inss = cost[len(r)][len(h)]
    return {
        "wer": round(edits / len(r), 3),
        "substitutions": subs,
        "deletions": dels,
        "insertions": inss,
        "reference_words": len(r),
    }


def excess_repeats(hypothesis: str, reference: str, size: int = 3) -> list:
    """Word sequences of `size` words that the hypothesis says at least twice AND more often than the
    reference does: the symptom of a decoding loop. (A phrase the reference itself repeats is not one, and a
    word the recognizer missed leaves a sequence the reference lacks, said once, which is a deletion.)"""

    def counts(text):
        tokens = words(text)
        found = {}
        for i in range(len(tokens) - size + 1):
            gram = tuple(tokens[i : i + size])
            found[gram] = found.get(gram, 0) + 1
        return found

    expected, heard = counts(reference), counts(hypothesis)
    return [" ".join(gram) for gram, n in sorted(heard.items()) if n >= 2 and n > expected.get(gram, 0)]
