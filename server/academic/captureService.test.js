import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPTURE_LIMITS, createCaptureService } from './captureService.js'
import { createSessionManager } from './sessionManager.js'
import { fakeVision, png, quiet, reading, rig } from './testSupport.js'

const TEXT = {
  tables: 'Relational databases store data in tables made of rows and columns, and every row is identified by a primary key that never repeats.',
  keys: 'A foreign key is a column in one table that refers to the primary key of another table, which is how related rows are linked together.',
  norm: 'Normalisation is the process of organising tables so that each fact is stored once, which removes update anomalies and wasted space.',
  joins: 'A join combines rows from two tables whenever the values in the columns being compared are equal, producing one wider row for each match.',
  index: 'An index is a separate structure that lets the database find rows by the value of a column without reading every row of the table.'
}
const sg = (text, over = {}) => ({ kind: 'paragraph', title: '', text, cutOff: 'none', ...over })
const sq = (text, over = {}) => ({ kind: 'question', title: '', text, options: [], marks: null, type: 'descriptive', hasDiagram: false, cutOff: 'none', ...over })
/** A vision reply listing these segments. */
const screenOf = (segments, over = {}) => JSON.stringify({ contentKind: 'other_content', segments, position: '', instructions: '', subject: 'databases', topic: '', assessmentIndicators: [], confidence: 0.9, reason: '', ...over })
let shot = 100
const read = async (t, s, segments, over) => {
  t.vision.state.reply = async () => screenOf(segments, over)
  t.clock.t += 9_000
  return t.alice.read(s.id, { bytes: png(1280, 720, shot++) }, t.ctx)
}

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

