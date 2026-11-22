import assert from 'node:assert/strict'
import test from 'node:test'
import { createCaptureService } from './captureService.js'
import { createSessionManager } from './sessionManager.js'
import { fakeVision, png, quiet, reading, rig } from './testSupport.js'

function setup({ vision = fakeVision(), limits = {} } = {}) {
  const t = rig()
  const sessions = createSessionManager({ academic: t.academic, clock: () => t.clock.t, ttlMs: 3_600_000, audit: t.audit })
  const captures = createCaptureService({ vision, sessionManager: sessions, courses: (userId) => t.academic.forOwner(userId).courses, now: () => t.clock.t, logger: quiet, limits: { minReadIntervalMs: 0, ...limits } })
  const course = t.academic.forOwner(t.who.alice).courses.create({ title: 'Database Systems' })
  t.academic.forOwner(t.who.alice).courses.create({ title: 'Computer Networks' })
  vision.state.reply = async () => reading()
  return { ...t, vision, sessions, captures, course, alice: captures.forOwner(t.who.alice), aliceSessions: sessions.forOwner(t.who.alice), ctx: { identity: { ownerKey: t.who.alice }, requestId: 'r1' } }
}
const start = (t, over = {}) => t.aliceSessions.start({ type: 'study', courseId: t.course.id, captureEnabled: true, ...over })

test('a study screen is read: its question is recognised, classified, placed in the person\'s course and held for the session', async () => {
  const t = setup()
  const s = start(t)
  const result = await t.alice.read(s.id, { bytes: png() }, t.ctx)
  assert.equal(result.status, 'recognised')
  assert.equal(result.contentKind, 'revision_question')
  assert.equal(result.questions.length, 1)
  assert.deepEqual([result.questions[0].task, result.questions[0].duplicate], ['explain', false])
  assert.equal(result.context.courseId, t.course.id)
  assert.equal(result.context.source, 'session')
  assert.equal(t.alice.questions(s.id).length, 1)
  assert.equal(t.alice.questions(s.id)[0].answered, false)
  assert.match(t.vision.calls[0].messages[0].content, /Do not answer anything/)
  assert.equal(t.vision.calls[0].image.mimeType, 'image/png')
})

test('nothing is read in a restricted, paused, ended or expired session, or when capture is off - and no model is asked', async () => {
  const t = setup()
  const refuse = async (session, code, status) => {
    await assert.rejects(t.alice.read(session.id, { bytes: png() }, t.ctx), (err) => err.code === code && err.statusCode === status, code)
  }
  const restricted = t.aliceSessions.start({ type: 'restricted' })
  await refuse(restricted, 'restricted-assessment', 403)
  const off = t.aliceSessions.start({ type: 'study', captureEnabled: false })
  await refuse(off, 'capture-off', 409)
  const paused = start(t)
  t.aliceSessions.pause(paused.id)
  await refuse(paused, 'session-paused', 403)
  const ended = start(t)
  t.aliceSessions.stop(ended.id)
  await assert.rejects(t.alice.read(ended.id, { bytes: png() }, t.ctx), (err) => err.code === 'session-ended')
  const expiring = start(t)
  t.clock.t += 5 * 3_600_000
  await assert.rejects(t.alice.read(expiring.id, { bytes: png() }, t.ctx), (err) => err.code === 'session-ended', 'an expired session is ended on contact')
  assert.equal(t.vision.calls.length, 0)
})

