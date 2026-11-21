import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { personIdentity } from '../auth/identity.js'
import { createCameraService } from '../camera/cameraService.js'
import { errorHandler } from '../http/errorHandler.js'
import { createConversationRepository } from '../persistence/conversationRepository.js'
import { createIdentityRepository } from '../persistence/identityRepository.js'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createCameraRouter } from '../routes/camera.js'
import { assistantRouter } from '../routes/assistant.js'
import { createSessionService, LEGACY_OWNER, sessionService } from '../sessions/sessionService.js'
import { createMeter } from '../usage/meter.js'

/**
 * Whose conversations are whose. The real routers, the real session service, the real stores and a real socket; only the people (who
 * the access middleware says is asking) are scripted, through a header that exists only in this file.
 */

const quiet = { error() {}, warn() {}, info() {}, log() {} }
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-pretend-picture')])
const reading = (text) => JSON.stringify({ isQuestion: true, text, options: [], type: 'short-answer', subject: 'geography', hasDiagram: false, confidence: 0.9, reason: '' })
const ANSWER = JSON.stringify({ subject: 'geography', type: 'short-answer', answer: 'Paris', steps: ['It is Paris.'], explanation: 'Paris.', confidence: 'high', uncertainty: null })

async function rig(env = {}) {
  const database = createDatabase({ filename: ':memory:' })
  const store = createConversationRepository(database)
  sessionService.useStore(store)
  const people = createIdentityRepository(database)
  const meter = createMeter({ database, env, logger: quiet })
  const ids = {}
  const identities = {}
  for (const name of ['alice', 'bob', 'carol']) {
    const user = people.upsertUser({ externalId: `${name.charCodeAt(0).toString(16).padStart(2, '0')}0000000000`.slice(0, 12), email: `${name}@example.com`, name, role: 'viewer' })
    ids[name] = user.id
    identities[user.id] = personIdentity(user, { ref: 'testref0', csrf: 'x' })
  }
  let nextQuestion = 'What is the capital of France?'
  const camera = createCameraService({
    vision: { configured: true, name: 'fake', read: async () => reading(nextQuestion) },
    answerEngine: async () => ANSWER,
    sessions: sessionService,
    logger: quiet,
    limits: { minReadIntervalMs: 0 }
  })
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use((req, _res, next) => {
    const who = req.headers['x-test-user']
    if (who) req.identity = identities[ids[who]] ?? identities[who]
    req.meter = meter
    next()
  })
  const signedIn = (req, res, next) => (req.identity ? next() : res.status(401).json({ error: 'sign in', code: 'session-required' }))
  app.use('/api/v1/assistant/camera', signedIn, createCameraRouter({ service: camera }))
  app.use('/api/v1/assistant', signedIn, assistantRouter)
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}/api/v1/assistant`
  const as = (who) => async (path, { method = 'GET', body, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-test-user': who, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers }
  }
  return {
    database,
    store,
    meter,
    camera,
    ids,
    alice: as('alice'),
    bob: as('bob'),
    carol: as('carol'),
    nobody: as(''),
    asRaw: as,
    setQuestion: (text) => {
      nextQuestion = text
    },
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

const say = async (client, text, sessionId) =>
  (await client(sessionId ? `/sessions/${sessionId}/chat` : '/chat', { method: 'POST', body: { message: text, ...(sessionId ? {} : {}) } })).json

test('two people chat: each has their own history and neither can see, read, open or delete the other\'s', async () => {
  const r = await rig()
  try {
    const a1 = await say(r.alice, 'alice secret one')
    const b1 = await say(r.bob, 'bob secret one')
    assert.notEqual(a1.sessionId, b1.sessionId, 'even the un-addressed chat is not shared')

    const aList = (await r.alice('/conversations')).json
    const bList = (await r.bob('/conversations')).json
    assert.deepEqual(aList.conversations.map((c) => c.id), [a1.sessionId])
    assert.deepEqual(bList.conversations.map((c) => c.id), [b1.sessionId])
    assert.equal(aList.total, 1)
    assert.ok(!JSON.stringify(aList).includes('bob secret'))

    // by id: someone else's conversation does not exist
    assert.equal((await r.alice(`/conversations/${b1.sessionId}`)).status, 404)
    assert.equal((await r.bob(`/conversations/${a1.sessionId}`)).status, 404)
    assert.equal((await r.alice(`/conversations/${b1.sessionId}`, { method: 'DELETE' })).status, 404)
    assert.equal((await r.bob(`/conversations/${b1.sessionId}`)).json.messages.length, 2, 'bob\'s is untouched')

    // naming someone else's session: a fresh conversation of your own, theirs is not touched
    const intruder = await say(r.alice, 'alice writes into bob\'s id', b1.sessionId)
    assert.notEqual(intruder.sessionId, b1.sessionId)
    assert.equal((await r.bob(`/conversations/${b1.sessionId}`)).json.messages.length, 2)
    assert.ok(!JSON.stringify((await r.bob('/conversations')).json).includes(intruder.sessionId))
    const header = await r.alice('/chat', { method: 'POST', body: { message: 'via the header' }, headers: { 'x-assistant-session-id': b1.sessionId } })
    assert.notEqual(header.json.sessionId, b1.sessionId)
    const viaBody = await r.alice('/chat', { method: 'POST', body: { message: 'via the body', sessionId: b1.sessionId } })
    assert.notEqual(viaBody.json.sessionId, b1.sessionId)
    assert.equal((await r.bob(`/conversations/${b1.sessionId}`)).json.messages.length, 2)

    // state routes
    assert.equal((await r.alice(`/sessions/${b1.sessionId}/state`)).status, 404)
    assert.equal((await r.alice(`/sessions/${b1.sessionId}/state`, { method: 'PATCH', body: { state: 'THINKING' } })).status, 404)
    assert.equal((await r.bob(`/sessions/${b1.sessionId}/state`)).json.state, 'IDLE')
  } finally {
    await r.close()
  }
})

test('"delete everything" deletes the caller\'s conversations and nobody else\'s', async () => {
  const r = await rig()
  try {
    await say(r.alice, 'a1')
    const a2 = await (await r.alice('/sessions', { method: 'POST', body: {} })).json
    await say(r.alice, 'a2', a2.sessionId)
    await say(r.bob, 'b1')
    assert.equal((await r.alice('/conversations?confirm=all', { method: 'DELETE' })).json.deleted, 2)
    assert.equal((await r.alice('/conversations')).json.total, 0)
    assert.equal((await r.bob('/conversations')).json.total, 1)
    assert.equal((await r.bob('/conversations?confirm=all', { method: 'DELETE' })).json.deleted, 1)
  } finally {
    await r.close()
  }
})

test('the conversation with no session named is one per person, never one everybody shares', async () => {
  const r = await rig()
  try {
    const a = (await r.alice('/state')).json
    const b = (await r.bob('/state')).json
    assert.notEqual(a.sessionId, b.sessionId)
    await r.alice('/state', { method: 'PATCH', body: { state: 'THINKING' } })
    assert.equal((await r.alice('/state')).json.state, 'THINKING')
    assert.equal((await r.bob('/state')).json.state, 'IDLE')
    const first = await say(r.alice, 'one')
    const second = await say(r.alice, 'two')
    assert.equal(second.sessionId, first.sessionId, 'but it carries on as theirs')
    assert.equal((await r.alice(`/conversations/${first.sessionId}`)).json.messages.length, 4)
  } finally {
    await r.close()
  }
})

test('a conversation that existed before people (no owner) is invisible and untouchable to every person', async () => {
  const r = await rig()
  try {
    const old = '99999999-9999-4999-8999-999999999999'
    r.store.append(old, { role: 'user', content: 'from the days of one shared code' }) // the fallback view: no owner
    r.store.append(old, { role: 'assistant', content: 'noted' })
    for (const who of [r.alice, r.bob]) {
      assert.equal((await who('/conversations')).json.total, 0)
      assert.equal((await who(`/conversations/${old}`)).status, 404)
      assert.equal((await who(`/conversations/${old}`, { method: 'DELETE' })).status, 404)
      const attempt = await say(who, 'let me add to the old one', old)
      assert.notEqual(attempt.sessionId, old)
    }
    assert.equal(r.store.get(old).messages.length, 2, 'still exactly as it was')
    assert.equal(r.store.list().total, 1, 'and still there for the host-side administrator')
    // administration releases it to one person, on purpose
    assert.equal(r.store.legacy.claim(r.ids.alice), 1)
    assert.equal((await r.alice(`/conversations/${old}`)).json.messages.length, 2)
    assert.equal((await r.bob(`/conversations/${old}`)).status, 404)
    assert.throws(() => r.database.prepare('UPDATE assistant_conversations SET owner_user_id = ? WHERE conversation_id = ?').run(r.ids.bob, old), /permanent/, 'once given, never moved')
  } finally {
    await r.close()
  }
})

test('the store itself refuses what the routes would never ask: writing into, reading or deleting another owner\'s conversation', () => {
  const database = createDatabase({ filename: ':memory:' })
  const people = createIdentityRepository(database)
  const store = createConversationRepository(database)
  const a = people.upsertUser({ externalId: 'aaaaaaaaaaaa', email: 'a@x.y', name: 'a', role: 'viewer' }).id
  const b = people.upsertUser({ externalId: 'bbbbbbbbbbbb', email: 'b@x.y', name: 'b', role: 'viewer' }).id
  const id = '11111111-1111-4111-8111-111111111111'
  assert.equal(store.forOwner(a).append(id, { role: 'user', content: 'mine' }), true)
  assert.equal(store.forOwner(b).append(id, { role: 'user', content: 'not mine' }), false, 'an id that is someone else\'s accepts nothing')
  assert.equal(store.append(id, { role: 'user', content: 'not even the fallback' }), false)
  assert.equal(store.forOwner(b).get(id), null)
  assert.equal(store.forOwner(b).remove(id), false)
  assert.equal(store.forOwner(b).removeAll(), 0)
  assert.equal(store.get(id), null)
  assert.equal(store.forOwner(a).get(id).messages.length, 1)
  assert.equal(store.idTaken(id), true)
  assert.equal(store.forOwner(a).list().total, 1)
  assert.equal(store.forOwner(b).list().total, 0)
  assert.equal(store.list().total, 0, 'the fallback sees only ownerless rows')
  assert.throws(() => store.forOwner(''), /needs a user id/)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM assistant_messages WHERE conversation_id = ?').get(id).n, 1)
})

test('a conversation brought back after a restart is loaded only for its owner', () => {
  const database = createDatabase({ filename: ':memory:' })
  const people = createIdentityRepository(database)
  const store = createConversationRepository(database)
  const a = people.upsertUser({ externalId: 'aaaaaaaaaaaa', email: 'a@x.y', name: 'a', role: 'viewer' }).id
  const b = people.upsertUser({ externalId: 'bbbbbbbbbbbb', email: 'b@x.y', name: 'b', role: 'viewer' }).id
  const before = createSessionService({ store, logger: quiet })
  const mine = before.forOwner(a).createSession()
  before.forOwner(a).appendMessage(mine.id, { role: 'user', content: 'remember 42' })
  const after = createSessionService({ store: createConversationRepository(database), logger: quiet })
  assert.equal(after.forOwner(b).getSession(mine.id), null)
  assert.equal(after.getSession(mine.id), null, 'not even the fallback')
  assert.equal(after.forOwner(a).getSession(mine.id).messages[0].content, 'remember 42')
  assert.throws(() => after.forOwner(b).appendMessage(mine.id, { role: 'user', content: 'x' }), /not found/i)
  assert.equal(LEGACY_OWNER, 'legacy')
})

test('the camera: a session is its starter\'s alone, and what it saves lands in their own history', async () => {
  const r = await rig()
  try {
    const a = (await r.alice('/camera/sessions', { method: 'POST' })).json.sessionId
    const read = async (client, id) => client(`/camera/sessions/${id}/read`, { method: 'POST', raw: JPEG, headers: { 'content-type': 'image/jpeg' } })
    const first = await read(r.alice, a)
    assert.equal(first.json.status, 'new')
    // someone else naming that session id: nothing
    assert.equal((await read(r.bob, a)).status, 404)
    assert.equal((await r.bob(`/camera/sessions/${a}/answer`, { method: 'POST', body: { questionId: first.json.questionId } })).status, 404)
    assert.equal((await r.bob(`/camera/sessions/${a}`, { method: 'DELETE' })).status, 204, 'a delete by someone else says nothing and does nothing')
    const answered = await r.alice(`/camera/sessions/${a}/answer`, { method: 'POST', body: { questionId: first.json.questionId } })
    assert.equal(answered.json.status, 'answered', 'the session survived bob\'s delete')
    // the saved conversation is alice's
    assert.equal((await r.alice('/conversations')).json.total, 1)
    assert.equal((await r.bob('/conversations')).json.total, 0)
    assert.equal((await r.bob(`/conversations/${a}`)).status, 404)
    assert.equal((await r.bob(`/conversations/${a}`, { method: 'DELETE' })).status, 404)
    assert.equal((await r.alice('/conversations')).json.total, 1)
    // and only she can clear it
    assert.equal((await r.alice(`/camera/sessions/${a}`, { method: 'DELETE' })).status, 204)
    assert.equal((await r.alice('/conversations')).json.total, 0)
  } finally {
    await r.close()
  }
})

test('one person cannot crowd everybody else out of the camera', async () => {
  const r = await rig()
  try {
    const mine = []
    for (let i = 0; i < 5; i++) mine.push((await r.bob('/camera/sessions', { method: 'POST' })).json.sessionId)
    const read = (id) => r.bob(`/camera/sessions/${id}/read`, { method: 'POST', raw: JPEG, headers: { 'content-type': 'image/jpeg' } })
    assert.equal((await read(mine[0])).status, 404, 'the oldest of their own made room')
    assert.equal((await read(mine[4])).status, 200)
    const hers = (await r.alice('/camera/sessions', { method: 'POST' })).json.sessionId
    assert.equal((await r.alice(`/camera/sessions/${hers}/read`, { method: 'POST', raw: JPEG, headers: { 'content-type': 'image/jpeg' } })).status, 200)
  } finally {
    await r.close()
  }
})

test('every call is counted against the person who made it, and their own limits apply', async () => {
  const r = await rig({ AI_QUOTA_OVERRIDES: JSON.stringify({ viewer: { chatPerDay: 3 } }) })
  try {
    for (let i = 0; i < 3; i++) assert.equal((await r.alice('/chat', { method: 'POST', body: { message: `q${i}` } })).status, 200)
    const blocked = await r.alice('/chat', { method: 'POST', body: { message: 'one too many' } })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.json.code, 'daily-limit')
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    assert.equal((await r.bob('/chat', { method: 'POST', body: { message: 'bob is fine' } })).status, 200, 'alice\'s limit is not bob\'s')
    // the refused one left nothing behind: no saved message, no usage record
    assert.equal((await r.alice(`/conversations`)).json.conversations[0].messageCount, 6)
    const rows = r.database.prepare('SELECT user_id, kind, status FROM ai_usage ORDER BY id').all()
    assert.equal(rows.filter((x) => x.user_id === r.ids.alice).length, 3)
    assert.equal(rows.filter((x) => x.user_id === r.ids.bob).length, 1)
    assert.ok(rows.every((x) => x.kind === 'chat' && x.status === 'ok'))
    assert.ok(!JSON.stringify(rows).includes('q0'), 'only counts, never the words')
    const summary = r.meter.summary({ ownerKey: r.ids.alice, role: 'viewer' })
    assert.deepEqual([summary.used.chat, summary.limits.chat], [3, 3])
  } finally {
    await r.close()
  }
})

test('the emergency stop answers 503 before anything is sent, for one feature or all, and resuming restores service', async () => {
  const r = await rig()
  try {
    assert.equal((await r.alice('/chat', { method: 'POST', body: { message: 'hi' } })).status, 200)
    r.meter.pause('all', 'test')
    const stopped = await r.alice('/chat', { method: 'POST', body: { message: 'hi' } })
    assert.equal(stopped.status, 503)
    assert.equal(stopped.json.code, 'ai-paused')
    assert.equal((await r.alice('/camera/sessions', { method: 'POST' })).status, 201, 'starting a camera session sends nothing')
    r.meter.resume('all', 'test')
    r.meter.pause('camera', 'test')
    assert.equal((await r.alice('/chat', { method: 'POST', body: { message: 'hi' } })).status, 200, 'chat still works with only the camera paused')
    const id = (await r.alice('/camera/sessions', { method: 'POST' })).json.sessionId
    const camera = await r.alice(`/camera/sessions/${id}/read`, { method: 'POST', raw: JPEG, headers: { 'content-type': 'image/jpeg' } })
    assert.equal(camera.status, 503)
    assert.equal(camera.json.code, 'ai-paused')
    r.meter.resume('camera', 'test')
    assert.equal((await r.alice(`/camera/sessions/${id}/read`, { method: 'POST', raw: JPEG, headers: { 'content-type': 'image/jpeg' } })).status, 200)
  } finally {
    await r.close()
  }
})

test('with no identity a route answers 500, never "allow": it can only mean it was mounted without the access check', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/assistant', assistantRouter)
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/v1/assistant`
    for (const [path, method] of [['/conversations', 'GET'], ['/state', 'GET'], ['/sessions', 'POST'], ['/chat', 'POST']]) {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ message: 'hi' }) : undefined })
      assert.equal(res.status, 500, `${method} ${path}`)
      assert.equal((await res.json()).code, 'internal-error')
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
