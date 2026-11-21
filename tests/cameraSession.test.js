import assert from 'node:assert/strict'
import test from 'node:test'
import { CameraApiError } from '../src/interfaces/camera/cameraApi.js'
import { CAMERA_STATES, createCameraSession } from '../src/interfaces/camera/cameraSession.js'
import { H, W, flat, page, withNoise } from './helpers/cameraFrames.js'

/**
 * The Smart Camera's flow as a state machine with no screen, no camera and no network: a scripted camera, a scripted
 * server and a clock the test moves. The real frame analysis runs, so "steady", "looks like text" and "a different
 * picture" are the real rules applied to synthetic pages.
 *
 *   READY -> QUESTION_DETECTED -> CAPTURING -> EXTRACTING -> ANALYSING -> ANSWER_READY -> WAITING_FOR_NEXT
 */

const STEP = 250

const QUESTION = (n, extra = {}) => ({
  status: 'new',
  questionId: `q${n}`,
  question: { text: `Question ${n}: what is ${n} + ${n}?`, options: [], type: 'short-answer', subject: 'maths', confidence: 0.95, hasDiagram: false },
  ...extra
})
const ANSWER = (n) => ({
  status: 'answered',
  questionId: `q${n}`,
  answer: { subject: 'maths', type: 'short-answer', answer: String(n + n), steps: [`${n} + ${n} = ${n + n}`], explanation: '', confidence: 'high', uncertainty: null },
  markdown: `**${n + n}**`
})

function fakeDevice() {
  const device = {
    frame: null,
    started: 0,
    stopped: 0,
    captures: [],
    failStart: null,
    failCapture: null,
    async start() {
      if (device.failStart) throw device.failStart
      device.started += 1
      return { width: W, height: H }
    },
    stop() {
      device.stopped += 1
    },
    sampleFrame: () => (device.frame ? { gray: device.frame, width: W, height: H } : null),
    async captureImage(options = {}) {
      if (device.failCapture) throw device.failCapture
      device.captures.push(options)
      return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' }
    },
    show(gray) {
      device.frame = gray
    }
  }
  return device
}

/** Scripted server. A queue entry is a response, a function of the call, or an Error to throw. */
function fakeApi({ visionConfigured = true, limits = { maxReads: 100, maxImageBytes: 1_500_000 } } = {}) {
  const api = {
    calls: { create: 0, read: [], answer: [], clear: [] },
    reads: [],
    answers: [],
    sessions: 0,
    async createSession() {
      api.calls.create += 1
      api.sessions += 1
      return { sessionId: `s${api.sessions}`, visionConfigured, limits }
    },
    async read(sessionId, image, { signal } = {}) {
      api.calls.read.push({ sessionId, image, signal })
      return next(api.reads, { sessionId, image })
    },
    async answer(sessionId, body, { signal } = {}) {
      api.calls.answer.push({ sessionId, body, signal })
      return next(api.answers, { sessionId, body })
    },
    async clear(sessionId) {
      api.calls.clear.push(sessionId)
      return true
    }
  }
  function next(queue, call) {
    const entry = queue.length > 1 ? queue.shift() : queue[0]
    if (entry === undefined) throw new Error('the test script has no response for this call')
    const value = typeof entry === 'function' ? entry(call) : entry
    if (value instanceof Error) throw value
    return value
  }
  return api
}

function build({ api = fakeApi(), device = fakeDevice(), options = {} } = {}) {
  const sleeps = []
  const session = createCameraSession({
    device,
    api,
    stableMs: 700,
    minGapMs: 2000,
    idleStopMs: 300_000,
    retryDelaysMs: [1000, 2500],
    sleep: async (ms) => void sleeps.push(ms),
    ...options
  })
  const phases = []
  session.subscribe((state) => {
    if (phases.at(-1) !== state.phase) phases.push(state.phase)
  })
  return { session, api, device, phases, sleeps, clock: { now: 0 } }
}

/** Puts a picture in front of the camera and lets time pass, a tick at a time, as the page would. Returns the new time. */
async function watch(rig, gray, { for: ms = 1500 } = {}) {
  rig.device.show(gray)
  const end = rig.clock.now + ms
  while (rig.clock.now <= end) {
    await rig.session.tick(rig.clock.now)
    rig.clock.now += STEP
  }
  return rig.clock.now
}

