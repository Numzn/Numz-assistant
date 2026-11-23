import assert from 'node:assert/strict'
import test from 'node:test'
import { CaptureError } from '../src/interfaces/screenshot/nativeCapture.js'
import { AcademicApiError } from '../src/interfaces/academic/academicApi.js'
import { createStudyController } from '../src/interfaces/academic/studyController.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
async function until(fn, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true
    await tick()
  }
  throw new Error('condition never became true')
}
const err = (status, code, message = code, extra = {}) => new AcademicApiError(message, { status, code, ...extra })

function fakeNative({ available = true, watch = true } = {}) {
  const calls = { start: [], poll: 0, pause: 0, resume: 0, stop: 0, export: [], discard: [] }
  const script = { polls: [], startError: null }
  return {
    available,
    calls,
    script,
    async status() {
      return { platform: 'linux', session: 'x11', modes: { screen: true, window: true, region: true, watch }, permission: 'granted', note: '' }
    },
    async watchStart(args) {
      calls.start.push(args)
      if (script.startError) throw script.startError
      return { status: 'watching' }
    },
    async watchPoll() {
      calls.poll++
      const next = script.polls.length > 1 ? script.polls.shift() : script.polls[0]
      if (next instanceof Error) throw next
      return next ?? { status: 'watching', pending: null, stats: { looks: 0, reported: 0, skippedExcluded: 0 }, stoppedBecause: null, excludedNow: false }
    },
    async watchPause() {
      calls.pause++
    },
    async watchResume() {
      calls.resume++
    },
    async watchStop() {
      calls.stop++
    },
    async exportCapture(args) {
      calls.export.push(args)
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', width: 10, height: 10 }
    },
    async discard(id) {
      calls.discard.push(id)
    }
  }
}

const session = (over = {}) => ({ id: 's1', sessionType: 'study', status: 'active', courseId: 'c1', activeTopic: 'normal forms', captureEnabled: true, autoAnswer: false, useResearch: false, ...over })
const polled = (over = {}) => ({ status: 'watching', pending: null, stats: { looks: 3, reported: 1, skippedExcluded: 0 }, stoppedBecause: null, excludedNow: false, ...over })
const pending = (id = 'cap-1') => ({ captureId: id, width: 100, height: 50, preview: 'data:image/jpeg;base64,AAAA' })
const recognised = (over = {}) => ({ captureId: 'k1', status: 'recognised', questions: [{ id: 'q1', text: 'Explain third normal form.', options: [], task: 'explain', duplicate: false }], context: { courseId: 'c1' }, signals: [], ...over })
const answered = (over = {}) => ({ status: 'answered', answerId: 'a1', questionId: 'q1', courseId: 'c1', topic: 'third normal form', approach: 'step_by_step', markdown: 'It means… [S1]', sources: [], grounding: 'course', evidence: {}, flags: {}, task: 'explain', savedToConversation: true, ...over })

function fakeApi() {
  const calls = { start: [], update: [], stop: 0, pause: 0, resume: 0, send: [], answer: [], ask: [], concept: [], feedback: [] }
  const script = { start: async (o) => session({ sessionType: o.type, captureEnabled: o.captureEnabled, autoAnswer: o.autoAnswer }), send: async () => recognised(), answer: async () => answered(), ask: async () => answered(), concept: async () => answered(), feedback: async () => ({ recorded: true }), current: { session: null }, courses: { courses: [{ id: 'c1', title: 'Databases' }] } }
  return {
    calls,
    script,
    courses: { list: async () => script.courses },
    sessions: {
      start: async (o) => (calls.start.push(o), script.start(o)),
      current: async () => script.current,
      update: async (id, patch) => (calls.update.push([id, patch]), session({ ...patch })),
      pause: async () => (calls.pause++, session({ status: 'paused' })),
      resume: async () => (calls.resume++, session()),
      stop: async () => (calls.stop++, session({ status: 'ended' }))
    },
    sendCapture: async (id, image) => (calls.send.push([id, image]), script.send()),
    answer: async (id, q, o) => (calls.answer.push([q, o]), script.answer()),
    ask: async (id, text, o) => (calls.ask.push([text, o]), script.ask()),
    concept: async (id, c, o) => (calls.concept.push([c, o]), script.concept()),
    feedback: async (b) => (calls.feedback.push(b), script.feedback())
  }
}

function build({ native = fakeNative(), api = fakeApi(), conversation = 'conv-1' } = {}) {
  const exchanges = []
  // The watcher's loop waits between looks. In a test that fails before it stops the controller, an endless loop would hold the process
  // open: after a generous number of waits the wait simply never returns (a pending promise does not keep Node alive).
  let waits = 0
  const clock = { t: 1_000_000 } // moves 1.5 s with every look, like the real loop
  const wait = () => (++waits > 20_000 ? new Promise(() => {}) : ((clock.t += 1500), tick()))
  const controller = createStudyController({ api, native, getConversationId: () => conversation, onExchange: (e) => exchanges.push(e), getExclusions: () => ({ apps: ['slack'], titles: ['payroll'] }), wait, now: () => clock.t })
  return { controller, api, native, exchanges, clock }
}

