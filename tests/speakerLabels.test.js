import assert from 'node:assert/strict'
import test from 'node:test'
import { groundNotes } from '../server/intelligence/grounding.js'
import { extractSignals } from '../server/intelligence/meetingSignals.js'
import { SPEAKER_OTHERS, SPEAKER_YOU, namesOnePerson } from '../server/intelligence/speakerLabels.js'
import { generateMeetingSummary } from '../server/services/meetingSummaryService.js'
import { createRollingIntelligenceTracker } from '../server/services/rollingIntelligenceService.js'
import { generateGroundedNotes } from '../server/services/speechNotesService.js'

/**
 * What the speaker tags mean downstream. Live lines are tagged "you" (the person who recorded the meeting, from the
 * microphone), "others" (the people on the shared audio: possibly several) or nothing; older lines, and lectures
 * through the batch pipeline, carry placeholder tags such as "speaker_00". Only a tag that names ONE real person
 * can make that person the owner of an action: "others" is a crowd, and "speaker_00" is a placeholder.
 */

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

test('the labels are the two the sidecar writes, and only "you" names one person', () => {
  assert.equal(SPEAKER_YOU, 'you')
  assert.equal(SPEAKER_OTHERS, 'others')
  assert.equal(namesOnePerson('you'), true)
  for (const label of ['others', 'speaker_00', 'speaker_01', 'overlap', 'unknown', 'You', 'YOU', ' you', '', null, undefined, 0, {}]) {
    assert.equal(namesOnePerson(label), false, JSON.stringify(label))
  }
})

test('a first-person commitment makes the owner "you" only when "you" said it, clearly', () => {
  const lines = [
    seg(1, "I'll send the revised budget by Friday.", { speaker: 'you' }),
    seg(2, "I'll send the revised budget by Friday.", { speaker: 'others' }),
    seg(3, "I'll send the revised budget by Friday.", { speaker: 'speaker_00' }),
    seg(4, "I'll send the revised budget by Friday.", { speaker: 'speaker_01' }),
    seg(5, "I'll send the revised budget by Friday.", { speaker: 'you', uncertain: true }),
    seg(6, "I'll send the revised budget by Friday.", { speaker: null, uncertain: true }),
    seg(7, "I'll send the revised budget by Friday.", { speaker: 'overlap' }),
    seg(8, "I'll send the revised budget by Friday.")
  ]
  const owners = extractSignals(lines).actionItems.map((item) => item.owner)
  assert.deepEqual(owners[0], { name: 'you', evidence: 'speaker-label' })
  for (const [index, reason] of [
    [1, '"others" is a crowd, not a person'],
    [2, 'speaker_00 is a placeholder, not a name'],
    [3, 'so is speaker_01'],
    [4, 'an uncertain label is never used'],
    [5, 'no label'],
    [6, 'an overlapping voice'],
    [7, 'no label at all']
  ]) {
    assert.deepEqual(owners[index], { name: null, evidence: null }, reason)
  }
})

test('a name said in the words still wins, whoever said it', () => {
  const lines = [
    seg(1, 'Priya will draft the announcement.', { speaker: 'others' }),
    seg(2, 'Priya will draft the announcement.', { speaker: 'you' })
  ]
  assert.deepEqual(
    extractSignals(lines).actionItems.map((item) => item.owner),
    [
      { name: 'Priya', evidence: 'named-in-text' },
      { name: 'Priya', evidence: 'named-in-text' }
    ]
  )
})

test('a finding still reports who said it where the label is clear, so "others" can be shown as such', () => {
  const found = extractSignals([
    seg(1, 'We decided to use the smaller model.', { speaker: 'others' }),
    seg(2, 'We agreed to launch on Friday.', { speaker: 'you' }),
    seg(3, 'We agreed to cut the scope.', { speaker: 'others', uncertain: true })
  ])
  assert.deepEqual(found.decisions.map((d) => d.speaker), ['others', 'you', null])
})