const started = async (rig) => {
  await rig.session.start({ now: rig.clock.now })
  return rig
}

// ---- starting -----------------------------------------------------------------------------------------------

test('starting asks for the camera, opens a server session, and is READY and visibly scanning', async () => {
  const rig = await started(build())
  const state = rig.session.getState()
  assert.equal(state.phase, CAMERA_STATES.READY)
  assert.equal(state.scanning, true, 'the scanning indicator is on whenever pictures may be sent')
  assert.equal(state.cameraOn, true)
  assert.deepEqual(rig.phases, ['IDLE', 'STARTING', 'READY'])
  assert.equal(rig.device.started, 1)
  assert.equal(rig.api.calls.create, 1)
})

test('a refused or missing camera is an error that says what to do, and nothing is left running', async () => {
  for (const [name, message] of [['NotAllowedError', /blocked|allow/i], ['NotFoundError', /no camera/i], ['NotReadableError', /in use|another/i], ['InsecureContextError', /secure|https/i]]) {
    const rig = build()
    rig.device.failStart = Object.assign(new Error(name), { name })
    await rig.session.start({ now: 0 })
    const state = rig.session.getState()
    assert.equal(state.phase, CAMERA_STATES.ERROR, name)
    assert.match(state.message, message, name)
    assert.equal(state.scanning, false)
    assert.equal(state.cameraOn, false)
    assert.equal(rig.api.calls.create, 0, 'no server session for a camera that never opened')
  }
})

test('without a vision service the camera opens but nothing is scanned or sent, and it says why', async () => {
  const rig = await started(build({ api: fakeApi({ visionConfigured: false }) }))
  const state = rig.session.getState()
  assert.equal(state.visionConfigured, false)
  assert.equal(state.scanning, false)
  assert.match(state.message, /not set up/i)
  await watch(rig, page(1))
  await rig.session.captureNow(rig.clock.now)
  assert.equal(rig.api.calls.read.length, 0)
})

test('starting twice does not open a second session', async () => {
  const rig = await started(build())
  await rig.session.start({ now: 0 })
  assert.equal(rig.device.started, 1)
  assert.equal(rig.api.calls.create, 1)
})

// ---- the pipeline ---------------------------------------------------------------------------------------------

test('a question held steady in front of the camera is read, answered, shown, and then it waits for the next', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))

  assert.deepEqual(rig.phases, [
    'IDLE', 'STARTING', 'READY', 'QUESTION_DETECTED', 'CAPTURING', 'EXTRACTING', 'ANALYSING', 'ANSWER_READY', 'WAITING_FOR_NEXT'
  ])
  const state = rig.session.getState()
  assert.equal(state.current.questionId, 'q1')
  assert.match(state.current.text, /Question 1/)
  assert.equal(state.answer.answer.answer, '2')
  assert.equal(state.history.length, 1)
  assert.equal(state.history[0].questionId, 'q1')
  assert.equal(rig.api.calls.read.length, 1)
  assert.equal(rig.api.calls.answer.length, 1)
  assert.deepEqual(rig.api.calls.answer[0].body, { questionId: 'q1' })
  assert.deepEqual(rig.api.calls.read[0].image.mimeType, 'image/jpeg')
})

/** The times (on the test's clock) at which pictures were sent to be read. */
function readTimes(rig) {
  const times = []
  const read = rig.api.read
  rig.api.read = async (...args) => {
    times.push(rig.clock.now)
    return read(...args)
  }
  return times
}
const DUPLICATE = { status: 'duplicate', questionId: 'q1', answer: ANSWER(1).answer }
const seconds = (ms) => Math.round(ms / 1000)

test('a scene that has not changed is not sent again straight away, and the same question is never answered twice', async () => {
  const rig = await started(build())
  const times = readTimes(rig)
  rig.api.reads = [QUESTION(1), DUPLICATE]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))
  assert.equal(times.length, 1)
  await watch(rig, withNoise(page(1), 5, 8), { for: 12_000 }) // the same page, noisier, for twelve seconds
  assert.equal(times.length, 1, 'no second send inside the first re-check interval')
  assert.equal(rig.api.calls.answer.length, 1)
  assert.equal(rig.session.getState().phase, CAMERA_STATES.WAITING_FOR_NEXT)
})