test('a plain browser has no screen reading, and says so; an existing session is picked up but never starts reading the screen by itself', async () => {
  const t = build({ native: fakeNative({ available: false }) })
  await t.controller.init()
  assert.equal(t.controller.getState().watch.available, false)
  assert.match(t.controller.getState().watch.note, /needs the NUMZ AI desktop app/)
  assert.deepEqual(t.controller.getState().courses.map((c) => c.title), ['Databases'])
  await t.controller.start({ type: 'study', captureEnabled: true })
  assert.equal(t.api.calls.start.length, 0, 'asked for screen reading where it cannot be had: nothing was started')
  assert.equal(t.controller.getState().phase, 'idle')

  const back = build()
  back.api.script.current = { session: session() }
  await back.controller.init()
  assert.equal(back.controller.getState().phase, 'active')
  assert.equal(back.controller.getState().watch.status, 'off')
  assert.match(back.controller.getState().message, /Screen reading is off after reloading/)
  assert.equal(back.native.calls.start.length, 0)
  await back.controller.resumeWatching()
  assert.equal(back.controller.getState().watch.status, 'watching')
  assert.equal(back.native.calls.start.length, 1)
  await back.controller.destroy()
})

test('starting a study session with screen reading starts the watcher with the person\'s exclusions; a restricted session never touches it', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', topic: 'normal forms', captureEnabled: true, autoAnswer: false })
  assert.deepEqual(t.api.calls.start[0], { type: 'study', courseId: 'c1', topic: 'normal forms', captureEnabled: true, autoAnswer: false })
  assert.deepEqual(t.native.calls.start, [{ excludeApps: ['slack'], excludeTitles: ['payroll'] }])
  assert.equal(t.controller.getState().phase, 'active')
  assert.equal(t.controller.getState().watch.status, 'watching')
  await t.controller.stop()

  const r = build()
  await r.controller.init()
  await r.controller.start({ type: 'restricted', courseId: 'c1', captureEnabled: true, autoAnswer: true })
  assert.deepEqual([r.api.calls.start[0].captureEnabled, r.api.calls.start[0].autoAnswer], [false, false], 'the page never even asks')
  assert.equal(r.native.calls.start.length, 0)
  assert.equal(r.controller.getState().watch.status, 'off')
  assert.equal(r.controller.getState().phase, 'active')
})

test('if the server refuses to start the session nothing is left running; if the watcher cannot start, the session keeps going with screen reading OFF and says why', async () => {
  const refused = build()
  await refused.controller.init()
  refused.api.script.start = async () => {
    throw err(404, 'course-not-found', 'That course does not exist.')
  }
  await refused.controller.start({ type: 'study', courseId: 'gone', captureEnabled: true })
  assert.equal(refused.controller.getState().phase, 'idle')
  assert.equal(refused.native.calls.start.length, 0)
  assert.equal(refused.controller.getState().message, 'That course does not exist.')

  const t = build()
  await t.controller.init()
  t.native.script.startError = new CaptureError('permission-denied', 'NUMZ AI is not allowed to capture the screen.')
  await t.controller.start({ type: 'study', captureEnabled: true })
  assert.equal(t.controller.getState().phase, 'active')
  assert.equal(t.controller.getState().watch.status, 'off')
  assert.deepEqual(t.api.calls.update, [['s1', { captureEnabled: false }]], 'the server is told screen reading is off')
  assert.match(t.controller.getState().message, /Screen reading could not start: NUMZ AI is not allowed to capture the screen\./)
})

test('a changed screen reported by the watcher is sent for reading and its question appears once; the native copy is always let go', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  t.native.script.polls = [polled({ pending: pending('cap-1') }), polled()]
  await until(() => t.controller.getState().questions.length === 1)
  assert.deepEqual(t.native.calls.export[0], { captureId: 'cap-1', maxSide: 1600, quality: 80 })
  assert.deepEqual(t.native.calls.discard, ['cap-1'])
  assert.equal(t.api.calls.send[0][0], 's1')
  assert.deepEqual([...t.api.calls.send[0][1].bytes], [1, 2, 3])
  const q = t.controller.getState().questions[0]
  assert.deepEqual([q.id, q.state, q.task], ['q1', 'new', 'explain'])
  assert.match(t.controller.getState().message, /Found a question on your screen/)
  assert.equal(t.controller.getState().watch.reported, 1)

  t.api.script.send = async () => recognised({ questions: [{ id: 'q1', text: 'Explain third normal form.', duplicate: true }] })
  t.native.script.polls = [polled({ pending: pending('cap-2') }), polled()]
  await until(() => t.native.calls.discard.length === 2)
  await tick()
  assert.equal(t.controller.getState().questions.length, 1, 'the same question is not listed twice')
  await t.controller.stop()
})