test('the picture is checked before any model is asked: not a picture, too big, too small, not configured', async () => {
  const t = setup({ limits: { maxImageBytes: 1000 } })
  const s = start(t)
  const refuse = (picture, code) => assert.rejects(t.alice.read(s.id, picture, t.ctx), (err) => err.code === code, code)
  await refuse({ bytes: Buffer.alloc(0) }, 'invalid-image')
  await refuse({ bytes: Buffer.from('not a picture') }, 'invalid-image')
  await refuse({ bytes: Buffer.concat([png(), Buffer.alloc(2000)]) }, 'image-too-large')
  await refuse({ bytes: png(10, 10) }, 'invalid-image')
  assert.equal(t.vision.calls.length, 0)
  const off = setup({ vision: fakeVision({ configured: false }) })
  await assert.rejects(off.alice.read(start(off).id, { bytes: png() }, off.ctx), (err) => err.code === 'vision-not-configured' && err.statusCode === 503)
})

test('the same picture twice is not read twice, and the same question seen again is the same question', async () => {
  const t = setup()
  const s = start(t)
  const first = await t.alice.read(s.id, { bytes: png(1280, 720, 1) }, t.ctx)
  const again = await t.alice.read(s.id, { bytes: png(1280, 720, 1) }, t.ctx)
  assert.equal(again.status, 'duplicate')
  assert.equal(again.captureId, first.captureId)
  assert.equal(t.vision.calls.length, 1, 'the second picture never reached the model')
  const sameQuestion = await t.alice.read(s.id, { bytes: png(1280, 720, 2) }, t.ctx)
  assert.equal(sameQuestion.status, 'duplicate')
  assert.equal(sameQuestion.questions[0].duplicate, true)
  assert.equal(sameQuestion.questions[0].id, first.questions[0].id, 'it is offered once')
  assert.equal(t.alice.questions(s.id).length, 1)
})

test('what is not a question is said plainly: study material, an unreadable screen, a desktop, a reply that is not JSON', async () => {
  const t = setup()
  const s = start(t)
  const cases = [
    [reading({ contentKind: 'lecture_slide', questions: [] }), 'no-question'],
    [reading({ contentKind: 'non_academic', questions: [], reason: 'a game' }), 'not-academic'],
    [reading({ confidence: 0.1, reason: 'too dark' }), 'unclear'],
    ['I could not do that, sorry', 'unclear']
  ]
  let n = 0
  for (const [reply, status] of cases) {
    t.vision.state.reply = async () => reply
    const result = await t.alice.read(s.id, { bytes: png(1280, 720, 10 + n++) }, t.ctx)
    assert.equal(result.status, status, status)
    assert.deepEqual(result.questions, [])
  }
  assert.equal(t.alice.questions(s.id).length, 0)
})

test('a screen that says it is an examination is flagged for the person to confirm, with kinds only', async () => {
  const t = setup()
  const s = start(t)
  t.vision.state.reply = async () => reading({ assessmentIndicators: ['closed book', 'time remaining 40:00'] })
  const result = await t.alice.read(s.id, { bytes: png() }, t.ctx)
  assert.deepEqual(result.signals.sort(), ['closed-book', 'live-timer'])
  assert.deepEqual(t.alice.questions(s.id)[0].signals.sort(), ['closed-book', 'live-timer'])
})

test('reading is paced and capped: a gap between reads, a cap per session, one at a time; and the person\'s daily allowance is checked first', async () => {
  const t = setup({ limits: { minReadIntervalMs: 8000, maxReadsPerSession: 2 } })
  const s = start(t)
  await t.alice.read(s.id, { bytes: png(1280, 720, 1) }, t.ctx)
  await assert.rejects(t.alice.read(s.id, { bytes: png(1280, 720, 2) }, t.ctx), (err) => err.code === 'capture-rate-limited' && err.statusCode === 429 && err.retryAfterSeconds >= 1)
  t.clock.t += 9000
  t.vision.state.reply = async () => reading({ questions: [{ text: 'A completely different question about indexing performance.', options: [] }] })
  await t.alice.read(s.id, { bytes: png(1280, 720, 3) }, t.ctx)
  t.clock.t += 9000
  await assert.rejects(t.alice.read(s.id, { bytes: png(1280, 720, 4) }, t.ctx), (err) => err.code === 'session-limit' && err.statusCode === 429)

  const busy = setup()
  const b = start(busy)
  let release
  busy.vision.state.reply = () => new Promise((resolve) => (release = () => resolve(reading())))
  const slow = busy.alice.read(b.id, { bytes: png(1280, 720, 1) }, busy.ctx)
  await new Promise((r) => setImmediate(r))
  await assert.rejects(busy.alice.read(b.id, { bytes: png(1280, 720, 2) }, busy.ctx), (err) => err.code === 'capture-busy')
  release()
  await slow

  const limited = setup()
  const ls = start(limited)
  const meter = { begin() { throw Object.assign(new Error('Daily allowance reached'), { name: 'AiLimitError', statusCode: 429, code: 'daily-limit' }) } }
  await assert.rejects(limited.alice.read(ls.id, { bytes: png() }, { ...limited.ctx, meter }), (err) => err.name === 'AiLimitError')
  assert.equal(limited.vision.calls.length, 0, 'a refused read sent nothing')
})

