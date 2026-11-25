import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createIdentityRepository } from '../persistence/identityRepository.js'
import { createMemoryRepository } from '../persistence/memoryRepository.js'
import { createMemoryRouter } from '../routes/assistantMemory.js'
import { LEGACY_IDENTITY, personIdentity } from '../auth/identity.js'
import { errorHandler } from '../http/errorHandler.js'

async function serve() {
  const database = createDatabase({ filename: ':memory:' })
  const repo = createIdentityRepository(database)
  const make = (name) => repo.upsertUser({ externalId: `${name}-ext-0001`, email: `${name}@example.com`, name, role: 'viewer' })
  const alice = make('alice')
  const bob = make('bob')
  const audits = []
  const identities = { alice: personIdentity({ id: alice.id, external_id: 'a', email: 'a@example.com', name: 'alice', role: 'viewer' }, { ref: 'r', csrf: 'x' }), bob: personIdentity({ id: bob.id, external_id: 'b', email: 'b@example.com', name: 'bob', role: 'viewer' }, { ref: 'r', csrf: 'x' }), legacy: LEGACY_IDENTITY }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.identity = identities[req.headers['x-test-user']]
    next()
  })
  app.use('/memory', createMemoryRouter({ memories: createMemoryRepository(database), audit: (event, detail) => audits.push([event, detail]) }))
  app.use(errorHandler({ logger: { error() {}, warn() {}, info() {}, log() {} } }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const as = (who) => async (path = '', { method = 'GET', body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/memory${path}`, { method, headers: { 'x-test-user': who, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : null }
  }
  return { alice: as('alice'), bob: as('bob'), legacy: as('legacy'), audits, close: () => new Promise((r) => server.close(r)) }
}

test('the person sees, adds, changes and forgets what the assistant remembers about them', async () => {
  const s = await serve()
  try {
    assert.deepEqual((await s.alice()).json.memories, [])
    const added = await s.alice('', { method: 'POST', body: { text: 'I prefer short answers', kind: 'preference' } })
    assert.equal(added.status, 201)
    assert.deepEqual([added.json.memory.source, added.json.memory.kind, added.json.created], ['added', 'preference', true])
    const id = added.json.memory.id
    // typed with no kind: classified the way the chat does, so the study answers can use a preference
    const typed = await s.alice('', { method: 'POST', body: { text: 'I want to pass databases' } })
    assert.equal(typed.json.memory.kind, 'goal')
    await s.alice(`/${typed.json.memory.id}`, { method: 'DELETE' })
    assert.equal((await s.alice(`/${id}`, { method: 'PATCH', body: { text: 'I prefer very short answers' } })).json.text, 'I prefer very short answers')
    assert.equal((await s.alice('')).json.memories.length, 1)
    assert.equal((await s.alice(`/${id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await s.alice(`/${id}`, { method: 'DELETE' })).status, 404)
    assert.deepEqual(s.audits.map(([e]) => e), ['assistant.memory_add', 'assistant.memory_add', 'assistant.memory_forget', 'assistant.memory_forget'])
    assert.equal((await s.alice('', { method: 'POST', body: { text: '   ' } })).status, 400)
    assert.equal((await s.alice('', { method: 'POST', body: { text: 'x'.repeat(401) } })).json.code, 'memory-too-long')
  } finally {
    await s.close()
  }
})

test('nobody sees or touches another person\'s memories, and the shared mode has its own', async () => {
  const s = await serve()
  try {
    const mine = (await s.alice('', { method: 'POST', body: { text: 'a private thing' } })).json.memory
    assert.deepEqual((await s.bob()).json.memories, [])
    assert.equal((await s.bob(`/${mine.id}`, { method: 'PATCH', body: { text: 'changed' } })).status, 404)
    assert.equal((await s.bob(`/${mine.id}`, { method: 'DELETE' })).status, 404)
    assert.deepEqual((await s.legacy()).json.memories, [])
    await s.legacy('', { method: 'POST', body: { text: 'a shared-mode fact' } })
    assert.equal((await s.alice()).json.memories.length, 1)
    assert.equal((await s.legacy()).json.memories.length, 1)
  } finally {
    await s.close()
  }
})

test('forgetting everything needs it said in so many words', async () => {
  const s = await serve()
  try {
    await s.alice('', { method: 'POST', body: { text: 'one thing' } })
    await s.alice('', { method: 'POST', body: { text: 'another thing' } })
    assert.equal((await s.alice('', { method: 'DELETE' })).status, 400)
    assert.equal((await s.alice()).json.memories.length, 2)
    assert.deepEqual((await s.alice('?confirm=all', { method: 'DELETE' })).json, { forgotten: 2 })
    assert.deepEqual((await s.alice()).json.memories, [])
  } finally {
    await s.close()
  }
})
