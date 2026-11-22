import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { personIdentity } from '../auth/identity.js'
import { errorHandler } from '../http/errorHandler.js'
import { createConversationRepository } from '../persistence/conversationRepository.js'
import { createIdentityRepository } from '../persistence/identityRepository.js'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { assistantRouter } from '../routes/assistant.js'
import { createScreenshotRouter } from '../routes/screenshots.js'
import { createScreenshotService } from '../screenshots/screenshotService.js'
import { sessionService } from '../sessions/sessionService.js'

/**
 * Screenshot Intelligence over a real socket: the real router, the real error handler, the real assistant router (for conversations),
 * the real stores. Only the vision model and who is asking are scripted.
 */

const quiet = { error() {}, warn() {}, info() {}, log() {} }

function png(width = 1280, height = 720) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

async function rig({ configured = true, limits = {} } = {}) {
  const database = createDatabase({ filename: ':memory:' })
  const store = createConversationRepository(database)
  sessionService.useStore(store)
  const people = createIdentityRepository(database)
  const identities = {}
  for (const name of ['alice', 'bob']) {
    const user = people.upsertUser({ externalId: `${name.charCodeAt(0).toString(16).padStart(2, '0')}0000000000`.slice(0, 12), email: `${name}@example.com`, name, role: 'viewer' })
    identities[name] = personIdentity(user, { ref: 'testref0', csrf: 'x' })
  }
  const vision = {
    configured,
    name: 'fake',
    calls: [],
    reply: async () => '**What this shows**\nA failing build.',
    async read(args) {
      this.calls.push(args)
      return this.reply(args)
    },
    async answer(args) {
      this.calls.push(args)
      return 'It is the third test.'
    }
  }
  const service = createScreenshotService({ vision, sessions: sessionService, logger: quiet, limits })
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use((req, _res, next) => {
    const who = req.headers['x-test-user']
    if (who) req.identity = identities[who]
    req.screenshots = service
    next()
  })
  const signedIn = (req, res, next) => (req.identity ? next() : res.status(401).json({ error: 'sign in', code: 'session-required' }))
  app.use('/api/v1/assistant/screenshots', signedIn, createScreenshotRouter({ service }))
  app.use('/api/v1/assistant', signedIn, assistantRouter)
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}/api/v1/assistant`
  const as = (who) => async (path, { method = 'GET', body, headers = {}, raw, type } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(who ? { 'x-test-user': who } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(type ? { 'content-type': type } : {}), ...headers },
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
  return { alice: as('alice'), bob: as('bob'), nobody: as(''), service, vision, store, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function using(options, body) {
  const r = await rig(options)
  try {
    await body(r)
  } finally {
    await r.close()
  }
}

const newConversation = async (client) => (await client('/sessions', { method: 'POST', body: {} })).json.sessionId
const upload = (client, conversation, { bytes = png(), type = 'image/png', question } = {}) =>
  client(`/screenshots?conversation=${conversation}`, { method: 'POST', raw: bytes, type, headers: question ? { 'x-screenshot-question': encodeURIComponent(question) } : {} })
async function settled(client, id) {
  for (let i = 0; i < 300; i++) {
    const view = (await client(`/screenshots/${id}`)).json
    if (view.status !== 'analyzing') return view
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('never settled')
}

test('the whole life of a screenshot over HTTP: attach, analyse in the background, follow up, delete', async () => {
  await using({}, async (r) => {
    const conversation = await newConversation(r.alice)
    const created = await upload(r.alice, conversation, { question: 'Why did the build fail? ✓' })
    assert.equal(created.status, 202)
    assert.equal(created.headers.get('cache-control'), 'no-store')
    assert.equal(created.json.status, 'analyzing')
    assert.ok(created.json.id)

    const done = await settled(r.alice, created.json.id)
    assert.equal(done.status, 'ready')
    assert.match(done.analysis, /failing build/)

    // it is part of the ordinary conversation: in the history, with the marker the page turns into a chip
    const saved = (await r.alice(`/conversations/${conversation}`)).json
    assert.equal(saved.messages.length, 2)
    assert.equal(saved.messages[0].content, `Why did the build fail? ✓\n[Screenshot id=${created.json.id}]`)
    assert.match(saved.messages[1].content, /failing build/)
    assert.equal(saved.title, 'Why did the build fail? ✓')
    assert.match(r.vision.calls[0].messages[1].content, /Why did the build fail\? ✓/, 'the question arrived intact')

    const asked = await r.alice(`/screenshots/${created.json.id}/ask`, { method: 'POST', body: { question: 'Which test?' } })
    assert.equal(asked.status, 200)
    assert.equal(asked.json.answer, 'It is the third test.')
    assert.equal((await r.alice(`/conversations/${conversation}`)).json.messages.length, 4)

    assert.equal((await r.alice(`/screenshots/${created.json.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await r.alice(`/screenshots/${created.json.id}`)).status, 404)
    assert.equal((await r.alice(`/conversations/${conversation}`)).status, 404, 'a conversation that held only the screenshot is gone')
    assert.equal((await r.alice(`/screenshots/${created.json.id}?conversation=${conversation}`, { method: 'DELETE' })).status, 204, 'deleting again is fine')
  })
})

