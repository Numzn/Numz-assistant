import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationRepository } from '../persistence/conversationRepository.js'
import { createIdentityRepository } from '../persistence/identityRepository.js'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createSessionService } from '../sessions/sessionService.js'
import { imageInfo } from './imageInfo.js'
import { createScreenshotService, ScreenshotError, screenshotMarker } from './screenshotService.js'

const quiet = { error() {}, warn() {}, info() {}, log() {} }

// Pictures that have a real header and nothing else: all the server looks at is what the bytes say they are.
function png(width = 1280, height = 720) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}
function jpeg(width = 1280, height = 720) {
  const b = Buffer.alloc(30)
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]).copy(b, 0) // SOI, APP0 (a length of 4 covers the 2 bytes after it)
  b.writeUInt8(0xff, 8)
  b.writeUInt8(0xc0, 9) // SOF0
  b.writeUInt16BE(11, 10)
  b.writeUInt8(8, 12)
  b.writeUInt16BE(height, 13)
  b.writeUInt16BE(width, 15)
  return b
}

function fakeVision({ configured = true } = {}) {
  const calls = []
  const state = { read: async () => '**What this shows**\nA terminal with an error.', answer: async () => 'Line 3 is the failing import.' }
  return {
    configured,
    name: 'fake',
    calls,
    state,
    read: async (args) => {
      calls.push({ kind: 'read', ...args })
      return state.read(args)
    },
    answer: async (args) => {
      calls.push({ kind: 'answer', ...args })
      return state.answer(args)
    }
  }
}

function rig({ vision = fakeVision(), limits = {}, clock = { t: 1_000_000 } } = {}) {
  const database = createDatabase({ filename: ':memory:' })
  const store = createConversationRepository(database)
  const sessions = createSessionService({ store, logger: quiet })
  const people = createIdentityRepository(database)
  const person = (name) => {
    const user = people.upsertUser({ externalId: `${name.charCodeAt(0).toString(16).padStart(2, '0')}0000000000`.slice(0, 12), email: `${name}@example.com`, name, role: 'viewer' })
    return { owner: user.id, identity: { ownerKey: user.id }, id: user.id }
  }
  const alice = person('alice')
  const bob = person('bob')
  let n = 0
  const service = createScreenshotService({ vision, sessions, logger: quiet, now: () => clock.t, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, limits })
  const conversation = (who) => sessions.forOwner(who.owner).createSession({}).id
  const messagesOf = (who, id) => store.forOwner(who.owner).get(id)?.messages ?? []
  const settle = async (id, ctx) => {
    for (let i = 0; i < 400; i++) {
      const view = service.get(id, ctx)
      if (view.status !== 'analyzing') return view
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('analysis never settled')
  }
  return { database, store, sessions, service, vision, alice, bob, conversation, messagesOf, settle, clock }
}

const ctxOf = (who, extra = {}) => ({ owner: who.owner, identity: who.identity, requestId: 'r1', ...extra })

test('imageInfo reads the kind and size from the bytes themselves, and refuses what is not a picture', () => {
  assert.deepEqual(imageInfo(png(1920, 1080)), { mimeType: 'image/png', width: 1920, height: 1080 })
  assert.deepEqual(imageInfo(jpeg(2560, 1440)), { mimeType: 'image/jpeg', width: 2560, height: 1440 })
  assert.equal(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(imageInfo(Buffer.alloc(0)), null)
  assert.equal(imageInfo(png(0, 10)), null, 'a size of zero is not a picture')
  assert.equal(imageInfo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])), null, 'a truncated header is refused')
  assert.equal(imageInfo(null), null)
})

test('a screenshot is analysed in the background and the analysis becomes part of the conversation, marked with its id', async () => {
  const t = rig()
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  const started = await t.service.attach(conversationId, { bytes: png() }, { question: 'Why does this fail?' }, ctx)
  assert.equal(started.status, 'analyzing', 'the answer comes straight back; the model is still working')
  assert.equal(started.pictureKept, true)
  const done = await t.settle(started.id, ctx)
  assert.equal(done.status, 'ready')
  assert.match(done.analysis, /terminal with an error/)
  const saved = t.messagesOf(t.alice, conversationId)
  assert.equal(saved.length, 2)
  assert.equal(saved[0].role, 'user')
  assert.equal(saved[0].content, `Why does this fail?\n${screenshotMarker(started.id)}`)
  assert.equal(saved[1].role, 'assistant')
  assert.equal(saved[1].content, done.analysis)
  // the picture went to the vision model with the question fenced, and the system prompt treats the picture's text as data
  const call = t.vision.calls[0]
  assert.equal(call.image.mimeType, 'image/png')
  assert.match(call.messages[1].content, /<question>\nWhy does this fail\?\n<\/question>/)
  assert.match(call.messages[0].content, /never an instruction/)
})

