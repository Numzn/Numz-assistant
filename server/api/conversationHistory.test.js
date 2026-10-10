import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createConversationRepository } from '../persistence/conversationRepository.js'
import { createSessionService, sessionService } from '../sessions/sessionService.js'
import { assistantRouter } from '../routes/assistant.js'
import { errorHandler, notFoundHandler } from '../http/errorHandler.js'

const quiet = { error() {}, warn() {}, info() {}, log() {} }

// ---- the session service ---------------------------------------------------------------------------------

function service(database = createDatabase({ filename: ':memory:' }), logger = quiet) {
  const store = createConversationRepository(database)
  return { database, store, sessions: createSessionService({ store, logger }) }
}

test('a session with no messages is never saved (opening the page creates no clutter)', () => {
  const { store, sessions } = service()
  sessions.createSession({ client: 'browser' })
  sessions.createSession({ client: 'browser' })
  assert.equal(store.list().total, 0)
})

test('messages are saved as they are added, under the session id', () => {
  const { store, sessions } = service()
  const session = sessions.createSession()
  sessions.appendMessage(session.id, { role: 'user', content: 'What is 2 + 2?' })
  sessions.appendMessage(session.id, { role: 'assistant', content: '4' })
  const saved = store.get(session.id)
  assert.equal(saved.title, 'What is 2 + 2?')
  assert.deepEqual(saved.messages.map((m) => m.content), ['What is 2 + 2?', '4'])
})

test('after a restart a saved conversation is loaded back, with its context, when its id is asked for', () => {
  const { database, sessions } = service()
  const session = sessions.createSession()
  sessions.appendMessage(session.id, { role: 'user', content: 'My favourite number is 42.' })
  sessions.appendMessage(session.id, { role: 'assistant', content: 'OK.' })

  const afterRestart = createSessionService({ store: createConversationRepository(database), logger: quiet })
  const restored = afterRestart.getSession(session.id)
  assert.deepEqual(restored.messages.map((m) => `${m.role}:${m.content}`), ['user:My favourite number is 42.', 'assistant:OK.'])
  assert.equal(restored.state, 'IDLE')

  afterRestart.appendMessage(session.id, { role: 'user', content: 'What is my number?' })
  assert.equal(afterRestart.getSession(session.id).messages.length, 3, 'the conversation carries on from where it was')
  assert.equal(createConversationRepository(database).get(session.id).messages.length, 3, 'and the new message is saved too')
})

