import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantContext } from '../assistant/assistantContext.js'
import { createContextService } from '../assistant/contextService.js'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createIdentityRepository } from '../persistence/identityRepository.js'
import { createMemoryRepository } from '../persistence/memoryRepository.js'
import { LEGACY_OWNER } from '../sessions/sessionService.js'
import { createAssistantOrchestrator } from './assistantOrchestrator.js'

function rig({ sources = {}, failContext = false } = {}) {
  const database = createDatabase({ filename: ':memory:' })
  const identity = createIdentityRepository(database)
  const people = Object.fromEntries(['one', 'two'].map((n) => [n, identity.upsertUser({ externalId: `person-${n}-ext`, email: `${n}@example.com`, name: n, role: 'viewer' }).id]))
  const memories = createMemoryRepository(database)
  const context = createContextService({ memories, sources, clock: () => Date.parse('2026-11-25T12:07:00Z') })
  if (failContext) context.build = () => { throw new Error('boom') }
  assistantContext.use({ memories, context })
  const sent = []
  const events = []
  const orchestrator = createAssistantOrchestrator({
    stream: async function* (messages) {
      sent.push(messages)
      yield { type: 'token', token: 'Sure. ' }
      yield { type: 'message', content: 'Sure. Done.' }
    }
  })
  const turn = (message, over = {}) => orchestrator.runStreamingTurn({ sessionId: `s-${Math.random()}`, message, owner: people.one, person: { name: 'Sam Phiri', timeZone: 'Africa/Lusaka' }, emit: (type, data) => events.push([type, data]), ...over })
  return { memories, sent, events, turn, people }
}
test.afterEach(() => assistantContext.use(null))

test('every turn reaches the model with the persona AND what is known: the date in the person\'s zone, their name, what they asked to be remembered', async () => {
  const t = rig()
  t.memories.forOwner(t.people.one).add({ text: 'I study economics at UNZA' })
  await t.turn('What day is it?')
  const [system, ...conversation] = t.sent[0]
  assert.equal(system.role, 'system')
  assert.match(system.content, /^You are Numz, a voice assistant/)
  assert.match(system.content, /Now: Wednesday 25 November 2026, 14:07 \(Africa\/Lusaka\)/)
  assert.match(system.content, /The person you are talking to: Sam\./)
  assert.match(system.content, /- I study economics at UNZA/)
  assert.match(system.content, /if something is not here, say you do not know it instead of guessing/)
  assert.deepEqual(conversation.map((m) => m.role), ['user'])
  assert.deepEqual(t.events.filter(([type]) => type === 'STATE').map(([, d]) => d.state), ['THINKING', 'RETRIEVING_MEMORY', 'GENERATING', 'SPEAKING', 'IDLE'], 'the orb shows the lookup')
})

test('"remember that ..." is done before the model answers, and the model is told what really happened', async () => {
  const t = rig()
  await t.turn('Remember that my exam is on Friday')
  assert.deepEqual(t.memories.forOwner(t.people.one).list().map((m) => [m.text, m.kind, m.source]), [['my exam is on Friday', 'fact', 'said']])
  assert.match(t.sent[0][0].content, /JUST NOW the person asked you to remember: "my exam is on Friday"\. It is saved\. Confirm in one short sentence/)
  assert.match(t.sent[0][0].content, /- my exam is on Friday/, 'and it is already part of what is known')
  assert.deepEqual(t.events.find(([type]) => type === 'MEMORY')[1].action, 'remembered')
  // the next turn, in any conversation, knows it
  await t.turn('what are my plans?')
  assert.match(t.sent[1][0].content, /- my exam is on Friday/)
  assert.doesNotMatch(t.sent[1][0].content, /JUST NOW/)
})

test('"forget ..." removes what matches and says what it did; "forget everything" is never done by voice', async () => {
  const t = rig()
  const mine = t.memories.forOwner(t.people.one)
  mine.add({ text: 'my exam is on Friday' })
  mine.add({ text: 'I prefer short answers' })
  await t.turn('forget that my exam is on Friday')
  assert.deepEqual(mine.list().map((m) => m.text), ['I prefer short answers'])
  assert.match(t.sent[0][0].content, /1 memory was forgotten: "my exam is on Friday"/)
  await t.turn('forget about my cat')
  assert.match(t.sent[1][0].content, /nothing you remember matches that/)
  await t.turn('forget everything')
  assert.equal(mine.list().length, 1, 'nothing was erased')
  assert.match(t.sent[2][0].content, /You have NOT done it[\s\S]*"Forget all" in the Memory panel/)
  await t.turn('what do you remember about me?')
  assert.match(t.sent[3][0].content, /asked what you remember about them/)
})

test('a memory belongs to the person who said it: another person\'s turn does not see it', async () => {
  const t = rig()
  await t.turn('remember that I am afraid of heights', { owner: t.people.one })
  await t.turn('hello', { owner: t.people.two, person: { name: 'Other Person' } })
  assert.doesNotMatch(t.sent[1][0].content, /heights/)
  assert.deepEqual(t.memories.forOwner(t.people.two).list(), [])
  // the shared (access-code) mode has its own memory too
  await t.turn('remember that the lab is closed', { owner: LEGACY_OWNER, person: {} })
  assert.equal(t.memories.forOwner(null).list().length, 1)
  assert.equal(t.memories.forOwner(t.people.one).list().length, 1)
})

test('the study, meetings and recent chats of the person are in front of the model too', async () => {
  const t = rig({ sources: { study: () => ({ courses: ['Databases'], review: ['third normal form'] }), meetings: () => [{ title: 'Lecture 2', createdAt: '2026-11-24T08:00:00Z', status: 'COMPLETED' }] } })
  await t.turn('hi')
  assert.match(t.sent[0][0].content, /Their study: courses: Databases; topics that came up as hard: third normal form\./)
  assert.match(t.sent[0][0].content, /Their latest meetings, newest first: "Lecture 2" on Tue 24 Nov\./)
})

test('if the context cannot be built the conversation still goes to the model, with the persona alone', async () => {
  const t = rig({ failContext: true })
  const warn = console.warn
  console.warn = () => {}
  try {
    await t.turn('hello')
  } finally {
    console.warn = warn
  }
  assert.deepEqual(t.sent[0].map((m) => m.role), ['user'], 'the model adds the persona itself when there is no system message')
})

test('with no context service (a test, or a server that has none) a turn is exactly what it was', async () => {
  const t = rig()
  assistantContext.use(null)
  await t.turn('hello')
  assert.deepEqual(t.sent[0].map((m) => m.role), ['user'])
})