test('things that are not questions, a failing read or a busy server are quiet; the end of the session ends everything; the daily limit pauses reading', async () => {
  const quietCase = async (result) => {
    const t = build()
    await t.controller.init()
    await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true })
    if (result instanceof Error) t.api.script.send = async () => { throw result }
    else t.api.script.send = async () => result
    t.native.script.polls = [polled({ pending: pending() }), polled()]
    await until(() => t.api.calls.send.length === 1)
    await tick()
    await tick()
    return t
  }
  for (const result of [{ status: 'no-question', questions: [] }, { status: 'not-academic', questions: [] }, { status: 'unclear', questions: [] }, { status: 'duplicate', questions: [] }, err(429, 'capture-rate-limited'), err(409, 'capture-busy'), err(502, 'read-failed'), err(0, 'network')]) {
    const t = await quietCase(result)
    assert.equal(t.controller.getState().questions.length, 0)
    assert.equal(t.controller.getState().phase, 'active', 'and the session carries on')
    assert.equal(t.controller.getState().watch.status, 'watching')
    await t.controller.stop()
  }
  const ended = await quietCase(err(409, 'session-ended', 'That study session has ended.'))
  await until(() => ended.controller.getState().phase === 'idle')
  assert.equal(ended.native.calls.stop, 1)
  assert.match(ended.controller.getState().message, /study session has ended/)

  const limited = await quietCase(err(429, 'daily-limit', 'You have reached the day\'s limit for study screens read.'))
  await until(() => limited.controller.getState().watch.status === 'paused')
  assert.equal(limited.native.calls.pause, 1)
  assert.match(limited.controller.getState().message, /Screen reading is paused/)
  await limited.controller.stop()
})

test('a question can be answered by itself when the person asked for that, but never when the screen looks like an assessment', async () => {
  const auto = build()
  await auto.controller.init()
  auto.api.script.start = async (o) => session({ captureEnabled: true, autoAnswer: true })
  await auto.controller.start({ type: 'practice', courseId: 'c1', captureEnabled: true, autoAnswer: true })
  auto.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => auto.api.calls.answer.length === 1)
  await until(() => auto.controller.getState().questions[0]?.state === 'answered')
  assert.equal(auto.exchanges.length, 1)
  assert.deepEqual(auto.exchanges[0], { question: 'Explain third normal form.', answer: 'It means… [S1]', ref: 'a1' }, 'the exchange says which answer it is, so the panel can point back at it')
  assert.equal(auto.controller.getState().questions[0].answer.ref, 'a1')
  await auto.controller.stop()

  const flagged = build()
  await flagged.controller.init()
  flagged.api.script.start = async () => session({ captureEnabled: true, autoAnswer: true })
  flagged.api.script.send = async () => recognised({ signals: ['closed-book'] })
  await flagged.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: true })
  flagged.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => flagged.controller.getState().questions.length === 1)
  await tick()
  await tick()
  assert.equal(flagged.api.calls.answer.length, 0, 'nothing is answered on its own when the screen says it may be an examination')
  await flagged.controller.stop()
})

test('an answer joins the conversation and the answer card; a screen that may be an exam asks the person first; an unclear course asks which', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  t.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => t.controller.getState().questions.length === 1)

  t.api.script.answer = async () => ({ status: 'confirm-required', signals: ['closed-book'], message: 'This screen looks like a formal assessment…' })
  await t.controller.answerQuestion('q1')
  let q = t.controller.getState().questions[0]
  assert.deepEqual([q.state, q.signals], ['confirm', ['closed-book']])
  assert.match(q.message, /formal assessment/)
  assert.equal(t.exchanges.length, 0)

  t.api.script.answer = async () => answered()
  await t.controller.answerQuestion('q1', { confirmPractice: true })
  assert.equal(t.api.calls.answer[1][1].confirmPractice, true)
  assert.equal(t.api.calls.answer[1][1].conversationId, 'conv-1')
  q = t.controller.getState().questions[0]
  assert.equal(q.state, 'answered')
  assert.equal(t.controller.getState().lastAnswer.answerId, 'a1')
  assert.equal(t.exchanges.length, 1)

  t.api.script.answer = async () => ({ status: 'needs-course', candidates: [{ courseId: 'c1', title: 'Databases' }], message: 'Which course is this question from?' })
  await t.controller.answerQuestion('q1')
  assert.equal(t.controller.getState().questions[0].state, 'needs-course')
  assert.equal(t.controller.getState().questions[0].candidates[0].title, 'Databases')

  t.api.script.answer = async () => {
    throw err(502, 'answer-failed', 'An answer could not be worked out just now. Try again.')
  }
  await t.controller.answerQuestion('q1')
  assert.deepEqual([t.controller.getState().questions[0].state, t.controller.getState().questions[0].message], ['failed', 'An answer could not be worked out just now. Try again.'])
  await t.controller.stop()
})

test('a paused session reads nothing and answers nothing; resume starts again; stop ends the watcher and the session and forgets the questions', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true })
  t.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => t.controller.getState().questions.length === 1)
  await t.controller.pause()
  assert.equal(t.controller.getState().phase, 'paused')
  assert.equal(t.controller.getState().watch.status, 'paused')
  assert.equal(t.native.calls.pause, 1)
  assert.equal(await t.controller.answerQuestion('q1'), null, 'not while paused')
  assert.equal(await t.controller.ask('What is a key?'), null)
  await t.controller.resume()
  assert.equal(t.controller.getState().phase, 'active')
  assert.equal(t.controller.getState().watch.status, 'watching')
  assert.equal(t.native.calls.resume, 1)
  await t.controller.stop()
  const s = t.controller.getState()
  assert.deepEqual([s.phase, s.session, s.questions.length, s.lastAnswer, s.watch.status], ['idle', null, 0, null, 'off'])
  assert.equal(t.native.calls.stop, 1)
  assert.equal(t.api.calls.stop, 1)
  const polls = t.native.calls.poll
  await tick()
  await tick()
  assert.equal(t.native.calls.poll, polls, 'the page stopped asking the app for results')
})