test('an unknown or malformed id restores nothing', () => {
  const { sessions } = service()
  assert.equal(sessions.getSession('not-a-uuid'), null)
  assert.equal(sessions.getSession('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), null)
})

test('a store that fails never breaks the chat: the message stays in memory and the failure is logged', () => {
  const logged = []
  const broken = {
    append() {
      throw new Error('disk full')
    },
    get() {
      throw new Error('disk full')
    }
  }
  const sessions = createSessionService({ store: broken, logger: { error: (...args) => logged.push(args.join(' ')) } })
  const session = sessions.createSession()
  assert.doesNotThrow(() => sessions.appendMessage(session.id, { role: 'user', content: 'hello' }))
  assert.equal(sessions.getSession(session.id).messages.length, 1)
  assert.match(logged.join('\n'), /could not save a message.*disk full/)
  assert.equal(sessions.getSession('dddddddd-dddd-4ddd-8ddd-dddddddddddd'), null, 'a failing load is a miss, not a crash')
})

test('with history off nothing is saved and sessions still work', () => {
  const sessions = createSessionService({ store: null })
  const session = sessions.createSession()
  sessions.appendMessage(session.id, { role: 'user', content: 'hello' })
  assert.equal(sessions.getHistory(), null)
  assert.equal(sessions.getSession(session.id).messages.length, 1)
})

// ---- the HTTP routes -------------------------------------------------------------------------------------

async function serve() {
  const database = createDatabase({ filename: ':memory:' })
  sessionService.useStore(createConversationRepository(database))
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.id = 'test-request'
    next()
  })
  app.use('/api/v1/assistant', assistantRouter)
  app.use('/api', notFoundHandler)
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}/api/v1/assistant`
  return { base, close: () => new Promise((resolve) => server.close(resolve)) }
}

function conversation(text = 'hello') {
  const session = sessionService.createSession()
  sessionService.appendMessage(session.id, { role: 'user', content: text })
  sessionService.appendMessage(session.id, { role: 'assistant', content: `re: ${text}` })
  return session.id
}

test('GET /conversations lists saved conversations, newest first, with paging', async () => {
  const { base, close } = await serve()
  try {
    assert.deepEqual(await (await fetch(`${base}/conversations`)).json(), { enabled: true, total: 0, conversations: [] })
    const first = conversation('first question')
    await new Promise((r) => setTimeout(r, 5))
    const second = conversation('second question')
    const body = await (await fetch(`${base}/conversations`)).json()
    assert.equal(body.enabled, true)
    assert.equal(body.total, 2)
    assert.deepEqual(body.conversations.map((c) => [c.id, c.title, c.messageCount]), [[second, 'second question', 2], [first, 'first question', 2]])
    const page = await (await fetch(`${base}/conversations?limit=1&offset=1`)).json()
    assert.deepEqual(page.conversations.map((c) => c.id), [first])
  } finally {
    await close()
  }
})

test('GET /conversations/:id returns the messages; unknown is 404; malformed is 400', async () => {
  const { base, close } = await serve()
  try {
    const id = conversation('what is love')
    const found = await (await fetch(`${base}/conversations/${id}`)).json()
    assert.equal(found.id, id)
    assert.deepEqual(found.messages.map((m) => m.role), ['user', 'assistant'])
    assert.equal((await fetch(`${base}/conversations/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`)).status, 404)
    assert.equal((await fetch(`${base}/conversations/not-a-uuid`)).status, 400)
    assert.equal((await fetch(`${base}/conversations/..%2F..%2Fetc`)).status, 400)
  } finally {
    await close()
  }
})

test('DELETE /conversations/:id removes it from the database and from memory', async () => {
  const { base, close } = await serve()
  try {
    const id = conversation('delete me')
    assert.equal((await fetch(`${base}/conversations/${id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await fetch(`${base}/conversations/${id}`)).status, 404)
    assert.equal((await fetch(`${base}/conversations/${id}`, { method: 'DELETE' })).status, 404)
    assert.equal(sessionService.getSession(id), null, 'it does not come back from memory')
    assert.equal((await (await fetch(`${base}/conversations`)).json()).total, 0)
  } finally {
    await close()
  }
})

test('DELETE /conversations needs ?confirm=all, then removes every conversation and says how many', async () => {
  const { base, close } = await serve()
  try {
    conversation('one')
    conversation('two')
    const refused = await fetch(`${base}/conversations`, { method: 'DELETE' })
    assert.equal(refused.status, 400)
    assert.equal((await (await fetch(`${base}/conversations`)).json()).total, 2, 'nothing was deleted')
    assert.equal((await fetch(`${base}/conversations?confirm=yes`, { method: 'DELETE' })).status, 400)
    const done = await (await fetch(`${base}/conversations?confirm=all`, { method: 'DELETE' })).json()
    assert.deepEqual(done, { deleted: 2 })
    assert.equal((await (await fetch(`${base}/conversations`)).json()).total, 0)
  } finally {
    await close()
  }
})

test('with history off the list says so, and the other routes answer 404', async () => {
  const { base, close } = await serve()
  try {
    sessionService.useStore(null)
    assert.deepEqual(await (await fetch(`${base}/conversations`)).json(), { enabled: false, total: 0, conversations: [] })
    assert.equal((await fetch(`${base}/conversations/ffffffff-ffff-4fff-8fff-ffffffffffff`)).status, 404)
    assert.equal((await fetch(`${base}/conversations/ffffffff-ffff-4fff-8fff-ffffffffffff`, { method: 'DELETE' })).status, 404)
    assert.equal((await fetch(`${base}/conversations?confirm=all`, { method: 'DELETE' })).status, 404)
  } finally {
    await close()
  }
})
