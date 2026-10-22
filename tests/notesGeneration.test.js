import assert from 'node:assert/strict'
import test from 'node:test'
import { groundNotes } from '../server/intelligence/grounding.js'
import { generateMeetingSummary } from '../server/services/meetingSummaryService.js'
import { RollingOutputError, createRollingIntelligenceTracker } from '../server/services/rollingIntelligenceService.js'
import { generateGroundedNotes } from '../server/services/speechNotesService.js'

/**
 * The three places a model turns transcript lines into notes:
 *   - speechNotesService.generateGroundedNotes  study notes from a whole recording (topics, concepts, questions)
 *   - meetingSummaryService.generateMeetingSummary  the final record of a MEETING (decisions, actions with owner/due)
 *   - rollingIntelligenceService  a running understanding of a meeting that is still going
 *
 * They share a way of reading a model's reply (one JSON document, possibly in a ``` fence) and, for the first two,
 * the shape of the answer. They do NOT share a contract: what they send, what they accept and what they do with
 * an unusable reply differ on purpose, and these tests say how, so that the common part can be written once
 * without any of the differences moving. The model is always a fake.
 */

// ---- fixtures -----------------------------------------------------------------------------------------------

const SEGMENTS = [
  { id: 'seg_0001', start: 1, end: 3.5, speaker: 'speaker_00', text: 'We agreed to ship on Friday.' },
  { id: 'seg_0002', start: 4, end: 6, speaker: 'speaker_01', text: 'Priya will send the release notes by Friday.' },
  { id: 'seg_0003', start: 61.2, end: 64, speaker: null, text: 'Who owns the rollback plan?' }
]
const LINES = [
  '[seg_0001 | 00:01-00:03 | speaker_00] We agreed to ship on Friday.',
  '[seg_0002 | 00:04-00:06 | speaker_01] Priya will send the release notes by Friday.',
  '[seg_0003 | 01:01-01:04 | unknown] Who owns the rollback plan?'
]
const TRANSCRIPT = { schemaVersion: '1.0', segments: SEGMENTS }
const EMPTY_TRANSCRIPT_MESSAGE = 'Transcript is empty — nothing to summarize'

const STUDY_NOTES = {
  summary: 'The team agreed to ship on Friday.',
  keyTopics: [{ topic: 'Release date', source: { segmentIds: ['seg_0001'], start: 1, end: 3.5 } }],
  importantConcepts: [],
  questions: [{ question: 'Who owns the rollback plan?', source: { segmentIds: ['seg_0003'], start: 61.2, end: 64 } }],
  studyNotes: [{ note: 'Shipping is planned for Friday', source: { segmentIds: ['seg_0001'], start: 1, end: 3.5 } }]
}

const MEETING_NOTES = {
  summary: 'The team agreed to ship on Friday.',
  keyTopics: [{ topic: 'Release date', source: { segmentIds: ['seg_0001'], start: 1, end: 3.5 } }],
  decisions: [{ decision: 'Ship on Friday', source: { segmentIds: ['seg_0001'], start: 1, end: 3.5 } }],
  actionItems: [{ action: 'Send the release notes', owner: 'Priya', due: 'by Friday', source: { segmentIds: ['seg_0002'], start: 4, end: 6 } }],
  openQuestions: [{ question: 'Who owns the rollback plan?', source: { segmentIds: ['seg_0003'], start: 61.2, end: 64 } }]
}

const RECORDING = []
const model = (reply) => async (messages) => {
  RECORDING.push(messages)
  return typeof reply === 'function' ? reply(messages) : reply
}
const fenced = (value, tag = 'json') => '```' + tag + '\n' + JSON.stringify(value, null, 2) + '\n```'
const messageOf = (messages, role) => messages.find((m) => m.role === role).content

/** What JSON.parse says about a text, so a test can expect the exact parser message. */
function parserMessage(text) {
  try {
    JSON.parse(text)
  } catch (err) {
    return err.message
  }
  throw new Error(`expected ${JSON.stringify(text)} not to be JSON`)
}