test('the camera cannot tell two questions in one layout apart, so an unchanged scene is re-checked now and then: the server has the last word', async () => {
  const rig = await started(build())
  const times = readTimes(rig)
  rig.api.reads = [QUESTION(1), QUESTION(2)] // the screen moved on to question 2, but the picture looks the same to the phone
  rig.api.answers = [ANSWER(1), ANSWER(2)]
  await watch(rig, page(1), { for: 20_000 })
  assert.equal(times.length, 2)
  assert.ok(seconds(times[1] - times[0]) >= 15, 'not before the first re-check interval')
  assert.deepEqual(rig.session.getState().history.map((h) => h.questionId), ['q2', 'q1'], 'and question 2 was not missed')
})

test('while nothing new is found the re-checks grow further apart, up to a limit; a new question starts them again', async () => {
  const rig = await started(build())
  const times = readTimes(rig)
  rig.api.reads = [QUESTION(1), DUPLICATE, DUPLICATE, DUPLICATE, DUPLICATE, QUESTION(2), DUPLICATE]
  rig.api.answers = [ANSWER(1), ANSWER(2)]
  await watch(rig, page(1), { for: 200_000 })
  const gaps = times.slice(1).map((t, i) => seconds(t - times[i]))
  assert.deepEqual(gaps.slice(0, 4), [15, 30, 60, 60], 'doubling, then held at the limit')

  const before = times.length
  await watch(rig, page(2), { for: 3000 }) // a visibly different page: sent as soon as the minimum gap allows
  assert.equal(times.length, before + 1)
  assert.equal(seconds(times.at(-1) - times.at(-2)) >= 2, true)
  assert.equal(rig.session.getState().history[0].questionId, 'q2')
  await watch(rig, page(2), { for: 20_000 })
  assert.equal(seconds(times.at(-1) - times.at(-2)), 15, 'after a new question the re-checks start again at the first interval')
})

test('re-checks that find nothing new do not keep the camera switched on: it still switches itself off after the quiet spell', async () => {
  const rig = await started(build({ options: { idleStopMs: 90_000 } }))
  rig.api.reads = [QUESTION(1), DUPLICATE]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1), { for: 120_000 })
  assert.equal(rig.session.getState().phase, CAMERA_STATES.IDLE)
  assert.equal(rig.device.stopped, 1)
  assert.match(rig.session.getState().message, /switched off/i)
})

test('a different page is a new question: it is read and answered, and both are kept in the history, newest first', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1), QUESTION(2)]
  rig.api.answers = [ANSWER(1), ANSWER(2)]
  await watch(rig, page(1))
  await watch(rig, page(2), { for: 3000 })
  assert.equal(rig.api.calls.read.length, 2)
  assert.deepEqual(rig.session.getState().history.map((h) => h.questionId), ['q2', 'q1'])
  assert.equal(rig.session.getState().phase, CAMERA_STATES.WAITING_FOR_NEXT)
})

test('while the camera is moving nothing is sent; once it settles on the page, it is', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  for (let i = 0; i < 12; i++) {
    rig.device.show(page(10 + i)) // a different picture every tick: the phone is being waved about
    await rig.session.tick(rig.clock.now)
    rig.clock.now += STEP
  }
  assert.equal(rig.api.calls.read.length, 0)
  assert.equal(rig.session.getState().phase, CAMERA_STATES.READY)
  await watch(rig, page(1))
  assert.equal(rig.api.calls.read.length, 1)
})

test('a scene that does not look like text is never sent', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1)]
  await watch(rig, flat(120), { for: 5000 })
  await watch(rig, withNoise(flat(120), 3, 5), { for: 5000 })
  assert.equal(rig.api.calls.read.length, 0)
  assert.match(rig.session.getState().message, /point/i)
})