test('if the app stops answering, or stops the watcher itself, the person is told and reading is off', async () => {
  const dead = build()
  await dead.controller.init()
  await dead.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true })
  dead.native.script.polls = [new Error('bridge gone')]
  await until(() => dead.controller.getState().watch.status === 'off')
  assert.match(dead.controller.getState().message, /desktop app did not answer/)

  const gone = build()
  await gone.controller.init()
  await gone.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true })
  gone.native.script.polls = [polled({ status: 'stopped', stoppedBecause: 'page-gone' })]
  await until(() => gone.controller.getState().watch.status === 'off')
  assert.match(gone.controller.getState().message, /this page stopped checking in/)
})

test('typed questions and concepts: answered, shown, and refused with the server\'s own words in a restricted session', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1' })
  const outcome = await t.controller.ask('What is a primary key?', { topic: 'keys' })
  assert.equal(outcome.status, 'answered')
  assert.deepEqual(t.api.calls.ask[0], ['What is a primary key?', { conversationId: 'conv-1', topic: 'keys', courseId: null, style: null, instruction: null, confirmPractice: false }])
  assert.equal(t.controller.getState().questions.at(-1).state, 'answered')
  assert.equal(t.exchanges.length, 1)
  assert.equal(await t.controller.ask('   '), null)

  const r = build()
  await r.controller.init()
  await r.controller.start({ type: 'restricted', courseId: 'c1' })
  r.api.script.ask = async () => {
    throw err(403, 'restricted-assessment', 'This session is marked as a restricted assessment, so NUMZ AI will not read the screen or answer the question.', { details: { offer: 'explain_concept' } })
  }
  assert.equal(await r.controller.ask('What is third normal form?'), null)
  assert.match(r.controller.getState().message, /restricted assessment/)
  assert.equal(r.controller.getState().questions.length, 0)
  const concept = await r.controller.explainConcept('third normal form')
  assert.equal(concept.status, 'answered')
  assert.equal(r.api.calls.concept[0][0], 'third normal form')
  r.api.script.concept = async () => {
    throw err(400, 'concept-looks-like-question', 'In a restricted session, name the concept you want explained.')
  }
  assert.equal(await r.controller.explainConcept('Explain why a table in 2NF may fail 3NF and give a long worked example'), null)
  assert.match(r.controller.getState().message, /name the concept/)
})

test('feedback: what helped is remembered with the approach used, "simpler" asks the same question again, an explanation can be kept as a note', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', topic: 'normal forms' })
  assert.equal(await t.controller.feedback('helpful'), null, 'nothing to give feedback on yet')
  await t.controller.ask('Explain third normal form.')
  await t.controller.feedback('helpful')
  assert.deepEqual(t.api.calls.feedback[0], { kind: 'helpful', courseId: 'c1', topic: 'third normal form', note: null, approach: 'step_by_step' })
  assert.match(t.controller.getState().message, /NUMZ AI will remember that/)
  await t.controller.feedback('correction', { note: 'it is not transitive on the key' })
  assert.equal(t.api.calls.feedback[1].note, 'it is not transitive on the key')
  await t.controller.feedback('save_concept')
  assert.deepEqual(t.api.calls.feedback[2], { kind: 'save_concept', courseId: 'c1', topic: 'third normal form', text: 'It means… [S1]' })
  assert.match(t.controller.getState().message, /Saved to your course materials/)

  t.api.script.feedback = async () => ({ recorded: false, reason: 'adaptive-learning-off' })
  await t.controller.feedback('not_helpful')
  assert.match(t.controller.getState().message, /Adaptive learning is off, so nothing was remembered/)
  t.api.script.feedback = async () => ({ recorded: false, reason: 'no-course' })
  await t.controller.feedback('helpful')
  assert.match(t.controller.getState().message, /Choose a course for this session/)

  const before = t.api.calls.answer.length
  t.controller.getState().questions.at(-1)
  await t.controller.feedback('explain')
  assert.equal(t.api.calls.answer.at(-1)[1].style, 'explain', '"Explain" asks the same question again, to be explained')
  assert.equal(t.api.calls.answer.length, before + 1)
  await t.controller.feedback('simpler')
  assert.equal(t.api.calls.answer.length, before + 2)
  assert.equal(t.api.calls.answer.at(-1)[1].style, 'simpler')
})

// ---- the automatic flow: from a changed screen to an answer in the panel and the conversation ------------------------------------

const questions = (n) => Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, text: `Question ${i + 1}. Explain a normal form.`, options: [], task: 'explain', duplicate: false }))