// Replies that are not one JSON document, with the text that is actually parsed (the reply minus any fence).
const UNUSABLE = [
  ['prose', 'Sorry, I cannot help with that.', 'Sorry, I cannot help with that.'],
  ['prose after the JSON', '{"summary":"x"} and that is all', '{"summary":"x"} and that is all'],
  ['truncated JSON', '{"summary": "x", "keyTopics": [', '{"summary": "x", "keyTopics": ['],
  ['an empty reply', '', ''],
  ['only whitespace', '  \n ', ''],
  ['a fence around prose', '```json\nnot json\n```', 'not json'],
  ['a fence that is not at the start', 'Here you go:\n```json\n{"summary":"x"}\n```', 'Here you go:\n```json\n{"summary":"x"}\n```']
]

// ---- speechNotesService ---------------------------------------------------------------------------------------

test('study notes: a valid JSON reply comes back exactly as the model wrote it, with nothing else added', async () => {
  const result = await generateGroundedNotes(TRANSCRIPT, { generate: model(JSON.stringify(STUDY_NOTES)) })
  assert.deepEqual(result, { schemaVersion: '1.0', notes: STUDY_NOTES })
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'notes'], 'no raw and no parseError on success')
})

test('study notes: a reply in a ``` fence is read the same as one without', async () => {
  for (const reply of [fenced(STUDY_NOTES), fenced(STUDY_NOTES, ''), fenced(STUDY_NOTES, 'JSON'), `\n  ${fenced(STUDY_NOTES)}  \n`]) {
    const result = await generateGroundedNotes(TRANSCRIPT, { generate: model(reply) })
    assert.deepEqual(result, { schemaVersion: '1.0', notes: STUDY_NOTES }, JSON.stringify(reply.slice(0, 12)))
  }
})

test('study notes: a reply that is not JSON is returned as unusable with the raw text and the parser\'s message, never thrown', async () => {
  for (const [name, reply, parsed] of UNUSABLE) {
    const result = await generateGroundedNotes(TRANSCRIPT, { generate: model(reply) })
    assert.deepEqual(result, { schemaVersion: '1.0', notes: null, raw: reply, parseError: parserMessage(parsed) }, name)
  }
})

test('study notes: JSON of any shape is passed through as the notes; deciding whether it is usable is the caller\'s job', async () => {
  for (const [reply, notes] of [['[]', []], ['{}', {}], ['"text"', 'text'], ['42', 42], ['0', 0], ['true', true]]) {
    const result = await generateGroundedNotes(TRANSCRIPT, { generate: model(reply) })
    assert.deepEqual(result, { schemaVersion: '1.0', notes }, reply)
  }
  const jsonNull = await generateGroundedNotes(TRANSCRIPT, { generate: model('null') })
  assert.deepEqual(jsonNull, { schemaVersion: '1.0', notes: null }, 'JSON null is "no notes" without a parseError')
})

test('study notes: a reply with fields missing is not repaired, and grounding drops what cannot be traced', async () => {
  const partial = { summary: 'Short.', keyTopics: [{ topic: 'No source here' }], studyNotes: [{ note: 'Cites nothing real', source: { segmentIds: ['seg_9999'] } }] }
  const result = await generateGroundedNotes(TRANSCRIPT, { generate: model(JSON.stringify(partial)) })
  assert.deepEqual(result.notes, partial)
  const grounded = groundNotes(result.notes, SEGMENTS)
  assert.deepEqual(grounded.items, [])
  assert.deepEqual(grounded.rejected.map((r) => [r.category, r.reason]), [
    ['keyTopics', 'no-source'],
    ['studyNotes', 'cited-segments-do-not-exist']
  ])
})