test('a read starts only after the minimum gap since the last one, even for a different page', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1), QUESTION(2)]
  rig.api.answers = [ANSWER(1), ANSWER(2)]
  await watch(rig, page(1))
  const firstReadAt = rig.clock.now
  await watch(rig, page(2), { for: 900 }) // steady, but only about a second after the last read
  assert.equal(rig.api.calls.read.length, 1, 'too soon')
  await watch(rig, page(2), { for: 2500 })
  assert.equal(rig.api.calls.read.length, 2)
  assert.ok(rig.clock.now - firstReadAt >= 2000)
})

// ---- what the server can answer instead of a new question -------------------------------------------------------

test('a question the server already has is not answered again, and the same picture is not sent again', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1), { status: 'duplicate', questionId: 'q1', answer: ANSWER(1).answer }]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))
  await watch(rig, page(2), { for: 3000 }) // a different picture, but it turns out to be the same question
  assert.equal(rig.api.calls.read.length, 2)
  assert.equal(rig.api.calls.answer.length, 1, 'no second answer')
  assert.equal(rig.session.getState().history.length, 1)
  assert.match(rig.session.getState().message, /already/i)
  await watch(rig, page(2), { for: 10_000 })
  assert.equal(rig.api.calls.read.length, 2, 'and it does not ask again about the picture it has just been told about')
})

test('a picture that is not a question, or too unclear to read, is remembered and not sent again until the scene changes', async () => {
  for (const [status, reason, message] of [['not-a-question', 'It is a menu.', /not a question|menu/i], ['unclear', 'The text is blurred.', /unclear|blurred|steady/i]]) {
    const rig = await started(build())
    rig.api.reads = [{ status, reason }]
    await watch(rig, page(1))
    assert.equal(rig.api.calls.read.length, 1, status)
    assert.equal(rig.api.calls.answer.length, 0)
    assert.match(rig.session.getState().message, message, status)
    assert.equal(rig.session.getState().phase, CAMERA_STATES.WAITING_FOR_NEXT)
    await watch(rig, page(1), { for: 10_000 })
    assert.equal(rig.api.calls.read.length, 1, 'the same picture is not sent again')
    rig.api.reads = [QUESTION(2)]
    rig.api.answers = [ANSWER(2)]
    await watch(rig, page(2), { for: 3000 })
    assert.equal(rig.api.calls.read.length, 2, 'a different picture is')
  }
})

// ---- reviewing before it is answered -------------------------------------------------------------------------

test('in review mode the extracted question waits for a tap; confirming sends the (possibly corrected) text', async () => {
  const rig = await started(build({ options: { auto: false } }))
  rig.api.reads = [QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))
  let state = rig.session.getState()
  assert.equal(state.phase, CAMERA_STATES.AWAITING_CONFIRMATION)
  assert.equal(rig.api.calls.answer.length, 0, 'nothing is answered until the person says so')
  assert.match(state.current.text, /Question 1/)

  await rig.session.confirm({ text: 'Question 1: what is 1 + 1 ?' })
  state = rig.session.getState()
  assert.equal(rig.api.calls.answer.length, 1)
  assert.deepEqual(rig.api.calls.answer[0].body, { questionId: 'q1', text: 'Question 1: what is 1 + 1 ?' })
  assert.equal(state.phase, CAMERA_STATES.WAITING_FOR_NEXT)
  assert.equal(state.history.length, 1)
})

test('skipping an extracted question discards it without an answer, and that picture is not sent again', async () => {
  const rig = await started(build({ options: { auto: false } }))
  rig.api.reads = [QUESTION(1)]
  await watch(rig, page(1))
  rig.session.skip()
  assert.equal(rig.session.getState().phase, CAMERA_STATES.WAITING_FOR_NEXT)
  assert.equal(rig.session.getState().current, null)
  await watch(rig, page(1), { for: 6000 })
  assert.equal(rig.api.calls.read.length, 1)
  assert.equal(rig.api.calls.answer.length, 0)
})

test('automatic mode can be switched while running, and the setting is reported', async () => {
  const rig = await started(build())
  assert.equal(rig.session.getState().auto, true, 'automatic is the default')
  rig.session.setAuto(false)
  assert.equal(rig.session.getState().auto, false)
  rig.api.reads = [QUESTION(1)]
  await watch(rig, page(1))
  assert.equal(rig.session.getState().phase, CAMERA_STATES.AWAITING_CONFIRMATION)
})

// ---- manual capture, pause, stop --------------------------------------------------------------------------------