test('what is refused before any model is asked: not a picture, empty, huge, tiny, not configured, no such conversation', async () => {
  const t = rig({ limits: { maxImageBytes: 2000, maxPixels: 1_000_000 } })
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  const refuse = async (picture, code, status, id = conversationId, question) => {
    await assert.rejects(t.service.attach(id, picture, { question }, ctx), (err) => err instanceof ScreenshotError && err.code === code && err.statusCode === status, code)
  }
  await refuse({ bytes: Buffer.alloc(0) }, 'invalid-image', 400)
  await refuse({ bytes: Buffer.from('not a picture at all') }, 'invalid-image', 400)
  await refuse({ bytes: Buffer.concat([png(), Buffer.alloc(3000)]) }, 'image-too-large', 413)
  await refuse({ bytes: png(4000, 4000) }, 'image-too-large', 413)
  await refuse({ bytes: png(4, 4) }, 'invalid-image', 400)
  await refuse({ bytes: png() }, 'invalid-question', 400, conversationId, 'x'.repeat(1001))
  await refuse({ bytes: png() }, 'conversation-not-found', 404, '11111111-1111-4111-8111-111111111111')
  await refuse({ bytes: png() }, 'conversation-not-found', 404, 'not-a-uuid')
  assert.equal(t.vision.calls.length, 0, 'no model was asked for any of them')
  assert.equal(t.service._heldPictures(), 0, 'and nothing was kept')

  const off = rig({ vision: fakeVision({ configured: false }) })
  await assert.rejects(off.service.attach(off.conversation(off.alice), { bytes: png() }, {}, ctxOf(off.alice)), (err) => err.code === 'vision-not-configured' && err.statusCode === 503)
})

test('cancel stops the analysis at once, tells the model to stop, and writes nothing to the conversation; retry then works', async () => {
  const t = rig()
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  let release
  let aborted = false
  t.vision.state.read = ({ signal }) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => (aborted = true))
      release = () => resolve('too late to matter')
    })
  const shot = await t.service.attach(conversationId, { bytes: png() }, {}, ctx)
  const cancelled = t.service.cancel(shot.id, ctx)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.retryable, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(aborted, true, 'the request to the vision service was aborted')
  release?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(t.service.get(shot.id, ctx).status, 'cancelled')
  assert.equal(t.messagesOf(t.alice, conversationId).length, 0, 'nothing was saved')

  t.vision.state.read = async () => 'second time lucky'
  assert.equal(t.service.retry(shot.id, ctx).status, 'analyzing')
  const done = await t.settle(shot.id, ctx)
  assert.equal(done.status, 'ready')
  assert.equal(done.analysis, 'second time lucky')
  assert.equal(t.messagesOf(t.alice, conversationId).length, 2)
})