test('study notes: every kept item cites a real segment, and its times come from the segment, not from the model', async () => {
  const reply = {
    keyTopics: [{ topic: 'Release date', source: { segmentIds: ['seg_0001', 'seg_9999'], start: 500, end: 600 } }],
    questions: [{ question: 'Who owns the rollback plan?', source: { segmentIds: ['seg_0003'], start: 61.2, end: 64 } }]
  }
  const result = await generateGroundedNotes(TRANSCRIPT, { generate: model(JSON.stringify(reply)) })
  const { items } = groundNotes(result.notes, SEGMENTS)
  assert.deepEqual(items.map((i) => [i.category, i.source.segmentIds, i.source.start, i.source.end]), [
    ['keyTopics', ['seg_0001'], 1, 3.5],
    ['questions', ['seg_0003'], 61.2, 64]
  ])
  assert.ok(items[0].caveats.includes('some-cited-segments-do-not-exist'))
  assert.ok(items[0].caveats.includes('model-timestamps-replaced'))
})

test('study notes: what the model is sent is the study-notes prompt and the canonical lines, one per segment', async () => {
  RECORDING.length = 0
  await generateGroundedNotes(TRANSCRIPT, { generate: model('{}') })
  assert.equal(RECORDING.length, 1)
  const [system, user] = RECORDING[0]
  assert.deepEqual(RECORDING[0].map((m) => m.role), ['system', 'user'])
  assert.equal(user.content, `Transcript:\n\n${LINES.join('\n')}`)
  for (const phrase of ['turning a canonical speech transcript into grounded study notes', '"studyNotes"', 'Never invent a source', 'only cite tags that actually appear in the transcript']) {
    assert.ok(system.content.includes(phrase), phrase)
  }
  assert.ok(!/"owner"|"due"|"decisions"|"actionItems"/.test(system.content), 'study notes have no owners, deadlines, decisions or actions')
})

test('study notes: with no segments the transcript\'s plain text is used; with neither, nothing is sent and it throws', async () => {
  RECORDING.length = 0
  await generateGroundedNotes({ text: 'Just some text.' }, { generate: model('{}') })
  assert.equal(messageOf(RECORDING[0], 'user'), 'Transcript:\n\nJust some text.')

  for (const empty of [{ segments: [] }, { segments: [], text: '   ' }, {}, null, undefined, { text: 42 }]) {
    RECORDING.length = 0
    await assert.rejects(generateGroundedNotes(empty, { generate: model('{}') }), { message: EMPTY_TRANSCRIPT_MESSAGE }, JSON.stringify(empty))
    assert.equal(RECORDING.length, 0, 'the model is not called for an empty transcript')
  }
})

test('study notes: a model call that fails is not caught here, and a reply that is not even a string is not coerced', async () => {
  const outage = Object.assign(new Error('provider down'), { statusCode: 503 })
  await assert.rejects(generateGroundedNotes(TRANSCRIPT, { generate: async () => Promise.reject(outage) }), outage)
  // Current behaviour, not a promise: the other two generators turn this into an "unusable reply" instead.
  for (const reply of [undefined, null, 42, {}]) {
    await assert.rejects(generateGroundedNotes(TRANSCRIPT, { generate: model(reply) }), TypeError, String(reply))
  }
})

// ---- meetingSummaryService ------------------------------------------------------------------------------------

test('meeting record: a valid JSON reply comes back exactly as the model wrote it, with nothing else added', async () => {
  const result = await generateMeetingSummary(TRANSCRIPT, { generate: model(JSON.stringify(MEETING_NOTES)) })
  assert.deepEqual(result, { schemaVersion: '1.0', notes: MEETING_NOTES })
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'notes'])
})

test('meeting record: a reply in a ``` fence is read the same as one without', async () => {
  for (const reply of [fenced(MEETING_NOTES), fenced(MEETING_NOTES, ''), fenced(MEETING_NOTES, 'JSON'), `\n  ${fenced(MEETING_NOTES)}  \n`]) {
    const result = await generateMeetingSummary(TRANSCRIPT, { generate: model(reply) })
    assert.deepEqual(result, { schemaVersion: '1.0', notes: MEETING_NOTES })
  }
})