test('a model that refused the key or has no billing is "unavailable", said plainly; any other failure stays a retryable read-failed', async () => {
  const t = setup()
  const s = start(t)
  const outcomes = []
  const meter = { begin: () => ({ usage() {}, finish: () => outcomes.push('ok'), fail: () => outcomes.push('failed') }) }
  for (const [n, reason] of [[1, 'billing'], [2, 'key']]) {
    t.vision.state.reply = async () => {
      throw Object.assign(new Error('The vision service answered 429'), { statusCode: 429, reason })
    }
    await assert.rejects(
      t.alice.read(s.id, { bytes: png(1280, 720, n) }, { ...t.ctx, meter }),
      (err) => err.code === 'vision-unavailable' && err.statusCode === 503 && /not accepting requests/.test(err.message) && !/429|billing|key/i.test(err.message)
    )
  }
  t.vision.state.reply = async () => {
    throw Object.assign(new Error('x'), { statusCode: 429 }) // a plain rate limit at the provider
  }
  await assert.rejects(t.alice.read(s.id, { bytes: png(1280, 720, 3) }, { ...t.ctx, meter }), (err) => err.code === 'read-failed' && err.statusCode === 502)
  assert.deepEqual(outcomes, ['failed', 'failed', 'failed'])
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

test('the study capture limits are the ones the session promises: 8 seconds between reads and 80 screens per session; an identical picture costs nothing', async () => {
  assert.equal(CAPTURE_LIMITS.minReadIntervalMs, 8000)
  assert.equal(CAPTURE_LIMITS.maxReadsPerSession, 80)
  // with those defaults in force
  const t = setup({ limits: { minReadIntervalMs: CAPTURE_LIMITS.minReadIntervalMs, maxReadsPerSession: CAPTURE_LIMITS.maxReadsPerSession } })
  const s = start(t)
  const first = png(1280, 720, 1)
  await t.alice.read(s.id, { bytes: first }, t.ctx)
  await assert.rejects(t.alice.read(s.id, { bytes: png(1280, 720, 2) }, t.ctx), (err) => err.code === 'capture-rate-limited' && err.retryAfterSeconds <= 8)
  assert.equal((await t.alice.read(s.id, { bytes: first }, t.ctx)).status, 'duplicate', 'an identical picture is answered without a read')
  assert.equal(t.vision.calls.length, 1, 'one screen read so far: the refused one and the repeat cost nothing')
  t.clock.t += 8_000
  await t.alice.read(s.id, { bytes: png(1280, 720, 3) }, t.ctx)
  assert.equal(t.vision.calls.length, 2, 'and after the 8 seconds the next screen is read')
})

// ---- content intelligence: layouts, navigation, overlap, continuity, repeats ---------------------------------------------------

test('a screen of study material with no question is organised and shown, not thrown away as "not a question"', async () => {
  const t = setup()
  const s = start(t)
  const first = await read(t, s, [sg(TEXT.tables, { title: 'Tables' })])
  assert.deepEqual([first.status, first.layout, first.arrival, first.summary.new, first.questions.length], ['recognised', 'single', 'new-screen', 1, 0])
  assert.equal(first.segments[0].text, TEXT.tables)
  assert.equal(t.alice.questions(s.id).length, 0, 'no question was invented')
  const again = await read(t, s, [sg(TEXT.tables, { title: 'Tables' })])
  assert.deepEqual([again.status, again.arrival, again.segments[0].status], ['duplicate', 'same', 'seen'])
  assert.equal(t.alice.content(s.id).length, 1, 'held once')
})

test('several segments on one screen: each is recognised, the questions among them are offered, and only what is new is new next time', async () => {
  const t = setup()
  const s = start(t)
  const first = await read(t, s, [sg(TEXT.tables, { title: 'Tables' }), sq('Explain why every row in a table needs a primary key that never repeats.', { title: 'Q1' }), sq('Describe what a foreign key does and give one example from a school database.', { title: 'Q2' }), { kind: 'code', title: '', text: 'SELECT name FROM students WHERE id = 7;', cutOff: 'none' }])
  assert.deepEqual([first.layout, first.summary.total, first.summary.new, first.questions.length], ['multiple', 4, 4, 2])
  assert.deepEqual(first.segments.map((x) => x.kind), ['paragraph', 'question', 'question', 'code'])
  assert.ok(first.questions.every((q) => q.duplicate === false && q.segmentId))
  const second = await read(t, s, [sg(TEXT.tables, { title: 'Tables' }), sq('Describe what a foreign key does and give one example from a school database.', { title: 'Q2' }), sq('Explain what an index is and why it makes some queries faster.', { title: 'Q3' })])
  assert.deepEqual(second.segments.map((x) => x.status), ['seen', 'seen', 'new'])
  assert.deepEqual(second.questions.map((q) => q.duplicate), [true, false], 'Q2 is offered once; Q3 is new')
  assert.equal(second.questions[0].id, first.questions[1].id)
  assert.equal(t.alice.questions(s.id).length, 3)
})

test('horizontal navigation (next, previous, tabs): new pages are new, and going back reads nothing again', async () => {
  const t = setup()
  const s = start(t)
  const A = [sg(TEXT.tables, { title: 'Slide 1' })]
  const B = [sg(TEXT.keys, { title: 'Slide 2' }), sq('Explain how a foreign key keeps two tables consistent with each other.', { title: 'Slide 2 task' })]
  const C = [sg(TEXT.norm, { title: 'Slide 3' })]
  const results = []
  for (const page of [A, B, C, B, A, C]) results.push(await read(t, s, page))
  assert.deepEqual(results.map((r) => r.arrival), ['new-screen', 'new-screen', 'new-screen', 'revisit', 'revisit', 'revisit'])
  assert.deepEqual(results.map((r) => r.status), ['recognised', 'recognised', 'recognised', 'duplicate', 'duplicate', 'duplicate'])
  assert.deepEqual(results.map((r) => r.questions.filter((q) => !q.duplicate).length), [0, 1, 0, 0, 0, 0], 'the one question is offered once')
  assert.equal(t.alice.content(s.id).length, 4)
})

test('vertical scrolling: the overlap is not processed again and what appears is', async () => {
  const t = setup()
  const s = start(t)
  const one = await read(t, s, [sg(TEXT.tables), sg(TEXT.keys), sq('Explain what normalisation achieves for a database that stores customer orders.')])
  const two = await read(t, s, [sg(TEXT.keys), sq('Explain what normalisation achieves for a database that stores customer orders.'), sg(TEXT.joins), sq('Say what a join does when two tables share a column of values.')])
  assert.deepEqual(two.segments.map((x) => x.status), ['seen', 'seen', 'new', 'new'])
  assert.equal(two.arrival, 'overlapping')
  assert.deepEqual(two.questions.map((q) => q.duplicate), [true, false], 'the old question is not offered again, the new one is')
  assert.equal(two.questions[0].id, one.questions[0].id)
  const three = await read(t, s, [sg(TEXT.joins), sq('Say what a join does when two tables share a column of values.'), sg(TEXT.index)])
  assert.deepEqual(three.segments.map((x) => x.status), ['seen', 'seen', 'new'])
  assert.equal(t.alice.questions(s.id).length, 2)
})

test('a question cut off by the edge of the screen is held as cut off, and is whole - and newly offered for answering - when the rest appears', async () => {
  const t = setup()
  const s = start(t)
  const full = 'Explain why the primary key of a table must be unique and cannot be empty, and give an example of a suitable key for a table of students.'
  const first = await read(t, s, [sg(TEXT.tables), sq(full.split(' ').slice(0, 14).join(' '), { cutOff: 'bottom' })])
  assert.equal(first.questions.length, 1)
  assert.deepEqual([first.questions[0].partial, first.questions[0].duplicate], [true, false], 'held, marked as cut off, so it is not answered by itself')
  assert.equal(t.alice.questions(s.id)[0].text.split(' ').length, 14)
  const second = await read(t, s, [sg(TEXT.keys), sq(full)])
  const completed = second.questions[0]
  assert.deepEqual([completed.id, completed.completed, completed.duplicate, completed.partial], [first.questions[0].id, true, false, false])
  assert.equal(t.alice.questions(s.id)[0].text, full, 'the session now holds the whole question')
  assert.equal(t.alice.questions(s.id).length, 1, 'one question, not two')
})

test('content continuing across screens becomes one segment without repeated words, and a continuation that shares no words is linked, not lost', async () => {
  const t = setup()
  const s = start(t)
  const words = TEXT.norm.split(' ')
  const first = await read(t, s, [sg(words.slice(0, 16).join(' '), { title: 'Normalisation', cutOff: 'bottom' })])
  const second = await read(t, s, [sg(words.slice(11).join(' '), { cutOff: 'top' })])
  assert.deepEqual([second.segments[0].status, second.segments[0].id], ['continued', first.segments[0].id])
  assert.equal(second.segments[0].text, TEXT.norm)
  assert.equal(t.alice.content(s.id).length, 1)
  const third = await read(t, s, [sg('The first step in the experiment is to weigh the powder and then pour it carefully into the glass beaker provided', { cutOff: 'bottom', group: 'Method' })])
  const fourth = await read(t, s, [sg('Stir the mixture slowly for two minutes until nothing remains at the bottom and then let it stand', { cutOff: 'top', group: 'Method' })])
  assert.equal(fourth.segments[0].status, 'new')
  assert.equal(fourth.segments[0].continuesFrom, third.segments[0].id)
  assert.equal(t.alice.content(s.id).length, 3)
})

test('new content that overlaps earlier content in words is still new: nothing genuinely new is discarded', async () => {
  const t = setup()
  const s = start(t)
  await read(t, s, [sg(TEXT.keys), sq('Calculate the total cost of 12 items at 4 pounds each.')])
  const next = await read(t, s, [sg('A foreign key is a column in a table that stores the name of the customer who placed the order, which is how the table is linked.'), sq('Calculate the total cost of 13 items at 4 pounds each.')])
  assert.deepEqual(next.segments.map((x) => x.status), ['new', 'new'])
  assert.equal(next.questions.filter((q) => !q.duplicate).length, 1)
})

test('the content list lists every segment once and refuses a session that is not open', async () => {
  const t = setup()
  const s = start(t)
  await read(t, s, [sg(TEXT.tables), sq('Explain why every row in a table needs a primary key that never repeats.')])
  await read(t, s, [sg(TEXT.tables), sg(TEXT.keys)])
  const content = t.alice.content(s.id)
  assert.deepEqual(content.map((x) => [x.kind, x.seenCount]), [['paragraph', 2], ['question', 1], ['paragraph', 1]])
  t.aliceSessions.stop(s.id)
  assert.throws(() => t.alice.content(s.id), (err) => err.statusCode === 409 || err.statusCode === 404)
})

test('the content intelligence changes nothing about who may read: restricted, paused and exhausted sessions read no screen', async () => {
  const t = setup({ limits: { minReadIntervalMs: 0, maxReadsPerSession: 2 } })
  const s = start(t)
  await read(t, s, [sg(TEXT.tables)])
  await read(t, s, [sg(TEXT.keys)])
  await assert.rejects(read(t, s, [sg(TEXT.norm)]), (err) => err.code === 'session-limit')
  t.aliceSessions.pause(s.id)
  await assert.rejects(read(t, s, [sg(TEXT.joins)]), (err) => err.code === 'session-paused')
  assert.equal(t.vision.calls.length, 2, 'no model was asked after the limit or while paused')
  assert.equal(t.alice.content(s.id).length, 2)
})
