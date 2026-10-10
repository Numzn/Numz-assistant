import assert from 'node:assert/strict'
import test from 'node:test'
import { extractSignals } from '../server/intelligence/meetingSignals.js'
import { groundNotes, unsupportedTerms } from '../server/intelligence/grounding.js'
import { createRollingIntelligenceTracker } from '../server/services/rollingIntelligenceService.js'

const seg = (n, text, extra = {}) => ({
  id: `seg_${String(n).padStart(4, '0')}`,
  start: n * 10,
  end: n * 10 + 8,
  text,
  speaker: null,
  uncertain: false,
  confidence: null,
  ...extra
})

// ---- what the words themselves say ----------------------------------------------------------------------

test('a question mark is a confirmed question; a bare interrogative is only inferred', () => {
  const found = extractSignals([
    seg(1, 'When does the new build ship?'),
    seg(2, 'when does the build ship tomorrow'),
    seg(3, 'The build ships on Friday.'),
    seg(4, 'Why?')
  ])
  assert.deepEqual(found.questions.map((q) => [q.source.segmentIds[0], q.status, q.pattern]), [
    ['seg_0001', 'confirmed', 'question-mark'],
    ['seg_0002', 'inferred', 'interrogative-opening'],
    ['seg_0004', 'confirmed', 'question-mark']
  ])
})

test('a sentence that merely starts with a question word is not a question without a question mark (a real false positive)', () => {
  // From the first real run through the dev stack: Whisper transcribed this without a question mark.
  const found = extractSignals([
    seg(1, 'What your country can do for you, ask what you can do for your country.'),
    seg(2, 'How the model works is described in the appendix and the notes that follow.'),
    seg(3, 'When the team ships the build we will tell everyone.'),
    seg(4, 'what is the plan for the launch'),
    seg(5, 'how do we get the numbers by Friday'),
    seg(6, 'can we move the review')
  ])
  assert.deepEqual(
    found.questions.map((q) => [q.source.segmentIds[0], q.status]),
    [
      ['seg_0004', 'inferred'],
      ['seg_0005', 'inferred'],
      ['seg_0006', 'inferred']
    ]
  )
})

test('an explicit commitment is confirmed, a suggestion is inferred, and the deadline is quoted verbatim', () => {
  const found = extractSignals([
    seg(1, "I'll send the revised budget by Friday.", { speaker: 'speaker_01' }),
    seg(2, "Let's move the review to next week."),
    seg(3, 'The weather is nice today.')
  ])
  assert.equal(found.actionItems.length, 2)
  const [first, second] = found.actionItems
  assert.equal(first.status, 'confirmed')
  assert.equal(first.due, 'by Friday')
  assert.deepEqual(first.owner, { name: 'speaker_01', evidence: 'speaker-label' })
  assert.equal(second.status, 'inferred')
  assert.equal(second.owner.name, null)
  assert.equal(second.due, null, '"next week" alone is not a deadline phrase here; nothing is parsed or guessed')
})

test('an owner is named only when the text names one or the speaker says "I will"', () => {
  const found = extractSignals([
    seg(1, 'Priya will draft the announcement.', { speaker: 'speaker_00' }),
    seg(2, 'We will review it on Monday.', { speaker: 'speaker_00' }),
    seg(3, "I'll book the room.", { speaker: 'overlap' }),
    seg(4, "I'll book the room.", { speaker: 'speaker_02', uncertain: true }),
    seg(5, 'Could you send the notes please?', { speaker: 'speaker_01' })
  ])
  const owners = found.actionItems.map((item) => item.owner)
  assert.deepEqual(owners[0], { name: 'Priya', evidence: 'named-in-text' })
  assert.deepEqual(owners[1], { name: null, evidence: null }, '"we" is a group, not a person')
  assert.deepEqual(owners[2], { name: null, evidence: null }, 'an overlapping voice is never attributed')
  assert.deepEqual(owners[3], { name: null, evidence: null }, 'an uncertain attribution is never used')
  assert.deepEqual(owners[4], { name: null, evidence: null }, 'a request does not make the speaker the owner')
})

test('ordinary capitalised words before "will" are not owners', () => {
  const found = extractSignals([
    seg(1, 'Tomorrow will be sunny.'),
    seg(2, 'Everyone will receive the notes.'),
    seg(3, 'The team will meet again.'),
    seg(4, 'Marcus will present the results.')
  ])
  assert.deepEqual(
    found.actionItems.map((item) => [item.source.segmentIds[0], item.owner.name]),
    [['seg_0004', 'Marcus']]
  )
})