test('meeting record: a reply that is not JSON is returned as unusable with the raw text and the parser\'s message, never thrown', async () => {
  for (const [name, reply, parsed] of UNUSABLE) {
    const result = await generateMeetingSummary(TRANSCRIPT, { generate: model(reply) })
    assert.deepEqual(result, { schemaVersion: '1.0', notes: null, raw: reply, parseError: parserMessage(parsed) }, name)
  }
})

test('meeting record: a reply that is missing, null or not a string is "unusable" with the raw value kept, unlike study notes', async () => {
  for (const reply of [undefined, null]) {
    const result = await generateMeetingSummary(TRANSCRIPT, { generate: model(reply) })
    assert.deepEqual(result, { schemaVersion: '1.0', notes: null, raw: reply, parseError: parserMessage('') }, String(reply))
  }
  const number = await generateMeetingSummary(TRANSCRIPT, { generate: model(42) })
  assert.deepEqual(number, { schemaVersion: '1.0', notes: 42 }, 'a number is read as the text "42", which is JSON')
})

test('meeting record: JSON of any shape is passed through as the notes', async () => {
  for (const [reply, notes] of [['[]', []], ['{}', {}], ['"text"', 'text'], ['42', 42], ['0', 0], ['true', true]]) {
    assert.deepEqual(await generateMeetingSummary(TRANSCRIPT, { generate: model(reply) }), { schemaVersion: '1.0', notes }, reply)
  }
  assert.deepEqual(await generateMeetingSummary(TRANSCRIPT, { generate: model('null') }), { schemaVersion: '1.0', notes: null })
})

test('meeting record: an owner or a deadline nobody said is not kept, whatever the model wrote', async () => {
  const invented = {
    actionItems: [
      { action: 'Send the release notes', owner: 'Priya', due: 'by Friday', source: { segmentIds: ['seg_0002'] } },
      { action: 'Send the release notes', owner: 'Marcus', due: 'next Tuesday', source: { segmentIds: ['seg_0002'] } },
      { action: 'Plan the rollback', owner: 'Dana', due: 'tomorrow', source: { segmentIds: ['seg_0003'] } }
    ]
  }
  const result = await generateMeetingSummary(TRANSCRIPT, { generate: model(JSON.stringify(invented)) })
  const [said, wrong, none] = groundNotes(result.notes, SEGMENTS).items
  assert.deepEqual([said.owner, said.due], [{ name: 'Priya', evidence: 'named-in-cited-text' }, 'by Friday'])
  assert.deepEqual([wrong.owner, wrong.due], [{ name: null, evidence: null }, null])
  assert.deepEqual(wrong.caveats.filter((c) => c.endsWith('unverified')), ['owner-unverified', 'due-unverified'])
  assert.deepEqual([none.owner, none.due], [{ name: null, evidence: null }, null], 'nobody said Dana owns it, or "tomorrow"')
})

test('meeting record: every kept item cites a real segment, and its times come from the segment, not from the model', async () => {
  const result = await generateMeetingSummary(TRANSCRIPT, { generate: model(JSON.stringify(MEETING_NOTES)) })
  const { items, rejected } = groundNotes(result.notes, SEGMENTS)
  assert.deepEqual(rejected, [])
  assert.deepEqual(items.map((i) => [i.category, i.source.segmentIds, i.source.start, i.source.end]), [
    ['keyTopics', ['seg_0001'], 1, 3.5],
    ['openQuestions', ['seg_0003'], 61.2, 64],
    ['decisions', ['seg_0001'], 1, 3.5],
    ['actionItems', ['seg_0002'], 4, 6]
  ])
})

