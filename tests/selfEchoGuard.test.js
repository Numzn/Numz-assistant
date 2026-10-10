import assert from 'node:assert/strict'
import test from 'node:test'
import { createSelfEchoGuard, echoCoverage, tokenize } from '../src/interfaces/voice/selfEchoGuard.js'

// ---- the unit behaviour ---------------------------------------------------------------------------------

function guardAt() {
  let t = 10_000
  const guard = createSelfEchoGuard({ now: () => t })
  return { guard, at: (ms) => (t = ms), advance: (ms) => (t += ms), now: () => t }
}

test('words are compared without case, punctuation or apostrophes', () => {
  assert.deepEqual(tokenize("It's  exactly NOON, isn't it?"), ['its', 'exactly', 'noon', 'isnt', 'it'])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
})

test('nothing is an echo before the assistant has spoken', () => {
  const { guard } = guardAt()
  assert.deepEqual(guard.check('the time is exactly noon'), { echo: false, score: 0, reason: 'no-recent-speech' })
})

test('the assistant\'s own sentence, heard during or just after its speech, is an echo', () => {
  const { guard, advance } = guardAt()
  guard.noteSpoken('The time is exactly noon. You have a meeting at one thirty.')
  advance(1500)
  assert.equal(guard.check('the time is exactly noon you have a meeting').echo, true, 'while it is still speaking')
  guard.noteSpeechEnded()
  advance(500)
  assert.equal(guard.check('you have a meeting at one thirty').echo, true, 'just after it stopped')
})

test('the same words long after the speech are the user\'s', () => {
  const { guard, advance } = guardAt()
  guard.noteSpoken('The time is exactly noon.')
  advance(1000)
  guard.noteSpeechEnded()
  advance(30_000)
  const verdict = guard.check('the time is exactly noon')
  assert.equal(verdict.echo, false)
  assert.equal(verdict.reason, 'no-recent-speech')
})

test('the capture time decides, not when the transcript arrives (transcription takes a while)', () => {
  const { guard, advance, now } = guardAt()
  guard.noteSpoken('Photosynthesis is the process plants use to turn sunlight into sugar.')
  advance(2000)
  guard.noteSpeechEnded()
  const capturedAt = now() + 300 // began right after it stopped
  advance(6000) // and the transcript came back much later
  assert.equal(guard.check('the process plants use to turn sunlight', { capturedAt }).echo, true)
  assert.equal(guard.check('the process plants use to turn sunlight').echo, false, 'a capture that began now is not')
})

test('one or two words are never suppressed: they cannot be told from a real answer', () => {
  const { guard } = guardAt()
  guard.noteSpoken('Yes, the meeting notes were saved.')
  assert.equal(guard.check('yes').echo, false)
  assert.equal(guard.check('notes saved').echo, false)
})

test('an interruption word that the assistant did not say is kept even in the middle of an echo', () => {
  const { guard } = guardAt()
  guard.noteSpoken('Here are the steps. First, preheat the oven. Second, mix the flour and the sugar.')
  assert.equal(guard.check('first preheat the oven second mix the flour').echo, true)
  const verdict = guard.check('first preheat the oven stop')
  assert.equal(verdict.echo, false)
  assert.equal(verdict.reason, 'interruption-word')
})

test('a transcript that merely shares common words or two-word phrases is not an echo', () => {
  const { guard } = guardAt()
  guard.noteSpoken('I found three restaurants nearby. The closest is an Italian place about five minutes away.')
  for (const heard of [
    'what is the closest hospital',
    'is there an italian place that is open',
    'how many minutes away is the station',
    'find me three good places nearby'
  ]) {
    assert.equal(guard.check(heard).echo, false, heard)
  }
})

test('a single recognition slip inside an echo does not hide it', () => {
  const { guard } = guardAt()
  guard.noteSpoken('A car engine works by burning a mixture of fuel and air inside cylinders.')
  assert.equal(guard.check('a car engine works by burning a mixture of fuel and ear inside cylinders').echo, true)
  assert.equal(guard.check('a car engine works by burning a mixtures of fuel and air inside cylinder').echo, true, 'spelling variants')
})