test('reading the screen answers by itself unless the person turned that off: every new question of a screen (up to three), one at a time, each into the conversation', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true }) // no autoAnswer option: the default is on
  assert.equal(t.api.calls.start[0].autoAnswer, true)
  assert.equal(t.controller.getState().session.autoAnswer, true)
  let running = 0
  let overlapped = false
  t.api.script.send = async () => recognised({ questions: questions(4) })
  t.api.script.answer = async () => {
    overlapped ||= ++running > 1
    await tick()
    await tick()
    running--
    return answered({ questionId: `q${t.api.calls.answer.length}`, markdown: `Answer ${t.api.calls.answer.length}` })
  }
  t.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => t.exchanges.length === 3)
  assert.equal(overlapped, false, 'one answer at a time')
  assert.deepEqual(t.exchanges.map((e) => e.answer), ['Answer 1', 'Answer 2', 'Answer 3'], 'in the order found, into the conversation')
  assert.deepEqual(t.controller.getState().questions.map((q) => q.state), ['answered', 'answered', 'answered', 'new'], 'the fourth waits for an Explain press')
  assert.match(t.controller.getState().message, /first 3 of 4/)
  assert.equal(t.controller.getState().lastAnswer.markdown, 'Answer 3')
  await t.controller.stop()
})

test('turning "explain by itself" off lists the question and leaves the answering to the person', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  assert.equal(t.api.calls.start[0].autoAnswer, false)
  t.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => t.controller.getState().questions.length === 1)
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(t.api.calls.answer.length, 0)
  assert.equal(t.controller.getState().questions[0].state, 'new')
  await t.controller.stop()
})

test('a screen that may be an assessment is listed but not answered by itself, and the person is told why', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true })
  t.api.script.send = async () => recognised({ signals: ['closed-book'] })
  t.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => t.controller.getState().questions.length === 1)
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(t.api.calls.answer.length, 0)
  assert.match(t.controller.getState().message, /may be an assessment/)
  await t.controller.stop()
})

test('the heartbeat to the app keeps going while a screen is being read, however long the read takes', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  let release
  t.api.script.send = () => new Promise((resolve) => (release = () => resolve(recognised())))
  t.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => t.api.calls.send.length === 1)
  assert.equal(t.controller.getState().reading, true, 'the panel can say a screen is being read')
  const before = t.native.calls.poll
  await until(() => t.native.calls.poll >= before + 10)
  assert.equal(t.controller.getState().watch.status, 'watching', 'still watching: the loop was not held up by the read')
  release()
  await until(() => t.controller.getState().questions.length === 1)
  assert.equal(t.controller.getState().reading, false)
  await t.controller.stop()
})

test('only one screen is sent at a time; a newer one replaces one that is still waiting, and the older native copy is let go', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  let release
  t.api.script.send = () => new Promise((resolve) => (release = () => resolve(recognised({ status: 'no-question', questions: [] }))))
  t.native.script.polls = [polled({ pending: pending('cap-1') }), polled({ pending: pending('cap-2') }), polled({ pending: pending('cap-3') }), polled()]
  await until(() => t.native.calls.poll >= 6)
  assert.equal(t.api.calls.send.length, 1, 'the first is being read; the others wait')
  assert.deepEqual(t.native.calls.export.map((e) => e.captureId), ['cap-1'], 'the waiting ones are not even exported yet')
  assert.ok(t.native.calls.discard.includes('cap-2'), 'the older of the two waiting screens was let go')
  t.api.script.send = async () => recognised({ status: 'no-question', questions: [] })
  release()
  await until(() => t.api.calls.send.length === 2)
  assert.deepEqual(t.native.calls.export.map((e) => e.captureId), ['cap-1', 'cap-3'], 'then the newest')
  await t.controller.stop()
})

test('a screen the server could not take yet is sent again after a wait, then given up on; the next change is read when it comes', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  let attempts = 0
  t.api.script.send = async () => {
    if (++attempts === 1) throw err(429, 'capture-rate-limited', 'Screens are coming too fast.', { retryAfterMs: 5000 })
    return recognised()
  }
  t.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => t.controller.getState().questions.length === 1)
  assert.equal(attempts, 2, 'sent again, and this time it was read')
  assert.ok(t.api.calls.send[1][1].bytes.length === 3, 'the same picture')
  await t.controller.stop()

  const failing = build()
  await failing.controller.init()
  await failing.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  failing.api.script.send = async () => {
    throw err(502, 'read-failed', 'The screen could not be read just now.')
  }
  failing.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => failing.controller.getState().lastRead?.status === 'held-back')
  assert.equal(failing.api.calls.send.length, 2, 'a read that failed at the model is sent again once, not again and again')
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(failing.api.calls.send.length, 2, 'and then it is let go')
  assert.equal(failing.controller.getState().tone, 'warn')
  assert.match(failing.controller.getState().message, /could not be read just now/, 'and the person is told, not left looking at a session that seems to do nothing')
  await failing.controller.stop()
})

