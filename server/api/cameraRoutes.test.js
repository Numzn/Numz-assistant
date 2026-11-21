import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { CameraApiError, createCameraApi } from '../../src/interfaces/camera/cameraApi.js'
import { createAssistantAuth } from '../auth/assistantAuth.js'
import { createCodeAccess } from '../auth/codeAccess.js'
import { createCameraService } from '../camera/cameraService.js'
import { errorHandler } from '../http/errorHandler.js'
import { createConversationRepository } from '../persistence/conversationRepository.js'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createCameraRouter } from '../routes/camera.js'
import { createSessionService } from '../sessions/sessionService.js'

/**
 * The Smart Camera's HTTP surface, with the real router, the real error handler, the real sign-in gate and the real
 * browser-side client talking to it over a real socket. Only the two models are scripted.
 */

const quiet = { error() {}, warn() {}, info() {}, log() {} }
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-pretend-picture')])
const READING = JSON.stringify({ isQuestion: true, text: 'What is the capital of France?', options: [], type: 'short-answer', subject: 'geography', hasDiagram: false, confidence: 0.9, reason: '' })
const ANSWER = JSON.stringify({ subject: 'geography', type: 'short-answer', answer: 'Paris', steps: ['It is Paris.'], explanation: 'Paris is the capital.', confidence: 'high', uncertainty: null })