test('the log is bounded: old speech is forgotten, long speech is capped', () => {
  const { guard, advance } = guardAt()
  for (let i = 0; i < 300; i++) {
    guard.noteSpoken(`this is sentence number ${i} of a very long reply that keeps going`)
    advance(10)
  }
  guard.noteSpeechEnded()
  advance(5 * 60_000)
  assert.equal(guard.check('this is sentence number 299 of a very long reply').echo, false)
})

test('a group that never reported its end stops counting after a while', () => {
  const { guard, advance } = guardAt()
  guard.noteSpoken('The weather tomorrow looks mild with a light breeze.')
  advance(40_000) // no noteSpeechEnded() ever came
  assert.equal(guard.check('the weather tomorrow looks mild with a light breeze').echo, false)
})

test('coverage is zero for transcripts shorter than a run', () => {
  assert.equal(echoCoverage(['a', 'b'], ['a', 'b', 'c']), 0)
  assert.equal(echoCoverage(['a', 'b', 'c'], ['a', 'b', 'c']), 1)
})

// ---- measured against a corpus --------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const REPLIES = [
  'The time is exactly noon. You have a meeting with the design team at one thirty, so there is plenty of time to prepare.',
  'A car engine works by burning a mixture of fuel and air inside cylinders, which pushes pistons that turn the crankshaft and drive the wheels.',
  'I can set a timer for five minutes. Would you like me to start it now or after you finish your tea?',
  'Photosynthesis is the process plants use to turn sunlight, water and carbon dioxide into sugar and oxygen.',
  'Sure, here is a short summary of the meeting: the team agreed to move the launch to Friday and assigned the testing to Priya.',
  'The weather tomorrow looks mild with a light breeze, a high of eighteen degrees and a small chance of rain in the evening.',
  'To reset your password, open the settings page, choose security, and then select the reset option. You will get an email with a link.',
  'Python is a general purpose programming language known for its readable syntax and large collection of libraries.',
  'I found three restaurants nearby. The closest is an Italian place about five minutes away, and it is open until ten.',
  'Your battery is at forty percent. I recommend plugging in soon, because the screen brightness is quite high right now.',
  'Here are the steps. First, preheat the oven. Second, mix the flour and the sugar. Third, bake for twenty five minutes.',
  'Yes, the meeting notes were saved. There were eleven lines and the transcript is complete.'
]

const VOCABULARY = [...new Set(REPLIES.flatMap((reply) => tokenize(reply)))]

/** What the assistant's voice looks like after the room and the recognizer: exact, cut off, or with slips. */
function echoVariants(reply, random) {
  const words = tokenize(reply)
  const pick = (from, length) => words.slice(from, from + length).join(' ')
  const slip = (list, rate) =>
    list
      .flatMap((word) => {
        const r = random()
        if (r < rate / 2) return [VOCABULARY[Math.floor(random() * VOCABULARY.length)]] // heard as another word
        if (r < rate) return [] // not heard
        return [word]
      })
      .join(' ')
  const out = [
    { kind: 'exact', text: words.join(' ') },
    { kind: 'prefix', text: pick(0, 6) },
    { kind: 'suffix', text: pick(Math.max(0, words.length - 6), 6) },
    { kind: 'middle', text: pick(Math.floor(words.length / 3), 6) },
    { kind: 'noisy', text: slip(words, 0.15) },
    { kind: 'noisy-fragment', text: slip(words.slice(2, 12), 0.1) }
  ]
  return out.filter((entry) => tokenize(entry.text).length >= 3)
}