test('manual capture reads what the camera sees now, steady or not, as a fallback', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  rig.device.show(page(1))
  await rig.session.tick(0)
  await rig.session.captureNow(STEP) // no time to settle, no gap needed
  assert.equal(rig.api.calls.read.length, 1)
  assert.equal(rig.session.getState().history.length, 1)
})

test('pause stops scanning and sending, and drops a request in flight; resume carries on', async () => {
  const rig = await started(build())
  let release
  rig.api.reads = [
    () =>
      new Promise((resolve, reject) => {
        release = () => resolve(QUESTION(1))
        rig.api.calls.read.at(-1).signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
  ]
  rig.device.show(page(1))
  let ticking
  for (let t = 0; t <= 1500; t += STEP) ticking = rig.session.tick(t)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(rig.session.getState().phase, CAMERA_STATES.EXTRACTING)

  rig.session.pause()
  assert.equal(rig.api.calls.read[0].signal.aborted, true, 'the request in flight is abandoned')
  await ticking
  const paused = rig.session.getState()
  assert.equal(paused.phase, CAMERA_STATES.PAUSED)
  assert.equal(paused.scanning, false, 'a paused camera is plainly not scanning')
  assert.equal(paused.cameraOn, true)
  assert.equal(rig.api.calls.answer.length, 0, 'the abandoned read produces no answer')

  const callsBefore = rig.api.calls.read.length
  await watch(rig, page(2), { for: 4000 })
  assert.equal(rig.api.calls.read.length, callsBefore, 'nothing is sent while paused')

  rig.api.reads = [QUESTION(2)]
  rig.api.answers = [ANSWER(2)]
  rig.session.resume()
  await watch(rig, page(2), { for: 4000 })
  assert.equal(rig.session.getState().history[0].questionId, 'q2')
  release?.()
})

test('resuming after a long pause starts the quiet-spell clock afresh, instead of switching the camera off at once', async () => {
  const rig = await started(build({ options: { idleStopMs: 10_000 } }))
  rig.session.pause(1000)
  rig.session.resume(9_000) // paused for 8 s: inside the limit
  rig.device.show(flat(100))
  await rig.session.tick(9_250)
  assert.equal(rig.session.getState().phase, CAMERA_STATES.READY)
  assert.equal(rig.device.stopped, 0)
  await rig.session.tick(18_000) // 9 s after the resume: still inside it
  assert.equal(rig.session.getState().phase, CAMERA_STATES.READY)
  await rig.session.tick(19_500) // more than 10 s of nothing since the resume
  assert.equal(rig.session.getState().phase, CAMERA_STATES.IDLE)
})

test('a camera left paused is switched off after the same quiet spell, so it is never open forever', async () => {
  const rig = await started(build({ options: { idleStopMs: 10_000 } }))
  rig.device.show(flat(100))
  rig.session.pause(2_000)
  await rig.session.tick(8_000)
  assert.equal(rig.session.getState().phase, CAMERA_STATES.PAUSED, 'not yet')
  assert.equal(rig.device.stopped, 0)
  await rig.session.tick(12_500)
  const state = rig.session.getState()
  assert.equal(state.phase, CAMERA_STATES.IDLE)
  assert.equal(state.cameraOn, false)
  assert.equal(rig.device.stopped, 1)
  assert.match(state.message, /paused/i)
})

test('stop turns the camera off, ends the scanning, and later ticks do nothing', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))
  rig.session.stop()
  const state = rig.session.getState()
  assert.equal(state.phase, CAMERA_STATES.IDLE)
  assert.equal(state.cameraOn, false)
  assert.equal(state.scanning, false)
  assert.equal(rig.device.stopped, 1)
  const reads = rig.api.calls.read.length
  await watch(rig, page(2), { for: 4000 })
  assert.equal(rig.api.calls.read.length, reads)
  assert.equal(state.history.length, 1, 'the history of the session stays readable after stopping')
})

test('the camera switches itself off after a quiet spell, and says so', async () => {
  const rig = await started(build({ options: { idleStopMs: 10_000 } }))
  await watch(rig, flat(100), { for: 11_000 })
  const state = rig.session.getState()
  assert.equal(state.phase, CAMERA_STATES.IDLE)
  assert.equal(rig.device.stopped, 1)
  assert.match(state.message, /switched off|stopped/i)
})