test('a screenshot-only conversation is titled "Screenshot" in the history', async () => {
  await using({}, async (r) => {
    const conversation = await newConversation(r.alice)
    const created = await upload(r.alice, conversation)
    await settled(r.alice, created.json.id)
    const list = (await r.alice('/conversations')).json
    assert.equal(list.conversations[0].title, 'Screenshot')
  })
})

test('cancel and retry over HTTP', async () => {
  await using({}, async (r) => {
    const conversation = await newConversation(r.alice)
    let first = true
    r.vision.reply = ({ signal }) =>
      first
        ? new Promise((_, reject) => {
            first = false
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          })
        : Promise.resolve('after the retry')
    const created = await upload(r.alice, conversation)
    const cancelled = await r.alice(`/screenshots/${created.json.id}/cancel`, { method: 'POST' })
    assert.equal(cancelled.json.status, 'cancelled')
    assert.equal(cancelled.json.retryable, true)
    assert.equal((await r.alice(`/conversations/${conversation}`)).status, 404, 'nothing was written: there is no saved conversation')
    const retried = await r.alice(`/screenshots/${created.json.id}/retry`, { method: 'POST' })
    assert.equal(retried.json.status, 'analyzing')
    assert.equal((await settled(r.alice, created.json.id)).analysis, 'after the retry')
  })
})

test('what the page is told when something is wrong: each case has a stable code and a message fit to show', async () => {
  await using({ limits: { maxImageBytes: 2000, maxPixels: 1_000_000 } }, async (r) => {
    const conversation = await newConversation(r.alice)
    const code = async (promise, status, wanted) => {
      const res = await promise
      assert.equal(res.status, status, `${wanted}: ${res.text.slice(0, 120)}`)
      assert.equal(res.json.code, wanted)
      assert.ok(res.json.error, 'with words for a person')
      return res
    }
    await code(upload(r.alice, conversation, { bytes: Buffer.from('hello'), type: 'text/plain' }), 415, 'invalid-image')
    await code(upload(r.alice, conversation, { bytes: Buffer.from('not really a picture'), type: 'image/png' }), 400, 'invalid-image')
    await code(upload(r.alice, conversation, { bytes: Buffer.concat([png(), Buffer.alloc(5000)]) }), 413, 'image-too-large')
    await code(upload(r.alice, conversation, { bytes: png(5000, 5000) }), 413, 'image-too-large')
    await code(upload(r.alice, '11111111-1111-4111-8111-111111111111'), 404, 'conversation-not-found')
    await code(upload(r.alice, conversation, { question: 'x'.repeat(1001) }), 400, 'invalid-question')
    await code(r.alice('/screenshots/00000000-0000-4000-8000-000000000999'), 404, 'screenshot-not-found')
    await code(r.alice('/screenshots/not-an-id', { method: 'DELETE' }), 400, 'invalid-id')
    assert.equal(r.vision.calls.length, 0, 'no model was asked')
  })
  await using({ configured: false }, async (r) => {
    const conversation = await newConversation(r.alice)
    const res = await upload(r.alice, conversation)
    assert.equal(res.status, 503)
    assert.equal(res.json.code, 'vision-not-configured')
  })
})