// Said by a person. "overlap" is the hard case: it shares words with what the assistant said.
const GENUINE = [
  'what time is it', 'stop', 'yes please', 'can you explain that again', 'set a timer for ten minutes',
  'tell me more about electric engines', 'what is the weather like in london', 'start a meeting called weekly sync',
  'no thanks', 'who won the football match last night', 'read me my notes', 'how do i make pancakes',
  'remind me to call mum at six', 'what is the capital of australia', 'turn the volume down', 'play something relaxing',
  'summarise the last meeting for me', 'what is on my calendar tomorrow', 'how long does it take to fly to paris',
  'add milk and eggs to my shopping list', 'is it going to rain this weekend', 'translate good morning into french',
  'how many calories are in an apple', 'wake me up at seven', 'what does photosynthesis mean',
  'explain how a battery works', 'how far is the nearest restaurant', 'are there any good italian places',
  'can you save the notes', 'how many lines were there', 'what is the sugar content of cola',
  'tell me about the weather in paris', 'please repeat the last sentence', 'what was the time of the meeting'
]
const OVERLAP = [
  // quoting or following the assistant: shares words, but the user's own words are in there too
  'what do you mean by exactly noon', 'is the meeting at one thirty or two', 'how long is five minutes in the oven',
  'which settings page do you mean', 'did the team agree to move the launch', 'why is the screen brightness high',
  'who is Priya', 'and then bake for how long', 'what is the process plants use for that',
  'can the closest place take a booking', 'is it open until ten tonight', 'do i mix the flour first'
]
// Following the assistant's instructions word for word: indistinguishable from an echo by text. Counted, not hidden.
const REPEATING = ['open the settings page', 'preheat the oven', 'mix the flour and the sugar']

function simulate({ windowMs, threshold } = {}) {
  const random = rng(20261010)
  let t = 0
  const guard = createSelfEchoGuard({ now: () => t, ...(windowMs ? { windowMs } : {}), ...(threshold ? { threshold } : {}) })
  const result = {
    echo: { total: 0, caught: 0, byKind: {} },
    genuine: { total: 0, suppressed: [] },
    overlap: { total: 0, suppressed: [] },
    repeating: { total: 0, suppressed: 0 }
  }
  let genuineIndex = 0
  let overlapIndex = 0
  for (const reply of REPLIES) {
    // The assistant speaks for 4 s.
    t += 20_000
    guard.reset()
    const speechStart = t
    guard.noteSpoken(reply)
    t += 4000
    guard.noteSpeechEnded()
    const speechEnd = t

    for (const variant of echoVariants(reply, random)) {
      // An echo capture began between 0.5 s into the speech and 0.9 s after it (the tail), and arrives later.
      const capturedAt = speechStart + 500 + Math.floor(random() * (speechEnd - speechStart + 400))
      t = speechEnd + 2500
      const verdict = guard.check(variant.text, { capturedAt })
      result.echo.total += 1
      const bucket = (result.echo.byKind[variant.kind] ??= { total: 0, caught: 0 })
      bucket.total += 1
      if (verdict.echo) {
        result.echo.caught += 1
        bucket.caught += 1
      }
    }
    // People speak after the assistant has finished and the pause has passed (0.8 s to 3.5 s later).
    for (let i = 0; i < 3; i++) {
      const text = GENUINE[genuineIndex++ % GENUINE.length]
      const capturedAt = speechEnd + 800 + Math.floor(random() * 2700)
      t = capturedAt + 2000
      result.genuine.total += 1
      if (guard.check(text, { capturedAt }).echo) result.genuine.suppressed.push(text)
    }
    for (let i = 0; i < 2; i++) {
      const text = OVERLAP[overlapIndex++ % OVERLAP.length]
      const capturedAt = speechEnd + 800 + Math.floor(random() * 1200)
      t = capturedAt + 2000
      result.overlap.total += 1
      if (guard.check(text, { capturedAt }).echo) result.overlap.suppressed.push(text)
    }
    // While it is still speaking, the user talks over it: their words come with the echo.
    const talkedOver = `${tokenize(reply).slice(0, 5).join(' ')} wait no actually what about tomorrow`
    t = speechStart + 2500
    result.overlap.total += 1
    if (guard.check(talkedOver, { capturedAt: speechStart + 2000 }).echo) result.overlap.suppressed.push(talkedOver)
  }
  // Repeating its instructions straight after it stopped.
  for (const [reply, text] of [
    [REPLIES[6], REPEATING[0]],
    [REPLIES[10], REPEATING[1]],
    [REPLIES[10], REPEATING[2]]
  ]) {
    t += 20_000
    guard.reset()
    guard.noteSpoken(reply)
    t += 4000
    guard.noteSpeechEnded()
    result.repeating.total += 1
    if (guard.check(text, { capturedAt: t + 1000 }).echo) result.repeating.suppressed += 1
  }
  return result
}