// ---- trouble ---------------------------------------------------------------------------------------------------

test('a dropped connection is retried with a growing pause, then the question goes through', async () => {
  const rig = await started(build())
  const down = () => new CameraApiError('offline', { status: 0, code: 'network' })
  rig.api.reads = [down(), down(), QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))
  assert.equal(rig.api.calls.read.length, 3)
  assert.deepEqual(rig.sleeps, [1000, 2500])
  assert.equal(rig.session.getState().history.length, 1)
  assert.notEqual(rig.session.getState().phase, CAMERA_STATES.ERROR)
})

test('a server that keeps failing ends in an error the person can retry, and a manual capture retries', async () => {
  const rig = await started(build())
  rig.api.reads = [new CameraApiError('boom', { status: 502, code: 'request-error' })]
  await watch(rig, page(1))
  assert.equal(rig.api.calls.read.length, 3, 'one try and two retries')
  let state = rig.session.getState()
  assert.equal(state.phase, CAMERA_STATES.ERROR)
  assert.equal(state.canRetry, true)
  assert.equal(state.scanning, false)

  rig.api.reads = [QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  await rig.session.captureNow(rig.clock.now)
  state = rig.session.getState()
  assert.equal(state.history.length, 1)
  assert.notEqual(state.phase, CAMERA_STATES.ERROR)
})

test('a busy server (429) is waited for as long as it asks', async () => {
  const rig = await started(build())
  rig.api.reads = [new CameraApiError('slow down', { status: 429, code: 'camera-rate-limited', retryAfterMs: 4000 }), QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))
  assert.deepEqual(rig.sleeps, [4000])
  assert.equal(rig.session.getState().history.length, 1)
})

test('being told to slow down (429) does not use up a retry: a failing server still gets all its attempts', async () => {
  const rig = await started(build()) // retries after 1 s and 2.5 s
  const fail = new CameraApiError('boom', { status: 502, code: 'read-failed' })
  rig.api.reads = [fail, new CameraApiError('slow down', { status: 429, code: 'camera-rate-limited', retryAfterMs: 1000 }), fail]
  await watch(rig, page(1))
  assert.equal(rig.api.calls.read.length, 4, 'the first try and both retries, and the one the server turned away')
  assert.deepEqual(rig.sleeps, [1000, 1000, 2500])
  assert.equal(rig.session.getState().phase, CAMERA_STATES.ERROR)
})

test('a server that keeps saying "slow down" is not waited on for ever', async () => {
  const rig = await started(build())
  rig.api.reads = [new CameraApiError('slow down', { status: 429, code: 'camera-rate-limited', retryAfterMs: 1000 })]
  await watch(rig, page(1))
  assert.equal(rig.session.getState().phase, CAMERA_STATES.ERROR)
  assert.ok(rig.api.calls.read.length <= 6, `${rig.api.calls.read.length} calls`)
})

test('refusals that retrying cannot fix stop at once, with an explanation', async () => {
  for (const [error, expected] of [
    [new CameraApiError('no vision', { status: 503, code: 'vision-not-configured' }), /not set up/i],
    [new CameraApiError('sign in', { status: 401, code: 'assistant-auth-required' }), /sign in/i],
    [new CameraApiError('limit', { status: 429, code: 'session-limit' }), /limit/i]
  ]) {
    const rig = await started(build())
    rig.api.reads = [error]
    await watch(rig, page(1))
    assert.equal(rig.api.calls.read.length, 1, error.code)
    const state = rig.session.getState()
    assert.equal(state.phase, CAMERA_STATES.ERROR, error.code)
    assert.match(state.message, expected, error.code)
    assert.equal(state.canRetry, error.code === 'assistant-auth-required', 'only signing in again helps')
    assert.equal(rig.sleeps.length, 0)
  }
})

test('a picture that is too large is retaken smaller, once', async () => {
  const rig = await started(build())
  rig.api.reads = [new CameraApiError('big', { status: 413, code: 'image-too-large' }), QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))
  assert.equal(rig.device.captures.length, 2)
  assert.ok(rig.device.captures[1].maxEdge < (rig.device.captures[0].maxEdge ?? Infinity), 'the second capture is smaller')
  assert.equal(rig.session.getState().history.length, 1)
})