test('when the reading service refuses the server (a key or an account problem) the person is told, screen reading pauses, and nothing is sent again', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  t.api.script.send = async () => {
    throw err(503, 'vision-unavailable', 'Screen reading is not available right now: the AI service behind it is not accepting requests. Nothing was read.')
  }
  t.native.script.polls = [polled({ pending: pending('cap-1') }), polled({ pending: pending('cap-2') }), polled()]
  await until(() => t.controller.getState().watch.status === 'paused')
  assert.equal(t.native.calls.pause, 1)
  assert.match(t.controller.getState().message, /not accepting requests/)
  assert.match(t.controller.getState().message, /Screen reading is paused/)
  assert.equal(t.controller.getState().tone, 'warn')
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(t.api.calls.send.length, 1, 'no retry of the same screen, and the screen that came next was not sent either')
  await t.controller.stop()
})

test('answering by itself can be switched on in an open session, answers what is waiting (never an assessment-looking screen), and off again', async () => {
  const t = build()
  await t.controller.init()
  // A session started without screen reading has answering by itself off; reading is turned on later, as the person did.
  t.api.script.start = async (o) => session({ sessionType: o.type, captureEnabled: false, autoAnswer: false })
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: false })
  assert.equal(t.controller.getState().session.autoAnswer, false)
  t.api.script.send = async () => recognised({ questions: [
    { id: 'q1', text: 'Explain third normal form.', options: [], task: 'explain', duplicate: false },
    { id: 'q2', text: 'Name the three anomalies.', options: [], task: 'explain', duplicate: false }
  ] })
  await t.controller.resumeWatching()
  t.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => t.controller.getState().questions.length === 2)
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(t.api.calls.answer.length, 0, 'nothing is answered while answering by itself is off')
  assert.deepEqual(t.controller.getState().questions.map((q) => q.state), ['new', 'new'])

  await t.controller.setAutoAnswer(true)
  assert.deepEqual(t.api.calls.update.at(-1), ['s1', { autoAnswer: true }])
  assert.equal(t.controller.getState().session.autoAnswer, true)
  await until(() => t.api.calls.answer.length === 2)
  assert.deepEqual(t.api.calls.answer.map((a) => a[0]).sort(), ['q1', 'q2'], 'what was waiting is answered')

  await t.controller.setAutoAnswer(false)
  assert.deepEqual(t.api.calls.update.at(-1), ['s1', { autoAnswer: false }])
  assert.equal(t.controller.getState().session.autoAnswer, false)
  assert.match(t.controller.getState().message, /wait for you to press/)
  await t.controller.stop()

  // A screen that looks like an assessment is not answered by switching it on either; and a refusal is shown, not hidden.
  const gated = build()
  await gated.controller.init()
  gated.api.script.start = async (o) => session({ sessionType: o.type, captureEnabled: true, autoAnswer: false })
  await gated.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  gated.api.script.send = async () => recognised({ signals: ['timed'] })
  gated.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => gated.controller.getState().questions.length === 1)
  await gated.controller.setAutoAnswer(true)
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(gated.api.calls.answer.length, 0)
  gated.api.sessions.update = async () => {
    throw err(400, 'invalid-input', 'Answering by itself needs screen reading to be on.')
  }
  await gated.controller.setAutoAnswer(true)
  assert.equal(gated.controller.getState().tone, 'error')
  assert.match(gated.controller.getState().message, /needs screen reading/)
  await gated.controller.stop()

  const restricted = build()
  await restricted.controller.init()
  restricted.api.script.start = async (o) => session({ sessionType: 'restricted', captureEnabled: false, autoAnswer: false })
  await restricted.controller.start({ type: 'restricted' })
  await restricted.controller.setAutoAnswer(true)
  assert.equal(restricted.api.calls.update.length, 0, 'a restricted session never answers by itself')
  await restricted.controller.stop()
})

test('a screen waiting to be sent again is replaced by a newer one, and let go when the session is paused or ends', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  let calls = 0
  t.api.script.send = async () => {
    calls++
    throw err(409, 'capture-busy', 'The last screen is still being read.')
  }
  t.native.script.polls = [polled({ pending: pending('cap-1') }), polled()]
  await until(() => calls === 1)
  t.api.script.send = async () => recognised({ status: 'no-question', questions: [] })
  t.native.script.polls = [polled({ pending: pending('cap-2') }), polled()]
  await until(() => t.api.calls.send.length === 2 && t.controller.getState().lastRead?.status === 'none')
  assert.deepEqual(t.native.calls.export.map((e) => e.captureId), ['cap-1', 'cap-2'])
  assert.equal(t.api.calls.send.length, 2, 'the newer screen was sent; the old one was not sent again')

  const paused = build()
  await paused.controller.init()
  await paused.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  paused.api.script.send = async () => {
    throw err(409, 'capture-busy', 'busy')
  }
  paused.native.script.polls = [polled({ pending: pending() }), polled()]
  await until(() => paused.api.calls.send.length === 1)
  await paused.controller.pause()
  paused.clock.t += 60_000
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(paused.api.calls.send.length, 1, 'nothing is sent again for a paused session')
  await t.controller.stop()
  await paused.controller.stop()
})

test('a screen that arrives after the session was paused is let go, not read', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true })
  await t.controller.pause()
  t.native.script.polls = [polled({ pending: pending('late') }), polled()]
  await until(() => t.native.calls.discard.includes('late'))
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(t.api.calls.send.length, 0, 'the picture that was in flight when pause was pressed is never sent')
  await t.controller.stop()
})