test('a speaker is passed through only when the label is real and unambiguous', () => {
  const found = extractSignals([
    seg(1, 'We decided to use the smaller model.', { speaker: 'speaker_00' }),
    seg(2, 'We agreed to launch on Friday.', { speaker: 'overlap' }),
    seg(3, 'We agreed to cut the scope.', { speaker: 'speaker_01', uncertain: true })
  ])
  assert.deepEqual(found.decisions.map((d) => d.speaker), ['speaker_00', null, null])
})

test('decisions: stated is confirmed, "let\'s go with" is inferred', () => {
  const found = extractSignals([seg(1, 'We decided to postpone the launch.'), seg(2, "Let's go with the blue design.")])
  assert.deepEqual(found.decisions.map((d) => d.status), ['confirmed', 'inferred'])
})

test('a finding from a line recognised with low confidence is uncertain, and says why', () => {
  const found = extractSignals([seg(1, 'We decided to postpone the launch.', { confidence: 0.2 })])
  assert.equal(found.decisions[0].status, 'uncertain')
  assert.deepEqual(found.decisions[0].caveats, ['low-asr-confidence'])
})

test('every finding cites its segment and quotes it; nothing is invented from nothing', () => {
  const segments = [seg(1, 'Hello everyone.'), seg(2, 'Thanks for joining.'), seg(3, 'Good to see you all.')]
  const found = extractSignals(segments)
  assert.deepEqual(found, { questions: [], actionItems: [], decisions: [] })
  const one = extractSignals([seg(7, 'Are we shipping on Friday?')]).questions[0]
  assert.deepEqual(one.source, { segmentIds: ['seg_0007'], start: 70, end: 78 })
  assert.equal(one.text, 'Are we shipping on Friday?')
})

test('empty or malformed input is harmless', () => {
  assert.deepEqual(extractSignals(null), { questions: [], actionItems: [], decisions: [] })
  assert.deepEqual(extractSignals([{ id: 'x' }, { text: 'no id?' }, null]), { questions: [], actionItems: [], decisions: [] })
})

// ---- checking a model against the transcript ----------------------------------------------------------------

const MEETING = [
  seg(1, 'The team agreed to move the launch to Friday.'),
  seg(2, 'Priya will run the final testing on Thursday.', { speaker: 'speaker_01' }),
  seg(3, 'Does the budget cover the extra servers?'),
  seg(4, 'Nobody could say, we need to ask finance.')
]

test('an item that cites a real segment is kept, with times and quotes taken from the segment, not the model', () => {
  const { items, rejected } = groundNotes(
    {
      decisions: [
        { decision: 'Launch moves to Friday', source: { segmentIds: ['seg_0001'], start: 999, end: 1000 } }
      ]
    },
    MEETING
  )
  assert.equal(rejected.length, 0)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].source, { segmentIds: ['seg_0001'], start: 10, end: 18 })
  assert.equal(items[0].evidence[0].text, 'The team agreed to move the launch to Friday.')
  assert.equal(items[0].status, 'inferred', 'a model reading is never "confirmed"')
  assert.equal(items[0].basis, 'model-inference')
  assert.ok(items[0].caveats.includes('model-timestamps-replaced'))
})

test('an item citing nothing, or only segments that do not exist, is rejected and listed', () => {
  const { items, rejected } = groundNotes(
    {
      keyTopics: [
        { topic: 'Pricing strategy', source: { segmentIds: ['seg_9999'], start: 0, end: 5 } },
        { topic: 'Hiring plan' },
        { topic: 'Launch date', source: { segmentIds: ['seg_0001'] } }
      ]
    },
    MEETING
  )
  assert.deepEqual(items.map((i) => i.text), ['Launch date'])
  assert.deepEqual(rejected.map((r) => [r.claimed, r.reason]), [
    ['Pricing strategy', 'cited-segments-do-not-exist'],
    ['Hiring plan', 'no-source']
  ])
})

test('a citation that is partly invented keeps the real part and says so', () => {
  const { items } = groundNotes(
    { decisions: [{ decision: 'Launch moves to Friday', source: { segmentIds: ['seg_0001', 'seg_4040'] } }] },
    MEETING
  )
  assert.deepEqual(items[0].source.segmentIds, ['seg_0001'])
  assert.ok(items[0].caveats.includes('some-cited-segments-do-not-exist'))
})

test('a claim the cited words do not support is uncertain, not inferred', () => {
  const { items } = groundNotes(
    { decisions: [{ decision: 'Approved a hiring freeze across engineering', source: { segmentIds: ['seg_0001'] } }] },
    MEETING
  )
  assert.equal(items[0].status, 'uncertain')
  assert.ok(items[0].caveats.includes('weak-lexical-support'))
})

test('a cited line recognised with low confidence makes the item uncertain', () => {
  const shaky = [seg(1, 'The team agreed to move the launch to Friday.', { confidence: 0.1 })]
  const { items } = groundNotes(
    { decisions: [{ decision: 'Launch moves to Friday', source: { segmentIds: ['seg_0001'] } }] },
    shaky
  )
  assert.equal(items[0].status, 'uncertain')
  assert.ok(items[0].caveats.includes('low-asr-confidence'))
})