test('a server that has forgotten the session (a restart) gets a new one and the read is repeated', async () => {
  const rig = await started(build())
  rig.api.reads = [new CameraApiError('gone', { status: 404, code: 'session-not-found' }), QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))
  assert.equal(rig.api.calls.create, 2)
  assert.deepEqual(rig.api.calls.read.map((c) => c.sessionId), ['s1', 's2'])
  assert.equal(rig.session.getState().history.length, 1)
})

test('a failing capture is an error, not a crash', async () => {
  const rig = await started(build())
  rig.device.failCapture = new Error('the camera stopped')
  await watch(rig, page(1))
  assert.equal(rig.session.getState().phase, CAMERA_STATES.ERROR)
  assert.equal(rig.api.calls.read.length, 0)
})

test('an answer that fails keeps the question, and the person can ask for the answer again', async () => {
  const rig = await started(build({ options: { retryDelaysMs: [] } }))
  rig.api.reads = [QUESTION(1)]
  rig.api.answers = [new CameraApiError('model down', { status: 502, code: 'request-error' }), ANSWER(1)]
  await watch(rig, page(1))
  let state = rig.session.getState()
  assert.equal(state.phase, CAMERA_STATES.ERROR)
  assert.match(state.current.text, /Question 1/, 'the question that was read is not lost')
  assert.equal(state.canRetry, true)
  await rig.session.confirm({})
  state = rig.session.getState()
  assert.equal(state.history.length, 1)
  assert.equal(rig.api.calls.read.length, 1, 'the picture is not read again to retry the answer')
})

test('each failure is described as what it was: the picture not read, the answer not worked out, or the server not reached', async () => {
  const modelFailure = (code) => new CameraApiError('upstream', { status: 502, code })
  const cases = [
    ['read', modelFailure('read-failed'), /picture could not be read/i],
    ['read', new CameraApiError('offline', { status: 0, code: 'network' }), /could not reach the server/i],
    ['answer', modelFailure('answer-failed'), /answer could not be worked out/i],
    ['answer', new CameraApiError('offline', { status: 0, code: 'network' }), /could not reach the server/i]
  ]
  for (const [what, failure, expected] of cases) {
    const rig = await started(build({ options: { retryDelaysMs: [] } }))
    if (what === 'read') rig.api.reads = [failure]
    else {
      rig.api.reads = [QUESTION(1)]
      rig.api.answers = [failure]
    }
    await watch(rig, page(1))
    const state = rig.session.getState()
    assert.equal(state.phase, CAMERA_STATES.ERROR, `${what} ${failure.code}`)
    assert.match(state.message, expected, `${what} ${failure.code}`)
    assert.equal(state.canRetry, true)
    assert.equal(state.tone, 'error')
  }
})

test('"try again" does the one thing that failed: the camera, the picture, or the answer', async () => {
  // the camera would not start
  const cam = build()
  cam.device.failStart = Object.assign(new Error('NotAllowedError'), { name: 'NotAllowedError' })
  await cam.session.start({ now: 0 })
  assert.equal(cam.session.getState().phase, CAMERA_STATES.ERROR)
  cam.device.failStart = null
  await cam.session.retry(1000)
  assert.equal(cam.session.getState().phase, CAMERA_STATES.READY)
  assert.equal(cam.session.getState().cameraOn, true)

  // the picture could not be read
  const pic = await started(build({ options: { retryDelaysMs: [] } }))
  pic.api.reads = [new CameraApiError('boom', { status: 502, code: 'request-error' }), QUESTION(1)]
  pic.api.answers = [ANSWER(1)]
  await watch(pic, page(1))
  assert.equal(pic.session.getState().phase, CAMERA_STATES.ERROR)
  await pic.session.retry(pic.clock.now)
  assert.equal(pic.session.getState().history.length, 1, 'a fresh picture was taken and read')
  assert.equal(pic.api.calls.read.length, 2)

  // the answer could not be worked out
  const ans = await started(build({ options: { retryDelaysMs: [] } }))
  ans.api.reads = [QUESTION(1)]
  ans.api.answers = [new CameraApiError('model down', { status: 502, code: 'request-error' }), ANSWER(1)]
  await watch(ans, page(1))
  assert.equal(ans.session.getState().phase, CAMERA_STATES.ERROR)
  await ans.session.retry(ans.clock.now)
  assert.equal(ans.session.getState().history.length, 1)
  assert.equal(ans.api.calls.read.length, 1, 'the picture is not read again to retry the answer')
})