test('the panel is told what was read: questions found, the same screen again, nothing to read, or a screen that could not be understood', async () => {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, autoAnswer: false })
  const cases = [
    [{ status: 'recognised', questions: questions(2), context: {}, signals: [] }, 'questions', 2],
    [{ status: 'duplicate', questions: [{ ...questions(1)[0], id: 'q1', duplicate: true }], context: {}, signals: [] }, 'same', 0],
    [{ status: 'no-question', questions: [], context: null, signals: [] }, 'none', 0],
    [{ status: 'unclear', questions: [], context: null, signals: [] }, 'unclear', 0]
  ]
  for (const [i, [reply, status, count]] of cases.entries()) {
    t.api.script.send = async () => reply
    t.native.script.polls = [polled({ pending: pending(`cap-${i}`) }), polled()]
    await until(() => t.api.calls.send.length === i + 1 && t.controller.getState().lastRead?.status === status)
    assert.equal(t.controller.getState().lastRead.count, count, status)
    assert.ok(t.controller.getState().lastRead.at >= 1_000_000)
    for (let k = 0; k < 3; k++) await tick()
  }
  await t.controller.stop()
  assert.equal(t.controller.getState().lastRead, null, 'and it is forgotten when the session ends')
})

// ---- content intelligence in the page: segments, scrolling, revisits, cut-off questions, continuation --------------------------------

const segment = (id, kind, status, text, over = {}) => ({ id, kind, title: '', text, status, partial: null, related: [], seenCount: 1, questionId: null, ...over })
const screen = (segments, questions, over = {}) => ({
  captureId: `k-${Math.random()}`,
  status: segments.some((s) => s.status !== 'seen') ? 'recognised' : 'duplicate',
  questions,
  segments,
  layout: segments.length > 1 ? 'multiple' : 'single',
  arrival: 'new-screen',
  summary: { total: segments.length, new: segments.filter((s) => s.status === 'new').length, seen: segments.filter((s) => s.status === 'seen').length, grew: segments.filter((s) => s.status === 'grew').length, continued: segments.filter((s) => s.status === 'continued').length, partial: segments.filter((s) => s.partial).length },
  context: { courseId: 'c1' },
  signals: [],
  ...over
})
const qn = (id, text, over = {}) => ({ id, text, options: [], task: 'explain', duplicate: false, ...over })

async function study(over = {}) {
  const t = build()
  await t.controller.init()
  await t.controller.start({ type: 'study', courseId: 'c1', captureEnabled: true, ...over })
  return t
}
const feedScreen = async (t, reply, cap) => {
  t.api.script.send = async () => reply
  t.native.script.polls = [polled({ pending: pending(cap) }), polled()]
  await until(() => t.native.calls.discard.includes(cap))
  await until(() => t.controller.getState().lastRead !== null && !t.controller.getState().reading)
  for (let i = 0; i < 6; i++) await tick()
}

test('several segments of different kinds on one screen: all are listed, the questions among them are answered by themselves, the rest wait', async () => {
  const t = await study()
  t.api.script.answer = async () => answered({ questionId: `q${t.api.calls.answer.length}`, markdown: `Answer ${t.api.calls.answer.length}` })
  await feedScreen(t, screen([segment('g1', 'paragraph', 'new', 'Relational databases store data in tables.', { title: 'Tables' }), segment('g2', 'question', 'new', 'Explain a primary key.', { questionId: 'q1' }), segment('g3', 'code', 'new', 'SELECT * FROM t;'), segment('g4', 'question', 'new', 'Define a foreign key.', { questionId: 'q2' })], [qn('q1', 'Explain a primary key.'), qn('q2', 'Define a foreign key.')]), 'cap-1')
  const s = t.controller.getState()
  assert.deepEqual(s.content.map((c) => [c.kind, c.status]), [['paragraph', 'new'], ['question', 'new'], ['code', 'new'], ['question', 'new']])
  assert.deepEqual([s.lastRead.status, s.lastRead.arrival, s.lastRead.summary.new], ['questions', 'new-screen', 4])
  await until(() => t.exchanges.length === 2)
  assert.equal(t.api.calls.answer.length, 2, 'only the two questions were answered; the paragraph and the code were not')
  await t.controller.stop()
})

test('scrolling: what was seen is not listed or answered again, what appears is added and answered', async () => {
  const t = await study()
  await feedScreen(t, screen([segment('g1', 'paragraph', 'new', 'First paragraph about tables.'), segment('g2', 'question', 'new', 'Explain a primary key.')], [qn('q1', 'Explain a primary key.')]), 'cap-1')
  await until(() => t.api.calls.answer.length === 1)
  await feedScreen(t, screen([segment('g2', 'question', 'seen', 'Explain a primary key.', { seenCount: 2, questionId: 'q1' }), segment('g3', 'paragraph', 'new', 'A new paragraph about joins.'), segment('g4', 'question', 'new', 'Say what a join does.', { questionId: 'q2' })], [qn('q1', 'Explain a primary key.', { duplicate: true }), qn('q2', 'Say what a join does.')], { arrival: 'overlapping' }), 'cap-2')
  const s = t.controller.getState()
  assert.equal(s.content.length, 4, 'four segments in all, not six')
  assert.equal(s.content.find((c) => c.id === 'g2').seenCount, 2)
  assert.deepEqual(s.questions.map((q) => q.id), ['q1', 'q2'], 'q1 is not a second card')
  await until(() => t.api.calls.answer.length === 2)
  assert.deepEqual(t.api.calls.answer.map((a) => a[0]), ['q1', 'q2'], 'q1 once, q2 once')
  assert.equal(s.lastRead.arrival, 'overlapping')
  await t.controller.stop()
})