const MEETING = [
  seg(1, 'I will run the final testing.', { speaker: 'you' }),
  seg(2, 'I will run the final testing.', { speaker: 'others' }),
  seg(3, 'I will run the final testing.', { speaker: 'speaker_00' }),
  seg(4, 'I will run the final testing.', { speaker: 'you', uncertain: true })
]

function ownersOf(owner, segmentId) {
  const { items } = groundNotes({ actionItems: [{ action: 'Run the final testing', owner, source: { segmentIds: [segmentId] } }] }, MEETING)
  return items[0]
}

test('a model that names "you" as an owner is believed only where "you" is the cited line\'s clear speaker', () => {
  assert.deepEqual(ownersOf('you', 'seg_0001').owner, { name: 'you', evidence: 'speaker-label' })
  for (const [segmentId, why] of [
    ['seg_0002', 'the line was said by others'],
    ['seg_0003', 'the line has a placeholder tag'],
    ['seg_0004', 'the label is uncertain']
  ]) {
    const item = ownersOf('you', segmentId)
    assert.deepEqual(item.owner, { name: null, evidence: null }, why)
    assert.ok(item.caveats.includes('owner-unverified'), why)
  }
})

test('a model cannot make "others" or a placeholder tag the owner, even where the cited line carries that tag', () => {
  for (const [claimed, segmentId] of [['others', 'seg_0002'], ['Others', 'seg_0002'], ['speaker_00', 'seg_0003']]) {
    const item = ownersOf(claimed, segmentId)
    assert.deepEqual(item.owner, { name: null, evidence: null }, claimed)
    assert.ok(item.caveats.includes('owner-unverified'), claimed)
  }
})

// ---- what the model is told about the tags -------------------------------------------------------------------

const TAG_RULES = [
  '`you` (the person who recorded the meeting)',
  '`others` (everyone else',
  'never treat `others` as one person',
  'A tag only says where the sound came from. It is never a name and never an owner.'
]

async function promptOf(run) {
  let system = ''
  await run(async (messages) => {
    system = messages[0].content
    return '{}'
  })
  return system
}

test('the final meeting record and the rolling tracker are both told what the tags mean', async () => {
  const transcript = { segments: [seg(1, 'We agreed to ship.', { speaker: 'you' })] }
  const record = await promptOf((generate) => generateMeetingSummary(transcript, { generate }))
  const rolling = await promptOf((generate) => {
    const tracker = createRollingIntelligenceTracker({ generate })
    tracker.ingest(transcript.segments)
    return tracker.snapshot()
  })
  for (const [name, prompt] of [['record', record], ['rolling', rolling]]) {
    for (const rule of TAG_RULES) assert.ok(prompt.includes(rule), `${name} prompt: ${rule}`)
    assert.ok(prompt.includes('"owner" and "due" are ONLY what a speaker explicitly said'), `${name} prompt keeps the owner rule`)
  }
})

test('study notes are about lectures, with their own speaker labels, and are not told about "you" and "others"', async () => {
  const prompt = await promptOf((generate) => generateGroundedNotes({ segments: [seg(1, 'Today we cover graphs.', { speaker: 'speaker_00' })] }, { generate }))
  assert.ok(!prompt.includes('`others`'))
  assert.ok(!prompt.includes('recorded the meeting'))
})

test('the lines the model reads carry the tag as written', async () => {
  let user = ''
  await generateMeetingSummary(
    { segments: [seg(1, 'We agreed to ship.', { speaker: 'you' }), seg(2, 'Sounds good.', { speaker: 'others' }), seg(3, 'Overlap.', { speaker: null, uncertain: true })] },
    {
      generate: async (messages) => {
        user = messages[1].content
        return '{}'
      }
    }
  )
  assert.equal(
    user,
    'Transcript:\n\n[seg_0001 | 00:10-00:18 | you] We agreed to ship.\n[seg_0002 | 00:20-00:28 | others] Sounds good.\n[seg_0003 | 00:30-00:38 | unknown] Overlap.'
  )
})