test('an action owner is kept only if the cited text names them or the cited segment carries the label', () => {
  const { items } = groundNotes(
    {
      actionItems: [
        { action: 'Run the final testing', owner: 'Priya', source: { segmentIds: ['seg_0002'] } },
        { action: 'Run the final testing', owner: 'Marcus', source: { segmentIds: ['seg_0002'] } },
        { action: 'Run the final testing', owner: 'speaker_01', source: { segmentIds: ['seg_0002'] } },
        { action: 'Ask finance about servers', owner: null, source: { segmentIds: ['seg_0004'] } }
      ]
    },
    MEETING
  )
  assert.deepEqual(items.map((i) => i.owner), [
    { name: 'Priya', evidence: 'named-in-cited-text' },
    { name: null, evidence: null },
    { name: 'speaker_01', evidence: 'speaker-label' },
    { name: null, evidence: null }
  ])
  assert.ok(items[1].caveats.includes('owner-unverified'))
})

test('a summary is listed with the numbers and names that appear nowhere in the transcript', () => {
  const { summary } = groundNotes(
    { summary: 'The team agreed to move the launch to Friday. Priya will run testing. The budget is 40000 dollars and Marcus approved it.' },
    MEETING
  )
  assert.deepEqual(summary.unsupportedTerms.sort(), ['40000', 'Marcus'])
  assert.equal(summary.status, 'uncertain')
  assert.ok(summary.caveats.includes('contains-terms-not-in-transcript'))
  assert.equal(summary.scope, 'whole-transcript')
})

test('a summary that stays inside the transcript is inferred and clean', () => {
  const { summary } = groundNotes(
    { summary: 'The team agreed to move the launch to Friday and Priya will run the final testing on Thursday.' },
    MEETING
  )
  assert.deepEqual(summary.unsupportedTerms, [])
  assert.equal(summary.status, 'inferred')
})

test('unsupportedTerms ignores ordinary sentence-initial capitals and punctuation', () => {
  assert.deepEqual(unsupportedTerms('The launch moves. Friday works.', [seg(1, 'launch moves friday works')]), [])
})

test('malformed model output is handled, never thrown', () => {
  assert.deepEqual(groundNotes(null, MEETING), { items: [], rejected: [], summary: null })
  const { items, rejected } = groundNotes({ keyTopics: ['not an object', null, { topic: 5 }] }, MEETING)
  assert.deepEqual(items, [])
  assert.equal(rejected.length, 3)
})

// ---- the rolling tracker ----------------------------------------------------------------------------------

const reply = (topic) => JSON.stringify({ currentTopics: [{ topic }], decisions: [], openQuestions: [], actionItems: [], importantPoints: [] })

test('segments that arrive while the model is thinking are kept for the next update, not lost', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const prompts = []
  const tracker = createRollingIntelligenceTracker({
    generate: async (messages) => {
      prompts.push(messages[1].content)
      if (prompts.length === 1) await gate
      return reply(`topic ${prompts.length}`)
    }
  })
  tracker.ingest([seg(1, 'first line')])
  const running = tracker.snapshot()
  await new Promise((resolve) => setImmediate(resolve))
  tracker.ingest([seg(2, 'second line, said while it thinks')])
  release()
  await running
  assert.equal(tracker.hasPending(), true, 'the line said during the update is still waiting')

  await tracker.snapshot()
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /second line, said while it thinks/)
  assert.doesNotMatch(prompts[1], /first line\n|first line$/, 'and the first line is not sent twice')
  assert.equal(tracker.hasPending(), false)
})

test('a failed update drops nothing: the same segments are sent again next time', async () => {
  let calls = 0
  const prompts = []
  const tracker = createRollingIntelligenceTracker({
    generate: async (messages) => {
      calls += 1
      prompts.push(messages[1].content)
      if (calls === 1) throw new Error('provider down')
      return reply('ok')
    }
  })
  tracker.ingest([seg(1, 'keep me')])
  await assert.rejects(() => tracker.snapshot(), /provider down/)
  assert.equal(tracker.hasPending(), true)
  await tracker.snapshot()
  assert.match(prompts[1], /keep me/)
  assert.equal(tracker.hasPending(), false)
})

test('two snapshots at once send each segment once', async () => {
  const prompts = []
  const tracker = createRollingIntelligenceTracker({
    generate: async (messages) => {
      prompts.push(messages[1].content)
      await new Promise((resolve) => setImmediate(resolve))
      return reply('t')
    }
  })
  tracker.ingest([seg(1, 'only once')])
  await Promise.all([tracker.snapshot(), tracker.snapshot()])
  assert.equal(prompts.length, 1)
})