test('going back to content already seen (previous, a tab, scrolling up) processes nothing and says so', async () => {
  const t = await study()
  await feedScreen(t, screen([segment('g1', 'paragraph', 'new', 'Tables.'), segment('g2', 'question', 'new', 'Explain a primary key.', { questionId: 'q1' })], [qn('q1', 'Explain a primary key.')]), 'cap-1')
  await until(() => t.api.calls.answer.length === 1)
  const before = [t.controller.getState().questions.length, t.api.calls.answer.length, t.exchanges.length]
  await feedScreen(t, screen([segment('g1', 'paragraph', 'seen', 'Tables.', { seenCount: 2 }), segment('g2', 'question', 'seen', 'Explain a primary key.', { seenCount: 2, questionId: 'q1' })], [qn('q1', 'Explain a primary key.', { duplicate: true })], { arrival: 'revisit' }), 'cap-2')
  assert.deepEqual([t.controller.getState().questions.length, t.api.calls.answer.length, t.exchanges.length], before, 'no new card, no new answer, nothing new in the conversation')
  assert.deepEqual([t.controller.getState().lastRead.status, t.controller.getState().lastRead.arrival], ['same', 'revisit'])
  await t.controller.stop()
})

test('a screen with only material on it (no question) is organised and shown, and explaining it is the person\'s choice', async () => {
  const t = await study()
  await feedScreen(t, screen([segment('g1', 'paragraph', 'new', 'Normalisation organises tables so that each fact is stored once.', { title: 'Normal forms' })], []), 'cap-1')
  const s = t.controller.getState()
  assert.deepEqual([s.lastRead.status, s.content.length, s.questions.length, t.api.calls.answer.length, t.api.calls.ask.length], ['content', 1, 0, 0, 0], 'listed, nothing asked of the model')
  await t.controller.explainSegment('g1')
  assert.equal(t.api.calls.ask.length, 1)
  assert.match(t.api.calls.ask[0][0], /Explain this paragraph "Normal forms" from my screen:\nNormalisation organises tables/)
  await t.controller.stop()
})

test('a question cut off by the screen is held and not answered by itself; when the rest appears it is whole, updated, and answered once', async () => {
  const t = await study()
  await feedScreen(t, screen([segment('g1', 'question', 'new', 'Explain why a primary key must be', { questionId: 'q1', partial: { top: false, bottom: true } })], [qn('q1', 'Explain why a primary key must be', { partial: true })]), 'cap-1')
  let q = t.controller.getState().questions[0]
  assert.deepEqual([q.partial, q.state, t.api.calls.answer.length], [true, 'new', 0])
  assert.match(t.controller.getState().message, /cut off by the edge of the screen/)
  await feedScreen(t, screen([segment('g1', 'question', 'grew', 'Explain why a primary key must be unique and never empty.', { questionId: 'q1', completed: true })], [qn('q1', 'Explain why a primary key must be unique and never empty.', { duplicate: false, completed: true, partial: false })], { arrival: 'overlapping' }), 'cap-2')
  await until(() => t.api.calls.answer.length === 1)
  q = t.controller.getState().questions[0]
  assert.deepEqual([t.controller.getState().questions.length, q.partial, q.text], [1, false, 'Explain why a primary key must be unique and never empty.'])
  assert.equal(t.api.calls.answer[0][0], 'q1')
  assert.equal(t.exchanges.length, 1)
  await t.controller.stop()
})

test('content that continues across screens updates the one segment it belongs to', async () => {
  const t = await study()
  await feedScreen(t, screen([segment('g1', 'paragraph', 'new', 'The rate of change of velocity with time is called', { partial: { top: false, bottom: true } })], []), 'cap-1')
  await feedScreen(t, screen([segment('g1', 'paragraph', 'continued', 'The rate of change of velocity with time is called acceleration and is measured in metres per second squared.', { seenCount: 2 })], []), 'cap-2')
  const s = t.controller.getState()
  assert.deepEqual([s.content.length, s.content[0].status, s.content[0].partial], [1, 'continued', null])
  assert.match(s.content[0].text, /measured in metres per second squared/)
  assert.equal(s.lastRead.status, 'content')
  await t.controller.stop()
})

test('after a reload the session\'s content comes back, and a restricted session never offers to explain it', async () => {
  const t = build()
  t.api.script.current = { session: session({ captureEnabled: true }) }
  t.api.content = async () => ({ segments: [segment('g1', 'paragraph', 'seen', 'Tables hold rows and columns.', { seenCount: 3 })] })
  await t.controller.init()
  await until(() => t.controller.getState().content.length === 1)
  assert.equal(t.controller.getState().content[0].seenCount, 3)
})