test('a person with too many analyses running is told to wait, with Retry-After', async () => {
  await using({ limits: { maxActivePerOwner: 1 } }, async (r) => {
    const conversation = await newConversation(r.alice)
    r.vision.reply = () => new Promise(() => {})
    assert.equal((await upload(r.alice, conversation)).status, 202)
    const second = await upload(r.alice, conversation)
    assert.equal(second.status, 429)
    assert.equal(second.json.code, 'screenshot-busy')
    assert.ok(Number(second.headers.get('retry-after')) >= 1)
  })
})

test('screenshots are private over HTTP too, and need a signed-in person', async () => {
  await using({}, async (r) => {
    const conversation = await newConversation(r.alice)
    const created = await upload(r.alice, conversation)
    await settled(r.alice, created.json.id)
    const id = created.json.id
    assert.equal((await r.bob(`/screenshots/${id}`)).status, 404)
    assert.equal((await r.bob(`/screenshots/${id}/cancel`, { method: 'POST' })).status, 404)
    assert.equal((await r.bob(`/screenshots/${id}/retry`, { method: 'POST' })).status, 404)
    assert.equal((await r.bob(`/screenshots/${id}/ask`, { method: 'POST', body: { question: 'hi' } })).status, 404)
    assert.equal((await upload(r.bob, conversation)).status, 404, 'bob cannot attach to alice\'s conversation')
    assert.equal((await r.bob(`/screenshots/${id}?conversation=${conversation}`, { method: 'DELETE' })).status, 204, 'idempotent, but it removed nothing')
    assert.equal((await r.alice(`/conversations/${conversation}`)).json.messages.length, 2)
    assert.equal((await r.alice(`/screenshots/${id}`)).json.status, 'ready')

    for (const [method, path] of [['POST', `/screenshots?conversation=${conversation}`], ['GET', `/screenshots/${id}`], ['POST', `/screenshots/${id}/cancel`], ['POST', `/screenshots/${id}/retry`], ['POST', `/screenshots/${id}/ask`], ['DELETE', `/screenshots/${id}`]]) {
      assert.equal((await r.nobody(path, { method, body: method === 'POST' ? {} : undefined })).status, 401, `${method} ${path}`)
    }
  })
})

test('deleting a conversation, or every conversation, drops its screenshots\' pictures', async () => {
  await using({}, async (r) => {
    const one = await newConversation(r.alice)
    const two = await newConversation(r.alice)
    const a = await upload(r.alice, one)
    const b = await upload(r.alice, two)
    await settled(r.alice, a.json.id)
    await settled(r.alice, b.json.id)
    assert.equal(r.service._heldPictures(), 2)
    assert.equal((await r.alice(`/conversations/${one}`, { method: 'DELETE' })).status, 204)
    assert.equal(r.service._heldPictures(), 1)
    assert.equal((await r.alice('/conversations?confirm=all', { method: 'DELETE' })).status, 200)
    assert.equal(r.service._heldPictures(), 0)
  })
})

test('the page can name its own screenshot with X-Screenshot-Id; naming it twice is a 409 the page can recover from', async () => {
  await using({}, async (r) => {
    const conversation = await newConversation(r.alice)
    const id = '12345678-1234-4234-8234-123456789abc'
    const first = await r.alice(`/screenshots?conversation=${conversation}`, { method: 'POST', raw: png(), type: 'image/png', headers: { 'x-screenshot-id': id } })
    assert.equal(first.status, 202)
    assert.equal(first.json.id, id)
    const again = await r.alice(`/screenshots?conversation=${conversation}`, { method: 'POST', raw: png(), type: 'image/png', headers: { 'x-screenshot-id': id } })
    assert.equal(again.status, 409)
    assert.equal(again.json.code, 'duplicate-id')
    assert.equal((await settled(r.alice, id)).status, 'ready')
    const bad = await r.alice(`/screenshots?conversation=${conversation}`, { method: 'POST', raw: png(), type: 'image/png', headers: { 'x-screenshot-id': 'nope' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.code, 'invalid-id')
  })
})