test('"try again" does nothing when nothing can be retried', async () => {
  const rig = await started(build())
  await rig.session.retry(0) // not in an error
  assert.equal(rig.session.getState().phase, CAMERA_STATES.READY)
  assert.equal(rig.api.calls.read.length, 0)

  const none = await started(build({ api: fakeApi({ visionConfigured: false }) }))
  none.api.reads = [new CameraApiError('no vision', { status: 503, code: 'vision-not-configured' })]
  await none.session.captureNow(0)
  await none.session.retry(0)
  assert.equal(none.api.calls.read.length, 0, 'a refusal that retrying cannot change is not retried')
})

// ---- limits, history, observers ------------------------------------------------------------------------------

test('the session\'s read limit is respected, automatic or manual', async () => {
  const rig = await started(build({ api: fakeApi({ limits: { maxReads: 2, maxImageBytes: 1_500_000 } }) }))
  rig.api.reads = [QUESTION(1), QUESTION(2), QUESTION(3)]
  rig.api.answers = [ANSWER(1), ANSWER(2), ANSWER(3)]
  await watch(rig, page(1))
  await watch(rig, page(2), { for: 3000 })
  await watch(rig, page(3), { for: 3000 })
  await rig.session.captureNow(rig.clock.now)
  assert.equal(rig.api.calls.read.length, 2)
  const state = rig.session.getState()
  assert.equal(state.limitReached, true)
  assert.match(state.message, /limit/i)
  assert.equal(state.scanning, false, 'a session at its limit is not scanning')
})

test('clearing the history removes it here and on the server, and the next question starts a fresh session', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1), QUESTION(2)]
  rig.api.answers = [ANSWER(1), ANSWER(2)]
  await watch(rig, page(1))
  await rig.session.clearHistory()
  let state = rig.session.getState()
  assert.deepEqual(rig.api.calls.clear, ['s1'])
  assert.equal(state.history.length, 0)
  assert.equal(state.current, null)
  assert.equal(state.answer, null)

  await watch(rig, page(2), { for: 3000 })
  assert.equal(rig.api.calls.create, 2, 'a new server session')
  assert.equal(rig.api.calls.read.at(-1).sessionId, 's2')
  state = rig.session.getState()
  assert.equal(state.history.length, 1)
})

test('a history that cannot be cleared on the server says so, keeps what it has, and scanning carries on', async () => {
  const rig = await started(build())
  rig.api.reads = [QUESTION(1)]
  rig.api.answers = [ANSWER(1)]
  await watch(rig, page(1))
  rig.api.clear = async () => {
    throw new Error('server down')
  }
  await rig.session.clearHistory()
  const state = rig.session.getState()
  assert.equal(state.history.length, 1, 'nothing is forgotten here that the server still has')
  assert.equal(state.phase, CAMERA_STATES.WAITING_FOR_NEXT, 'not turned into an error of the whole session')
  assert.match(state.message, /could not clear/i)
  assert.equal(state.tone, 'error')
})

test('observers get every change and can stop listening', async () => {
  const rig = build()
  const seen = []
  const stop = rig.session.subscribe((state) => seen.push(state.phase))
  await rig.session.start({ now: 0 })
  assert.ok(seen.includes('READY'))
  stop()
  const count = seen.length
  rig.session.stop()
  assert.equal(seen.length, count)
})

test('the states are the ones in the brief, frozen', () => {
  for (const name of ['READY', 'QUESTION_DETECTED', 'CAPTURING', 'EXTRACTING', 'ANALYSING', 'ANSWER_READY', 'WAITING_FOR_NEXT']) {
    assert.equal(CAMERA_STATES[name], name)
  }
  assert.equal(Object.isFrozen(CAMERA_STATES), true)
})