async function serve({ accessCode = '', configured = true, limits = {}, reads = [READING], answers = [ANSWER], readImpl = null } = {}) {
  const store = createConversationRepository(createDatabase({ filename: ':memory:' }))
  const sessions = createSessionService({ store, logger: quiet })
  const script = { reads: [...reads], answers: [...answers] }
  const next = (queue) => (queue.length > 1 ? queue.shift() : queue[0])
  const seen = { images: [] }
  const service = createCameraService({
    vision: {
      configured,
      async read({ image, messages, signal }) {
        seen.images.push(image)
        return readImpl ? readImpl({ image, messages, signal }) : next(script.reads)
      }
    },
    answerEngine: async () => next(script.answers),
    sessions,
    logger: quiet,
    limits: { minReadIntervalMs: 0, ...limits }
  })
  const auth = createAssistantAuth({ accessCode, logger: quiet })
  const app = express()
  app.use(express.json({ limit: '256kb' })) // as in server.js: the camera's picture route must still receive its raw body
  app.use('/api/v1/assistant/auth', auth.router())
  app.use('/api/v1/assistant/camera', createCodeAccess(auth).requireSession(), createCameraRouter({ service }))
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const cookies = { value: '' }
  const fetchFn = (path, init = {}) => fetch(origin + path, { ...init, headers: { ...(init.headers ?? {}), ...(cookies.value ? { cookie: cookies.value } : {}) } })
  return {
    origin,
    store,
    seen,
    script,
    service,
    cookies,
    api: createCameraApi({ fetchFn }),
    fetchFn,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

async function using(options, body) {
  const rig = await serve(options)
  try {
    await body(rig)
  } finally {
    await rig.close()
  }
}

const base = '/api/v1/assistant/camera'
const post = (rig, path, init = {}) => rig.fetchFn(base + path, { method: 'POST', ...init })

test('the whole round trip through the real client: start, read, answer, clear', async () => {
  await using({}, async ({ api, store, seen }) => {
    const session = await api.createSession()
    assert.equal(session.visionConfigured, true)
    assert.ok(session.limits.maxReads > 0)

    const read = await api.read(session.sessionId, { bytes: JPEG, mimeType: 'image/jpeg' })
    assert.equal(read.status, 'new')
    assert.equal(read.question.text, 'What is the capital of France?')
    assert.deepEqual(Buffer.from(seen.images[0].bytes), JPEG, 'the model got the picture byte for byte')

    const answered = await api.answer(session.sessionId, { questionId: read.questionId })
    assert.equal(answered.status, 'answered')
    assert.equal(answered.answer.answer, 'Paris')
    assert.match(answered.markdown, /\*\*Answer:\*\* Paris/)
    assert.equal(store.list().total, 1)

    const again = await api.read(session.sessionId, { bytes: JPEG, mimeType: 'image/jpeg' })
    assert.equal(again.status, 'duplicate')
    assert.equal(again.answer.answer, 'Paris')

    assert.equal(await api.clear(session.sessionId), true)
    assert.equal(store.list().total, 0)
    assert.equal(await api.clear(session.sessionId), true, 'clearing twice is fine')
  })
})

test('a corrected question travels as JSON and is what gets answered', async () => {
  await using({}, async ({ api, store }) => {
    const { sessionId } = await api.createSession()
    const { questionId } = await api.read(sessionId, { bytes: JPEG, mimeType: 'image/jpeg' })
    await api.answer(sessionId, { questionId, text: 'What is the capital of Spain?' })
    assert.match(store.get(sessionId).messages[0].content, /Spain/)
  })
})

test('nothing from the camera is ever cached by the browser or a proxy', async () => {
  await using({}, async (rig) => {
    const res = await post(rig, '/sessions', { headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(res.status, 201)
    assert.match(res.headers.get('cache-control') ?? '', /no-store/)
  })
})

test('only pictures are taken as pictures: JSON, text and empty bodies are refused without reaching a model', async () => {
  await using({}, async (rig) => {
    const { sessionId } = await rig.api.createSession()
    for (const [type, body] of [['application/json', '{"a":1}'], ['text/plain', 'hello'], ['application/octet-stream', JPEG]]) {
      const res = await post(rig, `/sessions/${sessionId}/read`, { headers: { 'content-type': type }, body })
      assert.equal(res.status, 415, type)
      assert.equal((await res.json()).code, 'invalid-image')
    }
    const empty = await post(rig, `/sessions/${sessionId}/read`, { headers: { 'content-type': 'image/jpeg' }, body: Buffer.alloc(0) })
    assert.equal(empty.status, 400)
    assert.equal((await empty.json()).code, 'invalid-image')
    const notReally = await post(rig, `/sessions/${sessionId}/read`, { headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('<svg></svg>') })
    assert.equal(notReally.status, 400)
    assert.equal(rig.seen.images.length, 0)
  })
})

test('a picture over the limit is a 413 the page recognises, not an HTML error', async () => {
  await using({ limits: { maxImageBytes: 200 } }, async (rig) => {
    const { sessionId } = await rig.api.createSession()
    const res = await post(rig, `/sessions/${sessionId}/read`, { headers: { 'content-type': 'image/jpeg' }, body: Buffer.concat([JPEG, Buffer.alloc(500)]) })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).code, 'image-too-large')
    await assert.rejects(
      rig.api.read(sessionId, { bytes: Buffer.concat([JPEG, Buffer.alloc(500)]), mimeType: 'image/jpeg' }),
      (err) => err instanceof CameraApiError && err.code === 'image-too-large' && err.transient === false
    )
  })
})

test('too many pictures too fast: a 429 with Retry-After the client turns into a wait', async () => {
  await using({ limits: { minReadIntervalMs: 60_000 } }, async ({ api }) => {
    const { sessionId } = await api.createSession()
    await api.read(sessionId, { bytes: JPEG, mimeType: 'image/jpeg' })
    await assert.rejects(
      api.read(sessionId, { bytes: JPEG, mimeType: 'image/jpeg' }),
      (err) => err instanceof CameraApiError && err.status === 429 && err.code === 'camera-rate-limited' && err.retryAfterMs >= 1000 && err.transient === true
    )
  })
})

test('with no vision service the page is told, permanently, so it does not keep trying', async () => {
  await using({ configured: false }, async ({ api }) => {
    const session = await api.createSession()
    assert.equal(session.visionConfigured, false)
    await assert.rejects(
      api.read(session.sessionId, { bytes: JPEG, mimeType: 'image/jpeg' }),
      (err) => err.status === 503 && err.code === 'vision-not-configured' && err.transient === false
    )
  })
})

test('an unknown session is a 404 the page answers by starting a new one', async () => {
  await using({}, async ({ api }) => {
    await assert.rejects(api.read('00000000-0000-4000-8000-000000000000', { bytes: JPEG, mimeType: 'image/jpeg' }), (err) => err.status === 404 && err.code === 'session-not-found')
    await assert.rejects(api.answer('00000000-0000-4000-8000-000000000000', { questionId: 'x' }), (err) => err.status === 404 && err.code === 'session-not-found')
  })
})

test('bad answer requests are refused plainly', async () => {
  await using({}, async ({ api }) => {
    const { sessionId } = await api.createSession()
    const { questionId } = await api.read(sessionId, { bytes: JPEG, mimeType: 'image/jpeg' })
    await assert.rejects(api.answer(sessionId, { questionId, text: '   ' }), (err) => err.status === 400 && err.code === 'invalid-question')
    await assert.rejects(api.answer(sessionId, { questionId: 'nope' }), (err) => err.status === 404 && err.code === 'question-not-found')
    await assert.rejects(api.answer(sessionId, {}), (err) => err.status === 404 && err.code === 'question-not-found')
  })
})

test('a model that fails is a 502 with a message fit to show, and the same picture can be tried again', async () => {
  let calls = 0
  const readImpl = async () => {
    if (++calls === 1) throw new Error('upstream said: secret key sk-123')
    return READING
  }
  await using({ readImpl }, async ({ api }) => {
    const { sessionId } = await api.createSession()
    await assert.rejects(
      api.read(sessionId, { bytes: JPEG, mimeType: 'image/jpeg' }),
      (err) => err.status === 502 && err.code === 'read-failed' && err.transient === true && !/secret|sk-123|upstream/i.test(err.message)
    )
    assert.equal((await api.read(sessionId, { bytes: JPEG, mimeType: 'image/jpeg' })).status, 'new')
  })
})

test('signed out, nothing works; signed in with the access code, everything does', async () => {
  await using({ accessCode: 'a-long-enough-access-code' }, async (rig) => {
    const denied = await post(rig, '/sessions', { headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(denied.status, 401)
    assert.equal((await denied.json()).code, 'assistant-auth-required')
    await assert.rejects(rig.api.createSession(), (err) => err.code === 'assistant-auth-required' && err.transient === false)
    const deniedClear = await rig.fetchFn(`${base}/sessions/00000000-0000-4000-8000-000000000000`, { method: 'DELETE' })
    assert.equal(deniedClear.status, 401, 'even clearing needs the sign-in')

    const login = await rig.fetchFn('/api/v1/assistant/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'a-long-enough-access-code' }) })
    assert.equal(login.status, 200)
    rig.cookies.value = login.headers.get('set-cookie').split(';')[0]
    const session = await rig.api.createSession()
    assert.ok(session.sessionId)
  })
})