test('meeting record: what the model is sent is the meeting prompt and the canonical lines, with the owner and deadline rule', async () => {
  RECORDING.length = 0
  await generateMeetingSummary(TRANSCRIPT, { generate: model('{}') })
  assert.equal(RECORDING.length, 1)
  const [system, user] = RECORDING[0]
  assert.deepEqual(RECORDING[0].map((m) => m.role), ['system', 'user'])
  assert.equal(user.content, `Transcript:\n\n${LINES.join('\n')}`)
  for (const phrase of [
    'You write the final record of a meeting',
    '"actionItems"',
    '"owner" and "due" are ONLY what a speaker explicitly said',
    'If nobody said, they are null. Never infer an owner from who was speaking or a deadline from context.',
    'A decision is something the speakers actually settled',
    'Every item MUST cite real segment ids copied from the transcript tags it came from. Never invent a source.'
  ]) {
    assert.ok(system.content.includes(phrase), phrase)
  }
})

test('meeting record: it needs segments (there is no plain-text fallback), and an empty one never reaches the model', async () => {
  for (const empty of [{ segments: [] }, { text: 'Just some text.' }, {}, null, undefined]) {
    RECORDING.length = 0
    await assert.rejects(generateMeetingSummary(empty, { generate: model('{}') }), { message: EMPTY_TRANSCRIPT_MESSAGE }, JSON.stringify(empty))
    assert.equal(RECORDING.length, 0)
  }
})

test('meeting record: a model call that fails is not caught here', async () => {
  const outage = Object.assign(new Error('provider down'), { statusCode: 503 })
  await assert.rejects(generateMeetingSummary(TRANSCRIPT, { generate: async () => Promise.reject(outage) }), outage)
})

// ---- rollingIntelligenceService -------------------------------------------------------------------------------

const EMPTY_SNAPSHOT = { currentTopics: [], decisions: [], openQuestions: [], actionItems: [], importantPoints: [] }
const ROLLING_NOTES = {
  currentTopics: [{ topic: 'Release date', source: { segmentIds: ['seg_0001'], start: 1, end: 3.5 } }],
  decisions: [{ decision: 'Ship on Friday', source: { segmentIds: ['seg_0001'], start: 1, end: 3.5 } }],
  openQuestions: [],
  actionItems: [{ action: 'Send the release notes', owner: 'Priya', due: 'by Friday', source: { segmentIds: ['seg_0002'], start: 4, end: 6 } }],
  importantPoints: []
}

function rolling(reply) {
  const tracker = createRollingIntelligenceTracker({ generate: model(reply) })
  tracker.ingest(SEGMENTS)
  return tracker
}

test('rolling: a valid JSON reply becomes the snapshot, with any category the model left out filled in empty', async () => {
  assert.deepEqual(await rolling(JSON.stringify(ROLLING_NOTES)).snapshot(), ROLLING_NOTES)
  const sparse = await rolling(JSON.stringify({ decisions: ROLLING_NOTES.decisions })).snapshot()
  assert.deepEqual(sparse, { ...EMPTY_SNAPSHOT, decisions: ROLLING_NOTES.decisions }, 'missing fields are empty arrays')
  const extra = await rolling(JSON.stringify({ ...ROLLING_NOTES, mood: 'upbeat' })).snapshot()
  assert.equal(extra.mood, 'upbeat', 'a field it did not ask for is kept as written')
  assert.deepEqual(await rolling('{}').snapshot(), EMPTY_SNAPSHOT)
})

test('rolling: a reply in a ``` fence is read the same as one without', async () => {
  for (const reply of [fenced(ROLLING_NOTES), fenced(ROLLING_NOTES, ''), fenced(ROLLING_NOTES, 'JSON'), `\n  ${fenced(ROLLING_NOTES)}  \n`]) {
    assert.deepEqual(await rolling(reply).snapshot(), ROLLING_NOTES)
  }
})