test('a failing or slow model is a plain, retryable failure, counted as failed, and does not wedge the session', async () => {
  const t = setup({ limits: { modelTimeoutMs: 20 } })
  const s = start(t)
  const outcomes = []
  const meter = { begin: () => ({ usage() {}, finish: () => outcomes.push('ok'), fail: () => outcomes.push('failed') }) }
  t.vision.state.reply = async () => {
    throw Object.assign(new Error('x'), { statusCode: 503 })
  }
  await assert.rejects(t.alice.read(s.id, { bytes: png(1280, 720, 1) }, { ...t.ctx, meter }), (err) => err.code === 'read-failed' && err.statusCode === 502)
  t.vision.state.reply = () => new Promise(() => {})
  await assert.rejects(t.alice.read(s.id, { bytes: png(1280, 720, 2) }, { ...t.ctx, meter }), (err) => err.code === 'read-failed')
  t.vision.state.reply = async () => reading()
  assert.equal((await t.alice.read(s.id, { bytes: png(1280, 720, 3) }, { ...t.ctx, meter })).status, 'recognised')
  assert.deepEqual(outcomes, ['failed', 'failed', 'ok'])
})

test('screens are private to the person and the session: nobody else can read into, list or reach them', async () => {
  const t = setup()
  const s = start(t)
  await t.alice.read(s.id, { bytes: png() }, t.ctx)
  const bob = t.captures.forOwner(t.who.bob)
  await assert.rejects(bob.read(s.id, { bytes: png() }, { identity: { ownerKey: t.who.bob } }), (err) => err.code === 'session-not-found')
  assert.throws(() => bob.questions(s.id), (err) => err.code === 'session-not-found')
  t.aliceSessions.stop(s.id)
  assert.throws(() => t.alice.questions(s.id), (err) => err.code === 'session-ended')
})

test('only a picture that holds a diagram is kept (in memory, briefly); all others are dropped once read', async () => {
  const t = setup()
  const s = start(t)
  await t.alice.read(s.id, { bytes: png(1280, 720, 1) }, t.ctx)
  const runtime = t.aliceSessions.runtime(s.id)
  assert.ok([...runtime.captures.values()].every((c) => c.picture === null), 'a plain question keeps no picture')
  t.vision.state.reply = async () => reading({ questions: [{ text: 'Using the graph shown, estimate the break-even point of the firm.', options: [], hasDiagram: true }] })
  const withFigure = await t.alice.read(s.id, { bytes: png(1280, 720, 2) }, t.ctx)
  assert.ok(runtime.captures.get(withFigure.captureId).picture, 'a figure is kept so the answer can look at it')
  t.clock.t += 3 * 60_000
  await t.alice.read(s.id, { bytes: png(1280, 720, 3) }, t.ctx).catch(() => {})
  assert.equal(runtime.captures.get(withFigure.captureId).picture, null, 'and dropped after two minutes')
})