test('MEASURED: the assistant\'s own speech is caught, a user\'s speech is not, overlap is kept', (t) => {
  const r = simulate()
  const rate = (a, b) => (b === 0 ? 0 : a / b)
  const summary = {
    echo: { total: r.echo.total, caught: r.echo.caught, rate: rate(r.echo.caught, r.echo.total).toFixed(3) },
    byKind: Object.fromEntries(
      Object.entries(r.echo.byKind).map(([kind, v]) => [kind, `${v.caught}/${v.total}`])
    ),
    genuine: { total: r.genuine.total, falselySuppressed: r.genuine.suppressed.length },
    overlap: { total: r.overlap.total, falselySuppressed: r.overlap.suppressed.length, which: r.overlap.suppressed },
    repeatingInstructions: r.repeating
  }
  t.diagnostic(JSON.stringify(summary))

  assert.ok(r.echo.total >= 60, 'a corpus big enough to mean something')
  assert.ok(r.genuine.total >= 30)

  // Self-transcription: how much of the assistant's own voice still becomes a "user" turn.
  assert.ok(rate(r.echo.caught, r.echo.total) >= 0.85, `echo caught ${r.echo.caught}/${r.echo.total}`)
  assert.equal(r.echo.byKind.exact.caught, r.echo.byKind.exact.total, 'a clean copy is always caught')
  // False suppression: a person who was not repeating the assistant must always be heard.
  assert.deepEqual(r.genuine.suppressed, [], 'no unrelated speech is ever dropped')
  // Overlap preservation: speech that shares words with the reply, or talks over it, is kept.
  assert.deepEqual(r.overlap.suppressed, [], 'overlapping speech is kept')
})

test('MEASURED: repeating the assistant\'s instructions word for word, right after it, is the known cost', () => {
  const r = simulate()
  // This is the limit of a text-only check, asserted so a change to it is a decision and not an accident.
  assert.equal(r.repeating.suppressed, r.repeating.total)
})

test('MEASURED: the window trades that cost against the late tail, and never against unrelated speech', () => {
  const wide = simulate({ windowMs: 4000 })
  const narrow = simulate({ windowMs: 500 })
  assert.equal(narrow.repeating.suppressed, 0, 'instructions repeated 1 s after it stopped are heard')
  assert.ok(narrow.echo.caught <= simulate().echo.caught)
  assert.ok(simulate().echo.caught <= wide.echo.caught)
  assert.deepEqual(narrow.genuine.suppressed, [])
  assert.deepEqual(wide.genuine.suppressed, [])
})

test('a capture that began later than the window is never judged, whatever it says', () => {
  const { guard, advance, now } = guardAt()
  guard.noteSpoken('The time is exactly noon. You have a meeting with the design team.')
  advance(3000)
  guard.noteSpeechEnded()
  assert.equal(guard.check('the time is exactly noon', { capturedAt: now() + 1000 }).echo, true)
  assert.equal(guard.check('the time is exactly noon', { capturedAt: now() + 2500 }).echo, false)
})

test('MEASURED: how much room there is around the threshold', (t) => {
  const rows = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((threshold) => {
    const r = simulate({ threshold })
    return {
      threshold,
      echoCaught: `${r.echo.caught}/${r.echo.total}`,
      genuineSuppressed: r.genuine.suppressed.length,
      overlapSuppressed: r.overlap.suppressed.length
    }
  })
  t.diagnostic(JSON.stringify(rows))
  const chosen = rows.find((row) => row.threshold === 0.7)
  assert.equal(chosen.genuineSuppressed, 0)
  assert.equal(chosen.overlapSuppressed, 0)
  // Margin on both sides: the neighbouring thresholds behave the same on this corpus, so the choice does not sit
  // on an edge of it.
  for (const neighbour of rows.filter((row) => row.threshold === 0.6 || row.threshold === 0.8)) {
    assert.equal(neighbour.genuineSuppressed, 0, `threshold ${neighbour.threshold}`)
    assert.equal(neighbour.overlapSuppressed, 0, `threshold ${neighbour.threshold}`)
  }
})