test('rolling: a reply that is not JSON is an error of its own kind, with the parser\'s message, and the segments stay pending', async () => {
  for (const [name, reply, parsed] of UNUSABLE) {
    const tracker = rolling(reply)
    await assert.rejects(
      tracker.snapshot(),
      (err) => err instanceof RollingOutputError && err.code === 'model-output-unusable' && err.message === `The model did not return JSON: ${parserMessage(parsed)}`,
      name
    )
    assert.equal(tracker.hasPending(), true, `${name}: nothing was dropped`)
    assert.equal(tracker.pendingCount(), SEGMENTS.length)
    assert.equal(tracker.lastSnapshot(), null)
  }
})

test('rolling: a missing or non-string reply is read as empty text, so it is the same "not JSON" error', async () => {
  for (const reply of [undefined, null]) {
    await assert.rejects(rolling(reply).snapshot(), { name: 'RollingOutputError', message: `The model did not return JSON: ${parserMessage('')}` })
  }
})

test('rolling: JSON that is not an object is refused (study notes and the meeting record would accept it)', async () => {
  for (const reply of ['[]', '[{"decisions":[]}]', 'null', '"text"', '42', '0', 'true', 'false']) {
    const tracker = rolling(reply)
    await assert.rejects(tracker.snapshot(), { name: 'RollingOutputError', code: 'model-output-unusable', message: 'The model returned JSON that is not an object' }, reply)
    assert.equal(tracker.pendingCount(), SEGMENTS.length, reply)
  }
})

test('rolling: each item keeps the source the model cited, and grounding then checks it against the saved lines', async () => {
  const snapshot = await rolling(JSON.stringify({
    ...ROLLING_NOTES,
    decisions: [
      { decision: 'Ship on Friday', source: { segmentIds: ['seg_0001'], start: 99, end: 100 } },
      { decision: 'Invented decision', source: { segmentIds: ['seg_9999'], start: 0, end: 1 } }
    ]
  })).snapshot()
  assert.deepEqual(snapshot.decisions[0].source, { segmentIds: ['seg_0001'], start: 99, end: 100 }, 'the tracker does not touch it')
  const { items, rejected } = groundNotes(snapshot, SEGMENTS)
  const decision = items.find((i) => i.kind === 'decision')
  assert.deepEqual([decision.source.segmentIds, decision.source.start, decision.source.end], [['seg_0001'], 1, 3.5])
  assert.deepEqual(rejected.map((r) => [r.category, r.reason]), [['decisions', 'cited-segments-do-not-exist']])
})

test('rolling: what the model is sent is the rolling prompt, the previous understanding, and the new lines in timeline order', async () => {
  RECORDING.length = 0
  const tracker = createRollingIntelligenceTracker({ generate: model(JSON.stringify(ROLLING_NOTES)) })
  tracker.ingest([SEGMENTS[2], SEGMENTS[0], SEGMENTS[1]])
  await tracker.snapshot()
  const [system, user] = RECORDING[0]
  assert.deepEqual(RECORDING[0].map((m) => m.role), ['system', 'user'])
  assert.equal(user.content, `Previous rolling understanding:\n(none yet)\n\nNew segments:\n${LINES.join('\n')}`)
  for (const phrase of [
    'You maintain a rolling understanding of an in-progress meeting/lecture',
    'This is a MERGE, not a replacement',
    '"owner" and "due" are ONLY what a speaker explicitly said',
    'If nobody said, they are null. Never infer an owner from who was speaking or a deadline from context.',
    'A decision is something the speakers actually settled',
    'Never invent a source.'
  ]) {
    assert.ok(system.content.includes(phrase), phrase)
  }

  tracker.ingest([{ id: 'seg_0004', start: 70, end: 72, speaker: 'speaker_00', text: 'Let us close.' }])
  await tracker.snapshot()
  assert.equal(
    messageOf(RECORDING[1], 'user'),
    `Previous rolling understanding:\n${JSON.stringify(ROLLING_NOTES)}\n\nNew segments:\n[seg_0004 | 01:10-01:12 | speaker_00] Let us close.`
  )
})
