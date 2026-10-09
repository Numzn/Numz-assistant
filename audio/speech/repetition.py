"""
Collapse Whisper's repetition loops ("stop, stop, stop, stop, ...", "NUMZ, NUMZ, NUMZ, ...").

Whisper sometimes gets stuck emitting the same word or short phrase over and over, typically on short,
ambiguous audio. faster-whisper's temperature fallback catches most of these (see transcribe.py), but
not all, and a loop that reaches a meeting transcript is worse than a dropped repeat. This cuts any run
where the same word or phrase (up to four words) repeats more than `max_repeats` times in a row down to
one occurrence. Legitimate short repeats ("no, no", "very very") are left alone.
"""

import re
from typing import List

MAX_REPEATS = 3
MAX_PHRASE_WORDS = 8


def _norm(token: str) -> str:
    return re.sub(r"[^\w']+", "", token.lower())


def keep_mask(tokens: List[str], max_repeats: int = MAX_REPEATS, max_phrase: int = MAX_PHRASE_WORDS) -> List[bool]:
    """For each token, whether it survives. Tokens are compared ignoring case and punctuation."""
    norms = [_norm(t) for t in tokens]
    keep = [True] * len(tokens)
    changed = True
    while changed:
        changed = False
        alive = [i for i, k in enumerate(keep) if k]
        for size in range(1, max_phrase + 1):
            i = 0
            while i + size <= len(alive):
                phrase = [norms[alive[i + k]] for k in range(size)]
                if not all(phrase):
                    i += 1
                    continue
                runs = 1
                j = i + size
                while j + size <= len(alive) and [norms[alive[j + k]] for k in range(size)] == phrase:
                    runs += 1
                    j += size
                if runs > max_repeats:
                    for position in alive[i + size : j]:
                        keep[position] = False
                    changed = True
                    break
                i += 1
            if changed:
                break
    return keep


def collapse_repetitions(text: str, max_repeats: int = MAX_REPEATS, max_phrase: int = MAX_PHRASE_WORDS) -> str:
    tokens = text.split()
    mask = keep_mask(tokens, max_repeats, max_phrase)
    return " ".join(t for t, k in zip(tokens, mask) if k)
