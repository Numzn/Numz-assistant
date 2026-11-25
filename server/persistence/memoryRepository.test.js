import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabase } from './sqliteDatabase.js'
import { createIdentityRepository } from './identityRepository.js'
import { MAX_MEMORIES, MAX_MEMORY_CHARS, MemoryError, createMemoryRepository } from './memoryRepository.js'

function rig() {
  const database = createDatabase({ filename: ':memory:' })
  const identity = createIdentityRepository(database)
  const make = (name) => identity.upsertUser({ externalId: `${name}-ext-0001`, email: `${name}@example.com`, name, role: 'viewer' }).id
  let t = Date.parse('2026-11-25T10:00:00Z')
  const repo = createMemoryRepository(database, { clock: () => (t += 1000) })
  return { database, repo, alice: make('alice'), bob: make('bob') }
}

test('a memory is one short thing the person said or added; the same thing again is brought up to date, not stored twice', () => {
  const { repo, alice } = rig()
  const mine = repo.forOwner(alice)
  const first = mine.add({ text: '  I study   economics at UNZA ', kind: 'fact', source: 'said' })
  assert.equal(first.created, true)
  assert.equal(first.memory.text, 'I study economics at UNZA')
  const again = mine.add({ text: 'i study economics at unza!', kind: 'fact' })
  assert.equal(again.created, false)
  assert.equal(again.memory.id, first.memory.id)
  assert.equal(mine.list().length, 1)
  assert.throws(() => mine.add({ text: '   ' }), (e) => e instanceof MemoryError && e.code === 'invalid-input')
  assert.throws(() => mine.add({ text: 'x'.repeat(MAX_MEMORY_CHARS + 1) }), (e) => e.code === 'memory-too-long')
  assert.throws(() => mine.add({ text: 'a thing', kind: 'nonsense' }), (e) => e.code === 'invalid-input')
  assert.equal(mine.add({ text: 'zero\u0000byte' }).memory.text, 'zerobyte')
})

test('a person\'s memories are theirs alone: another person, and the shared fallback, cannot see, change or delete them', () => {
  const { repo, alice, bob } = rig()
  const a = repo.forOwner(alice)
  const b = repo.forOwner(bob)
  const shared = repo.forOwner(null)
  const mem = a.add({ text: 'my exam is on Friday' }).memory
  assert.deepEqual([b.list().length, shared.list().length], [0, 0])
  assert.equal(b.get(mem.id), null)
  assert.equal(b.change(mem.id, { text: 'hacked' }), null)
  assert.equal(b.remove(mem.id), false)
  assert.deepEqual(b.forget('exam'), [])
  assert.equal(b.removeAll(), 0)
  assert.equal(a.get(mem.id).text, 'my exam is on Friday')
  shared.add({ text: 'a shared-mode fact' })
  assert.equal(a.list().length, 1, 'the fallback\'s memories are not a person\'s')
  assert.equal(shared.list().length, 1)
})

test('changing, forgetting by words, forgetting one, forgetting all, and the limit', () => {
  const { repo, alice } = rig()
  const mine = repo.forOwner(alice)
  const a = mine.add({ text: 'my exam is on Friday', kind: 'fact' }).memory
  mine.add({ text: 'I prefer short answers', kind: 'preference' })
  mine.add({ text: 'my sister is called Ana', kind: 'person' })
  assert.equal(mine.change(a.id, { text: 'my exam is on Monday' }).text, 'my exam is on Monday')
  assert.equal(mine.change(a.id, { kind: 'goal' }).kind, 'goal')
  assert.equal(mine.change('nope', { text: 'x' }), null)
  assert.deepEqual(mine.forget('my exam').map((m) => m.text), ['my exam is on Monday'])
  assert.deepEqual(mine.forget('nothing like this'), [])
  assert.equal(mine.forget('').length, 0)
  const sister = mine.list().find((m) => m.kind === 'person')
  assert.equal(mine.remove(sister.id), true)
  assert.equal(mine.list().length, 1)
  assert.equal(mine.removeAll(), 1)
  for (let i = 0; i < MAX_MEMORIES; i++) mine.add({ text: `fact number ${i}` })
  assert.throws(() => mine.add({ text: 'one too many' }), (e) => e.code === 'memory-full')
})

test('what is remembered is listed newest first, and using a memory is stamped', () => {
  const { repo, alice } = rig()
  const mine = repo.forOwner(alice)
  const one = mine.add({ text: 'first thing' }).memory
  const two = mine.add({ text: 'second thing' }).memory
  assert.deepEqual(mine.list().map((m) => m.text), ['second thing', 'first thing'])
  assert.equal(mine.get(one.id).lastUsedAt, null)
  mine.touch([one.id, two.id])
  assert.ok(mine.get(one.id).lastUsedAt)
})

test('deleting a person deletes what the assistant remembered about them', () => {
  const { repo, database, alice } = rig()
  repo.forOwner(alice).add({ text: 'a private thing' })
  database.exec('PRAGMA foreign_keys = ON')
  database.prepare('DELETE FROM ai_users WHERE id = ?').run(alice)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM assistant_memories').get().n, 0)
})
