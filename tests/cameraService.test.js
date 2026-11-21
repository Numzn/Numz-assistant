import assert from 'node:assert/strict'
import test from 'node:test'
import { CameraError } from '../server/camera/cameraError.js'
import { createCameraService } from '../server/camera/cameraService.js'
import { createConversationRepository } from '../server/persistence/conversationRepository.js'
import { createDatabase } from '../server/persistence/sqliteDatabase.js'
import { createSessionService } from '../server/sessions/sessionService.js'

/**
 * The server side of the Smart Camera with a scripted vision model and a scripted answering model, a real saved-
 * conversation store, and a clock the test moves. What is under test is the policy: what is refused, what is read,
 * what counts as the same question, what the models are asked, what is kept and for how long, and what is logged.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])

const reading = (extra = {}) =>
  JSON.stringify({ isQuestion: true, text: 'What is the capital of France?', options: [], type: 'short-answer', subject: 'geography', hasDiagram: false, confidence: 0.95, reason: '', ...extra })
const answerJson = (extra = {}) =>
  JSON.stringify({ subject: 'geography', type: 'short-answer', answer: 'Paris', steps: ['France\'s capital is Paris.'], explanation: 'Paris has been the capital for centuries.', confidence: 'high', uncertainty: null, ...extra })

function rig({ configured = true, limits = {}, vision: visionOverrides = {} } = {}) {
  const clock = { now: 1_000_000 }
  const logged = []
  const logger = { info: (...a) => logged.push(a.join(' ')), warn: (...a) => logged.push(a.join(' ')), error: (...a) => logged.push(a.join(' ')), log: (...a) => logged.push(a.join(' ')) }
  const store = createConversationRepository(createDatabase({ filename: ':memory:' }))
  const sessions = createSessionService({ store, logger: { error() {}, warn() {}, info() {}, log() {} } })
  const script = { reads: [reading()], answers: [answerJson()], visionAnswers: [answerJson()] }
  const pick = (queue) => {
    const entry = queue.length > 1 ? queue.shift() : queue[0]
    const value = typeof entry === 'function' ? entry() : entry
    if (value instanceof Error) throw value
    return value
  }
  const vision = {
    configured,
    readCalls: [],
    answerCalls: [],
    async read(call) {
      vision.readCalls.push(call)
      return pick(script.reads)
    },
    async answer(call) {
      vision.answerCalls.push(call)
      return pick(script.visionAnswers)
    },
    ...visionOverrides
  }
  const engineCalls = []
  const answerEngine = async (messages) => {
    engineCalls.push(messages)
    return pick(script.answers)
  }
  let n = 0
  const service = createCameraService({
    vision,
    answerEngine,
    sessions,
    now: () => clock.now,
    logger,
    newId: () => `q-${++n}`,
    limits: { minReadIntervalMs: 0, ...limits }
  })
  return { service, vision, engineCalls, script, clock, logged, store, sessions }
}

const image = (bytes = JPEG) => ({ bytes, mimeType: 'image/jpeg' })
const rejects = (promise, expected) => assert.rejects(promise, (err) => err instanceof CameraError && Object.entries(expected).every(([k, v]) => err[k] === v), JSON.stringify(expected))

// ---- sessions --------------------------------------------------------------------------------------------------

test('a session says whether pictures can be read and what its limits are', async () => {
  const { service } = rig({ limits: { maxReads: 7, maxImageBytes: 1234 } })
  const created = await service.createSession()
  assert.match(created.sessionId, /^[0-9a-f-]{36}$/i)
  assert.deepEqual(created.limits, { maxReads: 7, maxImageBytes: 1234 })
  assert.equal(created.visionConfigured, true)
  assert.equal((await rig({ configured: false }).service.createSession()).visionConfigured, false)
})

test('an unknown session is refused with a code the page can act on', async () => {
  const { service } = rig()
  await rejects(service.read('00000000-0000-4000-8000-000000000000', image()), { statusCode: 404, code: 'session-not-found' })
  await rejects(service.answer('00000000-0000-4000-8000-000000000000', { questionId: 'q' }), { statusCode: 404, code: 'session-not-found' })
})

test('a session nobody has used for half an hour is forgotten', async () => {
  const { service, clock } = rig()
  const { sessionId } = await service.createSession()
  clock.now += 31 * 60_000
  await rejects(service.read(sessionId, image()), { code: 'session-not-found' })
})

test('only so many sessions are kept: the idlest is dropped when there are too many', async () => {
  const { service, clock } = rig({ limits: { maxActiveSessions: 2 } })
  const first = await service.createSession()
  clock.now += 1000
  const second = await service.createSession()
  clock.now += 1000
  await service.createSession()
  await rejects(service.read(first.sessionId, image()), { code: 'session-not-found' })
  assert.equal((await service.read(second.sessionId, image())).status, 'new')
})

// ---- what is accepted as a picture ---------------------------------------------------------------------------------

test('only JPEG, PNG and WebP pictures are accepted, judged by their bytes, not their label', async () => {
  const { service, vision } = rig()
  const { sessionId } = await service.createSession()
  for (const bytes of [JPEG, PNG, WEBP]) {
    const fresh = await service.createSession() // the same question again in one session would be a duplicate
    const result = await service.read(fresh.sessionId, { bytes, mimeType: 'image/png' })
    assert.equal(result.status, 'new', bytes.subarray(0, 4).toString('hex'))
  }
  assert.deepEqual(vision.readCalls.map((c) => c.image.mimeType), ['image/jpeg', 'image/png', 'image/webp'], 'the type comes from the bytes, not the label')
  vision.readCalls.length = 0
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('GIF89a'), Buffer.from('%PDF-1.4'), Buffer.from('hello'), Buffer.alloc(0), 'not a buffer', null]) {
    await rejects(service.read(sessionId, { bytes, mimeType: 'image/jpeg' }), { statusCode: 400, code: 'invalid-image' })
  }
  assert.equal(vision.readCalls.length, 0, 'nothing that is not a picture reaches the model')
})

test('a picture over the size limit is refused before it costs anything', async () => {
  const { service, vision } = rig({ limits: { maxImageBytes: 100 } })
  const { sessionId } = await service.createSession()
  await rejects(service.read(sessionId, image(Buffer.concat([JPEG, Buffer.alloc(200)]))), { statusCode: 413, code: 'image-too-large' })
  assert.equal(vision.readCalls.length, 0)
})

test('without a vision service nothing is read, and the refusal is permanent and clear', async () => {
  const { service } = rig({ configured: false })
  const { sessionId } = await service.createSession()
  await rejects(service.read(sessionId, image()), { statusCode: 503, code: 'vision-not-configured' })
})

// ---- reading -------------------------------------------------------------------------------------------------------

test('a picture of a question is read: its text, options, type and subject come back, and the picture does not', async () => {
  const { service, vision, script } = rig()
  script.reads = [reading({ text: 'Which is the largest planet?', options: [{ label: 'A', text: 'Mars' }, { label: 'B', text: 'Jupiter' }], type: 'multiple-choice', subject: 'astronomy' })]
  const { sessionId } = await service.createSession()
  const result = await service.read(sessionId, image())
  assert.deepEqual(result, {
    status: 'new',
    questionId: 'q-1',
    question: {
      text: 'Which is the largest planet?',
      options: [{ label: 'A', text: 'Mars' }, { label: 'B', text: 'Jupiter' }],
      type: 'multiple-choice',
      subject: 'astronomy',
      confidence: 0.95,
      hasDiagram: false
    }
  })
  const [call] = vision.readCalls
  assert.equal(call.image.bytes, JPEG.length ? call.image.bytes : null)
  assert.equal(call.messages[0].role, 'system')
  assert.match(call.messages[0].content, /exactly as it appears/)
  assert.ok(JSON.stringify(result).length < 600, 'nothing like the picture is sent back')
})

test('not a question, or too unclear, is said so and nothing is stored or answered', async () => {
  const { service, script, engineCalls } = rig()
  const { sessionId } = await service.createSession()
  script.reads = [reading({ isQuestion: false, reason: 'It is a menu.' })]
  assert.deepEqual(await service.read(sessionId, image()), { status: 'not-a-question', reason: 'It is a menu.' })
  script.reads = [reading({ text: 'What is', confidence: 0.9 })]
  assert.equal((await service.read(sessionId, image())).status, 'unclear')
  script.reads = [reading({ confidence: 0.2 })]
  assert.equal((await service.read(sessionId, image())).status, 'unclear')
  script.reads = ['I am sorry, I cannot read this picture.']
  assert.equal((await service.read(sessionId, image())).status, 'unclear', 'a reply that is not JSON')
  assert.equal(engineCalls.length, 0)
})

test('a vision model that fails is a 502 the page can retry, with nothing about the cause leaked', async () => {
  const { service, script } = rig()
  const { sessionId } = await service.createSession()
  script.reads = [Object.assign(new Error('401 invalid api key sk-secret-123'), { statusCode: 401 })]
  await assert.rejects(
    service.read(sessionId, image()),
    (err) => err instanceof CameraError && err.statusCode === 502 && err.code === 'read-failed' && !/secret|401|api key/i.test(err.message)
  )
})

// ---- the same question twice -------------------------------------------------------------------------------------

test('the same question read again is a duplicate, with the answer it already has, and no model is asked again', async () => {
  const { service, engineCalls, vision, script } = rig()
  const { sessionId } = await service.createSession()
  const first = await service.read(sessionId, image())
  await service.answer(sessionId, { questionId: first.questionId })
  script.reads = [reading({ text: 'Question 1. What is the capital of Frence?' })] // another crop, a misread letter
  const second = await service.read(sessionId, image())
  assert.equal(second.status, 'duplicate')
  assert.equal(second.questionId, first.questionId)
  assert.equal(second.answer.answer, 'Paris')
  assert.equal(engineCalls.length, 1, 'the answer was worked out once')
  assert.equal(vision.readCalls.length, 2, 'the picture was read each time: only the answer is saved')
})

test('a duplicate of a question not yet answered says so, without an answer', async () => {
  const { service } = rig()
  const { sessionId } = await service.createSession()
  const first = await service.read(sessionId, image())
  const second = await service.read(sessionId, image())
  assert.deepEqual([second.status, second.questionId, second.answer], ['duplicate', first.questionId, null])
})

test('a different question, or the same one with different numbers, is new', async () => {
  const { service, script } = rig()
  const { sessionId } = await service.createSession()
  script.reads = [reading({ text: 'A car travels 150 km in 2.5 hours. What is its average speed?' }), reading({ text: 'A car travels 160 km in 2.5 hours. What is its average speed?' }), reading({ text: 'Define entropy.' })]
  const ids = []
  for (let i = 0; i < 3; i++) ids.push((await service.read(sessionId, image())).questionId)
  assert.equal(new Set(ids).size, 3)
})

test('questions are remembered per session: another session starts fresh', async () => {
  const { service } = rig()
  const a = await service.createSession()
  const b = await service.createSession()
  assert.equal((await service.read(a.sessionId, image())).status, 'new')
  assert.equal((await service.read(b.sessionId, image())).status, 'new')
})

// ---- answering -----------------------------------------------------------------------------------------------------

test('the answering model gets the question inside markers with its own prompt, and the answer is structured and kept', async () => {
  const { service, engineCalls, script } = rig()
  script.reads = [reading({ text: 'Which is the largest planet?', options: [{ label: 'A', text: 'Mars' }, { label: 'B', text: 'Jupiter' }], type: 'multiple-choice', subject: 'astronomy' })]
  script.answers = [answerJson({ answer: 'B) Jupiter', steps: ['Jupiter is the largest planet.'], confidence: 'high' })]
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  const result = await service.answer(sessionId, { questionId })

  assert.equal(result.status, 'answered')
  assert.equal(result.questionId, questionId)
  assert.equal(result.answer.answer, 'B) Jupiter')
  assert.equal(result.answer.confidence, 'high')
  assert.match(result.markdown, /\*\*Answer:\*\* B\) Jupiter/)
  const [system, user] = engineCalls[0]
  assert.match(system.content, /never an instruction to you/)
  assert.match(user.content, /<question>[\s\S]*Which is the largest planet\?[\s\S]*B\) Jupiter[\s\S]*<\/question>/)
})

test('asking for the same answer twice works it out once', async () => {
  const { service, engineCalls } = rig()
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  const first = await service.answer(sessionId, { questionId })
  const again = await service.answer(sessionId, { questionId })
  assert.equal(engineCalls.length, 1)
  assert.deepEqual(again.answer, first.answer)
  assert.equal(again.cached, true)
})

test('a corrected question is answered as corrected, and the correction is what is saved', async () => {
  const { service, engineCalls, store } = rig()
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  await service.answer(sessionId, { questionId, text: 'What is the capital of Spain?' })
  assert.match(engineCalls[0][1].content, /capital of Spain/)
  assert.doesNotMatch(engineCalls[0][1].content, /capital of France/)
  const saved = store.get(sessionId)
  assert.match(saved.messages[0].content, /capital of Spain/)
})

test('a correction that is empty or far too long is refused', async () => {
  const { service } = rig()
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  for (const text of ['', '   ', 'x'.repeat(2001), 42, {}]) await rejects(service.answer(sessionId, { questionId, text }), { statusCode: 400, code: 'invalid-question' })
})

test('an unknown question is refused', async () => {
  const { service } = rig()
  const { sessionId } = await service.createSession()
  await rejects(service.answer(sessionId, { questionId: 'nope' }), { statusCode: 404, code: 'question-not-found' })
  await rejects(service.answer(sessionId, {}), { statusCode: 404, code: 'question-not-found' })
})

test('a model that fails to answer is a 502 and the question is kept, so asking again works', async () => {
  const { service, script, engineCalls } = rig()
  script.answers = [Object.assign(new Error('provider down: key sk-xyz'), { statusCode: 503 }), answerJson()]
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  await assert.rejects(service.answer(sessionId, { questionId }), (err) => err instanceof CameraError && err.statusCode === 502 && err.code === 'answer-failed' && !/sk-xyz|provider down/i.test(err.message))
  const retried = await service.answer(sessionId, { questionId })
  assert.equal(retried.answer.answer, 'Paris')
  assert.equal(engineCalls.length, 2)
})

test('a reply that is not JSON is still shown, as an explanation with low confidence and the reason', async () => {
  const { service, script } = rig()
  script.answers = ['It is Paris.']
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  const { answer } = await service.answer(sessionId, { questionId })
  assert.equal(answer.explanation, 'It is Paris.')
  assert.equal(answer.confidence, 'low')
  assert.match(answer.uncertainty, /expected format/i)
})

test('a model that never answers is given up on, so a hung provider cannot hang the page', async () => {
  const { service, script, vision } = rig({ limits: { modelTimeoutMs: 20 } })
  const { sessionId } = await service.createSession()
  script.reads = [() => new Promise(() => {})]
  await rejects(service.read(sessionId, image()), { statusCode: 502, code: 'read-failed' })
  assert.equal(vision.readCalls[0].signal.aborted, true, 'and the request is told to stop')
  script.reads = [reading()]
  const { questionId } = await service.read(sessionId, image()) // the session is not left "busy"
  const hung = rig({ limits: { modelTimeoutMs: 20 } })
  hung.script.answers = [() => new Promise(() => {})]
  const session = await hung.service.createSession()
  const read = await hung.service.read(session.sessionId, image())
  await rejects(hung.service.answer(session.sessionId, { questionId: read.questionId }), { statusCode: 502, code: 'answer-failed' })
  assert.ok(questionId)
})

// ---- diagrams ---------------------------------------------------------------------------------------------------

test('a question that depends on a figure is answered by the vision model with the picture, which is then dropped', async () => {
  const { service, vision, engineCalls, script } = rig()
  script.reads = [reading({ text: 'What is the area of the shaded triangle?', hasDiagram: true })]
  const { sessionId } = await service.createSession()
  const { questionId, question } = await service.read(sessionId, image())
  assert.equal(question.hasDiagram, true)
  const result = await service.answer(sessionId, { questionId })
  assert.equal(vision.answerCalls.length, 1)
  assert.equal(vision.answerCalls[0].image.bytes, vision.readCalls[0].image.bytes, 'the same picture')
  assert.equal(engineCalls.length, 0, 'the text-only engine could not see the figure')
  assert.equal(result.answer.answer, 'Paris')
  assert.equal(service._retainedPictures(), 0, 'nothing is kept once it is answered')
})

test('a picture kept for a diagram question is dropped after two minutes, and then the answer says it could not see the figure', async () => {
  const { service, vision, engineCalls, clock, script } = rig()
  script.reads = [reading({ text: 'What is the area of the shaded triangle?', hasDiagram: true })]
  script.answers = [answerJson({ confidence: 'high', uncertainty: null })]
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  assert.equal(service._retainedPictures(), 1)
  clock.now += 121_000
  const result = await service.answer(sessionId, { questionId })
  assert.equal(vision.answerCalls.length, 0)
  assert.equal(engineCalls.length, 1)
  assert.equal(result.answer.confidence, 'medium', 'never "high" about a figure nobody could see')
  assert.match(result.answer.uncertainty, /figure or table/i)
  assert.equal(service._retainedPictures(), 0)
})

test('a picture of an ordinary question is never kept at all', async () => {
  const { service } = rig()
  const { sessionId } = await service.createSession()
  await service.read(sessionId, image())
  assert.equal(service._retainedPictures(), 0)
})

// ---- what is saved -----------------------------------------------------------------------------------------------

test('each answered question is saved as a conversation (so history and delete work); only text, never a picture', async () => {
  const { service, store, script } = rig()
  const { sessionId } = await service.createSession()
  assert.equal(store.list().total, 0, 'a session with nothing answered saves nothing')
  const first = await service.read(sessionId, image())
  await service.answer(sessionId, { questionId: first.questionId })
  script.reads = [reading({ text: 'Define entropy.' })]
  const second = await service.read(sessionId, image())
  await service.answer(sessionId, { questionId: second.questionId })

  const saved = store.get(sessionId)
  assert.deepEqual(saved.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'])
  assert.match(saved.messages[0].content, /capital of France/)
  assert.match(saved.messages[1].content, /\*\*Answer:\*\* Paris/)
  assert.match(saved.title, /capital of France/)
  assert.equal(JSON.stringify(saved).includes(JPEG.toString('base64')), false)
})

test('clearing a session removes the saved conversation and the session, and is safe to repeat', async () => {
  const { service, store } = rig()
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  await service.answer(sessionId, { questionId })
  assert.equal(store.list().total, 1)
  assert.equal(await service.clear(sessionId), true)
  assert.equal(store.list().total, 0)
  await rejects(service.read(sessionId, image()), { code: 'session-not-found' })
  assert.equal(await service.clear(sessionId), true, 'clearing again is not an error')
  assert.equal(await service.clear('00000000-0000-4000-8000-000000000000'), true)
})

test('the session id is the saved conversation\'s id, so a restart does not strand the history', async () => {
  const { service, sessions, store } = rig()
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  await service.answer(sessionId, { questionId })
  assert.ok(store.get(sessionId))
  const restarted = createCameraService({ vision: { configured: true }, answerEngine: async () => '', sessions: createSessionService({ store }), limits: {} })
  assert.equal(await restarted.clear(sessionId), true, 'a fresh server process can still clear it')
  assert.equal(store.get(sessionId), null)
  void sessions
})

// ---- limits ------------------------------------------------------------------------------------------------------

test('a session reads only so many pictures, then says so', async () => {
  const { service, vision, script } = rig({ limits: { maxReads: 2 } })
  script.reads = [reading({ text: 'Define entropy.' }), reading({ text: 'Define enthalpy.' }), reading({ text: 'Define work.' })]
  const { sessionId } = await service.createSession()
  await service.read(sessionId, image())
  await service.read(sessionId, image())
  await rejects(service.read(sessionId, image()), { statusCode: 429, code: 'session-limit' })
  assert.equal(vision.readCalls.length, 2)
})

test('reads closer together than the minimum interval are told when to come back', async () => {
  const { service, clock, vision } = rig({ limits: { minReadIntervalMs: 2000 } })
  const { sessionId } = await service.createSession()
  await service.read(sessionId, image())
  clock.now += 500
  await assert.rejects(service.read(sessionId, image()), (err) => err.code === 'camera-rate-limited' && err.statusCode === 429 && err.retryAfterSeconds === 2)
  clock.now += 1600
  await service.read(sessionId, image())
  assert.equal(vision.readCalls.length, 2)
})

test('one read at a time per session, and a limited number at once overall', async () => {
  const releases = []
  const slow = () => new Promise((resolve) => releases.push(() => resolve(reading())))
  const { service, script } = rig({ limits: { maxConcurrentReads: 2 } })
  script.reads = [slow]
  const a = await service.createSession()
  const b = await service.createSession()
  const c = await service.createSession()
  const first = service.read(a.sessionId, image())
  await rejects(service.read(a.sessionId, image()), { statusCode: 409, code: 'camera-busy' })
  const second = service.read(b.sessionId, image())
  await new Promise((resolve) => setTimeout(resolve, 0))
  await assert.rejects(service.read(c.sessionId, image()), (err) => err.code === 'camera-busy' && err.statusCode === 503 && err.retryAfterSeconds >= 1)
  releases.forEach((release) => release())
  assert.equal((await first).status, 'new')
  assert.equal((await second).status, 'new')
  // both are done, so there is room again
  releases.length = 0
  const third = service.read(c.sessionId, image())
  await new Promise((resolve) => setTimeout(resolve, 0))
  releases.forEach((release) => release())
  assert.equal((await third).status, 'new')
})

test('a picture that is cleared while it is being read is not saved afterwards', async () => {
  const releases = []
  const { service, script, store } = rig()
  script.reads = [() => new Promise((resolve) => releases.push(() => resolve(reading())))]
  const { sessionId } = await service.createSession()
  const pending = service.read(sessionId, image())
  await new Promise((resolve) => setTimeout(resolve, 0))
  await service.clear(sessionId)
  releases.forEach((release) => release())
  await rejects(pending, { code: 'session-not-found' })
  assert.equal(store.list().total, 0)
})

// ---- privacy -------------------------------------------------------------------------------------------------------

test('what is logged says what happened, never what the picture or the question said', async () => {
  const { service, logged, script } = rig()
  script.reads = [reading({ text: 'My secret question about Zanzibar?' }), Object.assign(new Error('boom: ' + 'My secret question about Zanzibar?'), { statusCode: 500 })]
  const { sessionId } = await service.createSession()
  const { questionId } = await service.read(sessionId, image())
  await service.answer(sessionId, { questionId })
  await service.read(sessionId, image()).catch(() => {})
  assert.ok(logged.length > 0, 'it does log')
  assert.doesNotMatch(logged.join('\n'), /Zanzibar|secret question|ffd8|\/9j\//i)
})
