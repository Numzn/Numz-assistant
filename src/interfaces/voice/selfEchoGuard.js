/**
 * Transcript-level self-echo guard.
 *
 * The audio-level protections (echo-relative barge-in, settle pauses, discarding captures that overlap playback,
 * browser echo cancellation) keep most of the assistant's own voice out. What still gets through is transcribed
 * like any other speech: a capture that began just after playback, a room tail, a speaker that is late. By then
 * the only thing left to compare is the text, and the assistant knows exactly what it said.
 *
 * This keeps a short log of what was handed to the speech output, and answers one question about a transcript:
 * "is this the assistant's own words coming back?" Only when ALL of these hold:
 *   - the capture began while the assistant was speaking, or within `windowMs` after it stopped
 *   - the transcript has at least `minTokens` words (a word or two cannot be told apart from a real answer)
 *   - at least `threshold` of its words sit inside runs of three or more words that the assistant just said
 *     (single-word recognition slips and spelling variants are tolerated; common two-word phrases do not count)
 *   - it carries no interruption word the assistant did not say ("stop" said over an echo is the user's)
 *
 * What it cannot do, and what that costs: a user who repeats three or more of the assistant's words, in order,
 * inside the window is taken for an echo and not heard. The measured rates are in docs/voice-self-echo.md and
 * tests/selfEchoGuard.test.js; they are properties of that test corpus, not promises about every voice and room.
 *
 * Pure: no browser APIs, no timers, an injectable clock.
 */

const DEFAULTS = Object.freeze({
  windowMs: 1500, // how long after it stops the assistant's words can still come back (the input layer settles for 0.7 s)
  memoryMs: 60_000, // how long the log is kept
  openGroupMs: 15_000, // a group that never reported its end is treated as ended this long after its last chunk
  minTokens: 3,
  threshold: 0.7,
  maxSpokenTokens: 600,
  maxTranscriptTokens: 60
})

// Words that mean "stop what you are doing". Said over an echo they are the user's, not the assistant's.
const INTERRUPTIONS = new Set(['stop', 'cancel', 'wait', 'pause', 'quiet', 'silence', 'enough', 'shush', 'hold'])

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

function editDistanceAtMostOne(a, b) {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (la > lb) i++
    else if (lb > la) j++
    else {
      i++
      j++
    }
  }
  return edits + (la - i) + (lb - j) <= 1
}

/** Same word, or a one-letter recognition slip of a word long enough that one letter is not a different word. */
function sameWord(a, b) {
  if (a === b) return true
  return a.length >= 5 && b.length >= 5 && editDistanceAtMostOne(a, b)
}

/** The share of `heard` that lies inside runs of 3+ consecutive words also present, in order, in `spoken`. */
export function echoCoverage(heard, spoken) {
  const n = heard.length
  const m = spoken.length
  if (n < 3 || m < 3) return 0
  const covered = new Array(n).fill(false)
  for (let i = 0; i + 2 < n; i++) {
    for (let j = 0; j + 2 < m; j++) {
      if (sameWord(heard[i], spoken[j]) && sameWord(heard[i + 1], spoken[j + 1]) && sameWord(heard[i + 2], spoken[j + 2])) {
        covered[i] = covered[i + 1] = covered[i + 2] = true
        break
      }
    }
  }
  // One word between two echoed runs is a recognition slip inside the echo, not a word of the user's.
  for (let i = 1; i + 1 < n; i++) {
    if (!covered[i] && covered[i - 1] && covered[i + 1]) covered[i] = true
  }
  return covered.filter(Boolean).length / n
}

export function createSelfEchoGuard({ now = () => globalThis.performance?.now?.() ?? Date.now(), ...options } = {}) {
  const config = { ...DEFAULTS, ...options }
  /** Each group is one stretch of speech: { startAt, endAt | null, lastChunkAt, tokens } */
  let groups = []

  function prune(t) {
    groups = groups.filter((group) => t - (group.endAt ?? group.lastChunkAt) <= config.memoryMs)
  }

  function effectiveEnd(group) {
    return group.endAt ?? group.lastChunkAt + config.openGroupMs
  }

  return {
    config,

    /** A piece of the reply was handed to the speech output. */
    noteSpoken(text) {
      const tokens = tokenize(text)
      if (tokens.length === 0) return
      const t = now()
      prune(t)
      let group = groups.at(-1)
      if (!group || group.endAt !== null) {
        group = { startAt: t, endAt: null, lastChunkAt: t, tokens: [] }
        groups.push(group)
      }
      group.lastChunkAt = t
      group.tokens.push(...tokens)
      if (group.tokens.length > config.maxSpokenTokens) group.tokens = group.tokens.slice(-config.maxSpokenTokens)
    },

    /** The assistant stopped speaking (finished, interrupted, or cancelled). */
    noteSpeechEnded() {
      const group = groups.at(-1)
      if (group && group.endAt === null) group.endAt = now()
    },

    /** Forget everything (a new session). */
    reset() {
      groups = []
    },

    /**
     * capturedAt: when the capture began (the clock `now` uses). Defaults to now.
     * -> { echo: boolean, score: number, reason: string }
     */
    check(text, { capturedAt } = {}) {
      const t = now()
      const started = typeof capturedAt === 'number' ? capturedAt : t
      const heard = tokenize(text).slice(0, config.maxTranscriptTokens)
      if (heard.length < config.minTokens) return { echo: false, score: 0, reason: 'too-short' }
      prune(t)
      const candidates = groups.filter((group) => started <= effectiveEnd(group) + config.windowMs)
      if (candidates.length === 0) return { echo: false, score: 0, reason: 'no-recent-speech' }

      const spoken = candidates.flatMap((group) => group.tokens)
      const spokenWords = new Set(spoken)
      if (heard.some((word) => INTERRUPTIONS.has(word) && !spokenWords.has(word))) {
        return { echo: false, score: 0, reason: 'interruption-word' }
      }
      const score = echoCoverage(heard, spoken)
      return score >= config.threshold
        ? { echo: true, score, reason: 'matches-assistant-speech' }
        : { echo: false, score, reason: 'not-the-assistant-speech' }
    }
  }
}