test('failures are told plainly, retryable ones can be retried, and nothing is saved until it works', async () => {
  const t = rig()
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  const statusError = (statusCode) => Object.assign(new Error('x'), { statusCode, name: 'VisionError' })
  const cases = [
    [statusError(503), 'vision-unavailable', true],
    [statusError(429), 'vision-busy', true],
    [statusError(401), 'vision-refused', false],
    [statusError(400), 'vision-rejected', false],
    [Object.assign(new Error('offline'), { name: 'VisionError' }), 'vision-unreachable', true]
  ]
  for (const [err, code, retryable] of cases) {
    t.vision.state.read = async () => {
      throw err
    }
    const shot = await t.service.attach(conversationId, { bytes: png() }, {}, ctx)
    const view = await t.settle(shot.id, ctx)
    assert.equal(view.status, 'failed', code)
    assert.equal(view.error.code, code)
    assert.equal(view.retryable, retryable, `${code} retryable`)
    assert.doesNotMatch(JSON.stringify(view), /x"|offline/, 'the provider\'s own words never reach the page')
    t.service.remove(shot.id, {}, ctx)
  }
  assert.equal(t.messagesOf(t.alice, conversationId).length, 0)

  t.vision.state.read = async () => '   '
  const empty = await t.service.attach(conversationId, { bytes: png() }, {}, ctx)
  assert.equal((await t.settle(empty.id, ctx)).error.code, 'empty-analysis')

  // a slow model is given up on, with its own message, and can be retried
  const slow = rig({ limits: { modelTimeoutMs: 20 } })
  slow.vision.state.read = () => new Promise(() => {})
  const slowId = slow.conversation(slow.alice)
  const waiting = await slow.service.attach(slowId, { bytes: png() }, {}, ctxOf(slow.alice))
  const timedOut = await slow.settle(waiting.id, ctxOf(slow.alice))
  assert.equal(timedOut.error.code, 'timeout')
  assert.equal(timedOut.retryable, true)
})

test('a failed analysis is retried on the picture still held; after the attempts allowed, or once the picture is dropped, it must be captured again', async () => {
  const t = rig({ limits: { maxAttempts: 2 } })
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  t.vision.state.read = async () => {
    throw Object.assign(new Error('x'), { statusCode: 503 })
  }
  const shot = await t.service.attach(conversationId, { bytes: png() }, {}, ctx)
  await t.settle(shot.id, ctx)
  t.service.retry(shot.id, ctx)
  const second = await t.settle(shot.id, ctx)
  assert.equal(second.status, 'failed')
  assert.equal(second.retryable, false, 'two attempts is the limit here')
  assert.throws(() => t.service.retry(shot.id, ctx), (err) => err.code === 'too-many-attempts' && err.statusCode === 429)

  const dropped = rig()
  const dctx = ctxOf(dropped.alice)
  const id = dropped.conversation(dropped.alice)
  dropped.vision.state.read = async () => {
    throw Object.assign(new Error('x'), { statusCode: 503 })
  }
  const s = await dropped.service.attach(id, { bytes: png() }, {}, dctx)
  await dropped.settle(s.id, dctx)
  dropped.clock.t += 11 * 60_000
  assert.equal(dropped.service.get(s.id, dctx).pictureKept, false)
  assert.throws(() => dropped.service.retry(s.id, dctx), (err) => err.code === 'picture-expired' && err.statusCode === 410)
})

test('the picture is held in memory only, for a few minutes; its analysis stays in the conversation; a follow-up needs the picture', async () => {
  const t = rig()
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  const shot = await t.service.attach(conversationId, { bytes: png() }, {}, ctx)
  const done = await t.settle(shot.id, ctx)
  assert.equal(done.pictureKept, true)
  assert.equal(t.service._heldPictures(), 1)
  // nothing but text reached the database
  const rows = t.database.prepare('SELECT content FROM assistant_messages').all()
  assert.ok(rows.every((row) => typeof row.content === 'string' && !row.content.includes('PNG')))

  t.clock.t += 9 * 60_000
  assert.equal(t.service.get(shot.id, ctx).pictureKept, true)
  t.clock.t += 2 * 60_000
  const later = t.service.get(shot.id, ctx)
  assert.equal(later.pictureKept, false)
  assert.equal(t.service._heldPictures(), 0)
  assert.equal(later.status, 'ready')
  assert.equal(t.messagesOf(t.alice, conversationId).length, 2, 'what was said about it is still in the conversation')
  await assert.rejects(t.service.ask(shot.id, { question: 'what is on line 3?' }, ctx), (err) => err.code === 'picture-expired' && err.statusCode === 410 && /ask in the chat/.test(err.message))
})

test('a follow-up looks at the picture again, is saved with the screenshot, and is limited', async () => {
  const t = rig({ limits: { maxAsks: 2 } })
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  const shot = await t.service.attach(conversationId, { bytes: png() }, {}, ctx)
  await t.settle(shot.id, ctx)
  const reply = await t.service.ask(shot.id, { question: 'What is on line 3?' }, ctx)
  assert.equal(reply.answer, 'Line 3 is the failing import.')
  assert.equal(reply.asks, 1)
  const answerCall = t.vision.calls.find((c) => c.kind === 'answer')
  assert.equal(answerCall.image.mimeType, 'image/png')
  assert.match(answerCall.messages[1].content, /earlier analysis[\s\S]*terminal with an error/i)
  const saved = t.messagesOf(t.alice, conversationId)
  assert.equal(saved.length, 4)
  assert.equal(saved[2].content, `What is on line 3?\n${screenshotMarker(shot.id, true)}`)
  assert.equal(saved[3].content, 'Line 3 is the failing import.')

  await assert.rejects(t.service.ask(shot.id, { question: '   ' }, ctx), (err) => err.code === 'invalid-question')
  await t.service.ask(shot.id, { question: 'And line 4?' }, ctx)
  await assert.rejects(t.service.ask(shot.id, { question: 'one more' }, ctx), (err) => err.code === 'too-many-questions' && err.statusCode === 429)

  // a failed follow-up says why and saves nothing
  const failing = rig()
  const fctx = ctxOf(failing.alice)
  const fid = failing.conversation(failing.alice)
  const fshot = await failing.service.attach(fid, { bytes: png() }, {}, fctx)
  await failing.settle(fshot.id, fctx)
  failing.vision.state.answer = async () => {
    throw Object.assign(new Error('x'), { statusCode: 503 })
  }
  await assert.rejects(failing.service.ask(fshot.id, { question: 'why?' }, fctx), (err) => err.code === 'vision-unavailable' && err.statusCode === 502)
  assert.equal(failing.messagesOf(failing.alice, fid).length, 2)
})

test('deleting a screenshot removes the picture and exactly its messages, follow-ups included, and nothing else', async () => {
  const t = rig()
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  const view = t.sessions.forOwner(t.alice.owner)
  view.appendMessage(conversationId, { role: 'user', content: 'Earlier, a normal question' })
  view.appendMessage(conversationId, { role: 'assistant', content: 'A normal answer' })
  const shot = await t.service.attach(conversationId, { bytes: png() }, { question: 'Explain' }, ctx)
  await t.settle(shot.id, ctx)
  await t.service.ask(shot.id, { question: 'More?' }, ctx)
  view.appendMessage(conversationId, { role: 'user', content: 'Later, another normal question' })
  view.appendMessage(conversationId, { role: 'assistant', content: 'Another normal answer' })
  assert.equal(t.messagesOf(t.alice, conversationId).length, 8)

  const result = t.service.remove(shot.id, {}, ctx)
  assert.equal(result.removed, 4)
  assert.deepEqual(t.messagesOf(t.alice, conversationId).map((m) => m.content), ['Earlier, a normal question', 'A normal answer', 'Later, another normal question', 'Another normal answer'])
  assert.deepEqual(view.getSession(conversationId).messages.map((m) => m.content), ['Earlier, a normal question', 'A normal answer', 'Later, another normal question', 'Another normal answer'], 'and in memory')
  assert.equal(t.service._heldPictures(), 0)
  assert.throws(() => t.service.get(shot.id, ctx), (err) => err.statusCode === 404)
  assert.equal(t.service.remove(shot.id, { conversationId }, ctx).removed, 0, 'deleting again is fine')
})

test('a screenshot the server no longer knows (it restarted) is still deleted from the conversation, by its marker', async () => {
  const t = rig()
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  const shot = await t.service.attach(conversationId, { bytes: png() }, {}, ctx)
  await t.settle(shot.id, ctx)
  // a fresh service over the same store: the in-memory record is gone, the saved messages are not
  const sessions = createSessionService({ store: t.store, logger: quiet })
  const restarted = createScreenshotService({ vision: t.vision, sessions, logger: quiet })
  assert.throws(() => restarted.get(shot.id, ctx), (err) => err.statusCode === 404)
  assert.equal(restarted.remove(shot.id, { conversationId }, ctx).removed, 2)
  assert.equal(t.store.forOwner(t.alice.owner).get(conversationId), null, 'a conversation left empty is not kept')
})

test('a screenshot is private: another person cannot see, cancel, ask about or delete it, nor delete its messages', async () => {
  const t = rig()
  const actx = ctxOf(t.alice)
  const bctx = ctxOf(t.bob)
  const conversationId = t.conversation(t.alice)
  const shot = await t.service.attach(conversationId, { bytes: png() }, {}, actx)
  await t.settle(shot.id, actx)
  for (const call of [() => t.service.get(shot.id, bctx), () => t.service.cancel(shot.id, bctx), () => t.service.retry(shot.id, bctx)]) {
    assert.throws(call, (err) => err.code === 'screenshot-not-found' && err.statusCode === 404)
  }
  await assert.rejects(t.service.ask(shot.id, { question: 'hi' }, bctx), (err) => err.code === 'screenshot-not-found')
  await assert.rejects(t.service.attach(conversationId, { bytes: png() }, {}, bctx), (err) => err.code === 'conversation-not-found', 'nor attach to it')
  assert.equal(t.service.remove(shot.id, { conversationId }, bctx).removed, 0)
  assert.equal(t.messagesOf(t.alice, conversationId).length, 2, 'alice\'s conversation is untouched')
  assert.equal(t.service.get(shot.id, actx).status, 'ready')
})

test('a person has a few analyses at a time; their usage limits are checked before the picture goes anywhere', async () => {
  const t = rig({ limits: { maxActivePerOwner: 2 } })
  const ctx = ctxOf(t.alice)
  const conversationId = t.conversation(t.alice)
  t.vision.state.read = () => new Promise(() => {})
  await t.service.attach(conversationId, { bytes: png() }, {}, ctx)
  await t.service.attach(conversationId, { bytes: jpeg() }, {}, ctx)
  await assert.rejects(t.service.attach(conversationId, { bytes: png() }, {}, ctx), (err) => err.code === 'screenshot-busy' && err.statusCode === 429 && err.retryAfterSeconds >= 1)
  // bob is not held up by alice
  await t.service.attach(t.conversation(t.bob), { bytes: png() }, {}, ctxOf(t.bob))

  const limited = rig()
  const lctx = ctxOf(limited.alice, { meter: { begin() { throw Object.assign(new Error('Daily allowance reached'), { name: 'AiLimitError', statusCode: 429, code: 'daily-limit' }) } } })
  await assert.rejects(limited.service.attach(limited.conversation(limited.alice), { bytes: png() }, {}, lctx), (err) => err.name === 'AiLimitError')
  assert.equal(limited.vision.calls.length, 0)
  assert.equal(limited.service._heldPictures(), 0, 'a refused screenshot is not kept')
})

test('each model call is counted against the person: a read for the analysis, an answer for a follow-up', async () => {
  const kinds = []
  const meter = { begin: (_identity, kind) => ({ usage() {}, finish: () => kinds.push(`${kind}:ok`), fail: () => kinds.push(`${kind}:failed`) }) }
  const t = rig()
  const ctx = ctxOf(t.alice, { meter })
  const shot = await t.service.attach(t.conversation(t.alice), { bytes: png() }, {}, ctx)
  await t.settle(shot.id, ctx)
  await t.service.ask(shot.id, { question: 'why?' }, ctx)
  assert.deepEqual(kinds, ['vision_read:ok', 'vision_answer:ok'])
})

test('the page may choose the screenshot\'s id: the same id twice is "already here", ids are per person, and a bad one is refused', async () => {
  const t = rig()
  const actx = ctxOf(t.alice)
  const bctx = ctxOf(t.bob)
  const wanted = '99999999-9999-4999-8999-999999999999'
  const conversationId = t.conversation(t.alice)
  const first = await t.service.attach(conversationId, { bytes: png() }, { id: wanted }, actx)
  assert.equal(first.id, wanted)
  await assert.rejects(t.service.attach(conversationId, { bytes: png() }, { id: wanted }, actx), (err) => err.code === 'duplicate-id' && err.statusCode === 409)
  assert.equal(t.vision.calls.length, 1, 'the second try did not send anything to the model')
  // another person may use the same id for their own screenshot, and can neither see nor disturb alice's
  const bobsConversation = t.conversation(t.bob)
  assert.equal((await t.service.attach(bobsConversation, { bytes: png() }, { id: wanted }, bctx)).id, wanted)
  assert.equal(t.service.get(wanted, actx).conversationId, conversationId)
  assert.equal(t.service.get(wanted, bctx).conversationId, bobsConversation)
  await assert.rejects(t.service.attach(conversationId, { bytes: png() }, { id: 'not-a-uuid' }, actx), (err) => err.code === 'invalid-id' && err.statusCode === 400)
  // a screenshot cancelled by the id the page chose, before its answer was ever seen, leaves nothing behind
  await t.settle(wanted, actx)
  t.service.remove(wanted, { conversationId }, actx)
  assert.equal(t.messagesOf(t.alice, conversationId).length, 0)
})
