import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createMemoryRepository } from '../persistence/memoryRepository.js'
import { ABOUT_HEADER, createContextService, nowText, validZone } from './contextService.js'

const NOW = Date.parse('2026-11-25T12:07:00Z') // 14:07 in Lusaka (UTC+2), 12:07 in UTC, 07:07 in New York
const rig = (sources = {}) => {
  const memories = createMemoryRepository(createDatabase({ filename: ':memory:' }))
  return { memories, service: createContextService({ memories, sources, clock: () => NOW }) }
}

test('the date and the time are the person\'s own: a model cannot know them, so they are told', () => {
  assert.equal(nowText(NOW, 'Africa/Lusaka'), 'Wednesday 25 November 2026, 14:07 (Africa/Lusaka)')
  assert.equal(nowText(NOW, 'America/New_York'), 'Wednesday 25 November 2026, 07:07 (America/New_York)')
  assert.equal(validZone('Not/AZone', 'Africa/Lusaka'), 'Africa/Lusaka')
  assert.equal(validZone(undefined, 'also-not-real'), 'UTC')
  const { service } = rig()
  assert.match(service.build({ owner: null, person: { timeZone: 'Africa/Lusaka' } }).text, /^Now: Wednesday 25 November 2026, 14:07 \(Africa\/Lusaka\)\./)
  assert.match(service.build({ owner: null, person: { timeZone: 'garbage' } }).text, /\(UTC\)/, 'a time zone the runtime does not know falls back, it never throws')
})

test('the context names the person (first name) and lists what they asked to be remembered, newest first', () => {
  const { service, memories } = rig()
  memories.forOwner(null).add({ text: 'I study economics at UNZA' })
  memories.forOwner(null).add({ text: 'I prefer short answers' })
  const { text, memoryIds } = service.build({ owner: null, person: { name: 'Numerio Mwansa' } })
  assert.match(text, /The person you are talking to: Numerio\./)
  assert.doesNotMatch(text, /Mwansa/)
  assert.match(text, /What they asked you to remember:\n- I prefer short answers\n- I study economics at UNZA/)
  assert.equal(memoryIds.length, 2)
  assert.ok(memories.forOwner(null).list().every((m) => m.lastUsedAt), 'using a memory is stamped')
  assert.match(rig().service.build({ owner: null }).text, /They have not asked you to remember anything yet\./)
})

test('only the memories of the person asked about are used', () => {
  const { service, memories } = rig()
  memories.forOwner(null).add({ text: 'a fact that belongs to the shared mode' })
  assert.doesNotMatch(service.build({ owner: 'someone-else' }).text, /shared mode/)
})

test('study, meetings and recent chats are summarised, from whichever sources exist', () => {
  const asked = []
  const { service } = rig({
    study: (owner) => (asked.push(['study', owner]), { courses: ['Parallel Computing', 'Databases'], current: { type: 'study', course: 'Parallel Computing', topic: 'Flynn taxonomy' }, review: ['virtual memory'] }),
    meetings: (owner) => (asked.push(['meetings', owner]), [{ title: 'Lecture 2 - Parallel architectures', createdAt: '2026-11-24T08:00:00Z', endedAt: '2026-11-24T08:52:00Z', status: 'COMPLETED' }, { title: null, createdAt: '2026-11-23T08:00:00Z', status: 'RECOVERING' }]),
    conversations: () => [{ title: 'Flynn taxonomy help' }, { title: 'Budget for December' }]
  })
  const { text } = service.build({ owner: 'u1', person: { timeZone: 'Africa/Lusaka' } })
  assert.match(text, /Their study: courses: Parallel Computing, Databases; a study session is open now for Parallel Computing on Flynn taxonomy; topics that came up as hard: virtual memory\./)
  assert.match(text, /Their latest meetings, newest first: "Lecture 2 - Parallel architectures" on Tue 24 Nov, 52 min; "Untitled meeting" on Mon 23 Nov \(recovering\)\./)
  assert.match(text, /Their latest chats: "Flynn taxonomy help", "Budget for December"\./)
  assert.deepEqual(asked, [['study', 'u1'], ['meetings', 'u1']], 'each source is asked for this owner only')
})

test('a transcript excerpt is added only when they ask about a meeting, and says it is not all of it', () => {
  const { service } = rig({
    meetings: () => [{ title: 'Lecture 2', createdAt: '2026-11-24T08:00:00Z', status: 'COMPLETED' }],
    meetingExcerpt: () => ({ title: 'Lecture 2', text: 'We covered SIMD and MIMD. [...] Homework is chapter 4.' })
  })
  assert.doesNotMatch(service.build({ owner: 'u1', message: 'what time is it?' }).text, /transcript/)
  assert.doesNotMatch(service.build({ owner: 'u1', message: 'schedule a meeting' }).text, /transcript/, 'mentioning a meeting is not asking about the past')
  const asked = service.build({ owner: 'u1', message: 'what did we discuss in the last meeting?' }).text
  assert.match(asked, /From the transcript of their latest finished meeting \("Lecture 2"\), the start and the end \(not all of it; say so if what they ask is not here\):\nWe covered SIMD and MIMD\. \[\.\.\.\] Homework is chapter 4\./)
})

test('a source that fails is left out: knowing less never stops an answer', () => {
  const { service } = rig({ study: () => { throw new Error('database is locked') }, meetings: () => [{ title: 'Lecture', createdAt: '2026-11-24T08:00:00Z', status: 'COMPLETED' }] })
  const { text } = service.build({ owner: 'u1' })
  assert.doesNotMatch(text, /Their study/)
  assert.match(text, /Their latest meetings/)
})

test('the memory block has a budget: a very full memory does not fill the prompt', () => {
  const { service, memories } = rig()
  for (let i = 0; i < 100; i++) memories.forOwner(null).add({ text: `fact number ${i} ${'x'.repeat(80)}` })
  const { text, memoryIds } = service.build({ owner: null })
  assert.ok(memoryIds.length <= 40 && text.length < 2600, `${memoryIds.length} memories, ${text.length} characters`)
})

test('the other functions get a short note on the person: how they like things and what they work towards, never their day', () => {
  const { service, memories } = rig({ meetings: () => [{ title: 'Secret board meeting', createdAt: '2026-11-24T08:00:00Z', status: 'COMPLETED' }] })
  assert.equal(service.about(null), '', 'nothing known, nothing added to a prompt')
  memories.forOwner(null).add({ text: 'I prefer short answers', kind: 'preference' })
  memories.forOwner(null).add({ text: 'I want to pass my exams in December', kind: 'goal' })
  memories.forOwner(null).add({ text: 'I study economics at UNZA', kind: 'fact' })
  memories.forOwner(null).add({ text: 'my sister is called Ana', kind: 'person' })
  memories.forOwner(null).add({ text: 'buy bread', kind: 'note' })
  const about = service.about(null)
  assert.ok(about.startsWith(ABOUT_HEADER))
  assert.match(about, /- I prefer short answers/)
  assert.match(about, /- I want to pass my exams in December/)
  assert.match(about, /- I study economics at UNZA/)
  assert.doesNotMatch(about, /Ana|bread|board meeting|Now:/, 'people and notes are for conversation; the day is not for an exam answer')
  assert.equal(service.about('someone-else'), '')
})
