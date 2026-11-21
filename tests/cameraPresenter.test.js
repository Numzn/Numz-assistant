import assert from 'node:assert/strict'
import test from 'node:test'
import { CAMERA_STATES as S } from '../src/interfaces/camera/cameraSession.js'
import { presentCamera } from '../src/interfaces/camera/cameraPresenter.js'

/**
 * What the Smart Camera's screen shows and allows, as a pure function of the session's state. The DOM only draws
 * this; every rule about when a button is available, what the indicator says and how an answer reads is here, where
 * it can be tested without a browser.
 */

const base = (extra = {}) => ({
  phase: S.IDLE,
  auto: true,
  scanning: false,
  cameraOn: false,
  visionConfigured: true,
  limitReached: false,
  canRetry: false,
  message: '',
  tone: 'info',
  sessionId: null,
  current: null,
  answer: null,
  history: [],
  counts: { reads: 0, answers: 0, duplicates: 0, skipped: 0 },
  ...extra
})
const on = (phase, extra = {}) => base({ phase, cameraOn: true, scanning: phase !== S.PAUSED && phase !== S.ERROR && phase !== S.STARTING && phase !== S.IDLE, sessionId: 's1', ...extra })

const enabled = (view) =>
  Object.entries(view.controls)
    .filter(([key, value]) => value === true && key !== 'auto')
    .map(([key]) => key)
    .sort()

const QUESTION = { questionId: 'q1', text: 'What is 6 x 7?', options: [], type: 'calculation', subject: 'maths', confidence: 0.95, hasDiagram: false }
const ANSWER = { subject: 'maths', type: 'calculation', answer: '42', steps: ['6 x 7 = 42'], explanation: 'Multiply.', confidence: 'high', uncertainty: null }

// ---- the indicator: whether pictures are being scanned or sent must never be unclear ---------------------------------

test('camera off: the indicator says so and only starting is possible', () => {
  const view = presentCamera(base())
  assert.equal(view.indicator.kind, 'off')
  assert.match(view.indicator.label, /camera off/i)
  assert.deepEqual(enabled(view), ['start'])
  assert.equal(view.showPlaceholder, true)
})

test('watching for a question: scanning is announced, and pause, stop and manual capture are on offer', () => {
  for (const phase of [S.READY, S.WAITING_FOR_NEXT]) {
    const view = presentCamera(on(phase))
    assert.equal(view.indicator.kind, 'scanning', phase)
    assert.match(view.indicator.label, /scanning/i)
    assert.deepEqual(enabled(view), ['capture', 'pause', 'stop'], phase)
    assert.equal(view.showPlaceholder, false)
  }
})

test('while a picture is on its way and while the answer is worked out, the screen says which, and capture is off', () => {
  const sending = presentCamera(on(S.EXTRACTING))
  assert.equal(sending.indicator.kind, 'sending')
  assert.match(sending.indicator.label, /sent/i)
  assert.match(sending.busy.label, /reading the question/i)

  const working = presentCamera(on(S.ANALYSING))
  assert.equal(working.indicator.kind, 'working')
  assert.match(working.busy.label, /answer/i)

  const taking = presentCamera(on(S.CAPTURING))
  assert.match(taking.busy.label, /picture/i)
  for (const view of [sending, working, taking]) {
    assert.equal(view.controls.capture, false)
    assert.equal(view.controls.pause, true)
    assert.equal(view.controls.stop, true)
  }
  assert.equal(presentCamera(on(S.READY)).busy, null)
})

test('paused: the indicator says nothing is sent, and the person can resume or stop', () => {
  const view = presentCamera(on(S.PAUSED))
  assert.equal(view.indicator.kind, 'paused')
  assert.match(view.indicator.label, /nothing is sent/i)
  assert.deepEqual(enabled(view), ['resume', 'stop'])
})

test('in review mode the question waits for the person, who can answer it, skip it, pause or stop', () => {
  const view = presentCamera(on(S.AWAITING_CONFIRMATION, { current: QUESTION, auto: false }))
  assert.equal(view.indicator.kind, 'review')
  assert.deepEqual(enabled(view), ['confirm', 'pause', 'skip', 'stop'])
  assert.equal(view.question.editable, true)
  assert.equal(view.question.heading, 'Check the question')
  assert.equal(view.controls.auto, false)
})

test('an error with a retry offers "try again" and stopping; an error with no camera offers the same', () => {
  const failed = presentCamera(on(S.ERROR, { canRetry: true, message: 'Could not reach the server.', tone: 'error' }))
  assert.equal(failed.indicator.kind, 'error')
  assert.match(failed.indicator.label, /not scanning/i)
  assert.deepEqual(enabled(failed), ['retry', 'stop'])
  assert.equal(failed.status.tone, 'error')

  const noCamera = presentCamera(base({ phase: S.ERROR, canRetry: true, message: 'The camera is blocked.', tone: 'error' }))
  assert.equal(noCamera.indicator.kind, 'off')
  assert.deepEqual(enabled(noCamera), ['retry'])

  const final = presentCamera(base({ phase: S.ERROR, canRetry: false, message: 'Sign in again.', tone: 'error' }))
  assert.deepEqual(enabled(final), ['start'], 'nothing to retry: start over')
})

test('with no vision service the indicator says nothing is being scanned, and capture is off', () => {
  const view = presentCamera(on(S.READY, { visionConfigured: false, scanning: false }))
  assert.equal(view.indicator.kind, 'unavailable')
  assert.match(view.indicator.label, /not scanning/i)
  assert.equal(view.controls.capture, false)
})

test('at the session limit scanning stops, and the way out is clearing the history', () => {
  const view = presentCamera(on(S.ERROR, { limitReached: true, canRetry: false, scanning: false, history: [{ questionId: 'q1', text: 'x', answer: ANSWER, markdown: '' }], counts: { reads: 100, answers: 100, duplicates: 0, skipped: 0 } }))
  assert.equal(view.indicator.kind, 'unavailable')
  assert.match(view.indicator.label, /limit/i)
  assert.equal(view.controls.capture, false)
  assert.equal(view.controls.clear, true)
  assert.equal(view.controls.clearToContinue, true, 'the way out is among the camera controls, not only further down the page')
})

test('the clear-and-continue control appears only at the limit', () => {
  assert.equal(presentCamera(on(S.READY, { history: [{ questionId: 'q1', text: 'x', answer: ANSWER, markdown: '' }] })).controls.clearToContinue, false)
  assert.equal(presentCamera(on(S.ERROR, { canRetry: true, message: 'offline', tone: 'error' })).controls.clearToContinue, false)
  assert.equal(presentCamera(base({ limitReached: true })).controls.clearToContinue, false, 'with the camera off there is nothing to continue')
})

test('starting the camera is shown as starting, with nothing else on offer but stopping', () => {
  const view = presentCamera(base({ phase: S.STARTING, message: 'Starting the camera…' }))
  assert.equal(view.indicator.kind, 'starting')
  assert.deepEqual(enabled(view), ['stop'])
})

test('clearing is offered only when there is something to clear', () => {
  assert.equal(presentCamera(on(S.READY)).controls.clear, false)
  assert.equal(presentCamera(on(S.READY, { counts: { reads: 1, answers: 0, duplicates: 0, skipped: 0 } })).controls.clear, true)
  assert.equal(presentCamera(on(S.READY, { history: [{ questionId: 'q1', text: 'x', answer: ANSWER, markdown: '' }] })).controls.clear, true)
})

// ---- the question ----------------------------------------------------------------------------------------------

test('a question is shown with its kind and subject, a note when it needs a figure, and a warning when it was hard to read', () => {
  const view = presentCamera(on(S.ANALYSING, { current: { ...QUESTION, type: 'multiple-choice', subject: 'physics', confidence: 0.6, hasDiagram: true, options: [{ label: 'A', text: 'Mars' }, { label: 'B', text: 'Jupiter' }] } }))
  assert.deepEqual(view.question.tags, ['Multiple choice', 'Physics'])
  assert.deepEqual(view.question.options, [{ label: 'A', text: 'Mars' }, { label: 'B', text: 'Jupiter' }])
  assert.equal(view.question.lowConfidence, true)
  assert.match(view.question.notes.join(' '), /figure|table/i)
  assert.match(view.question.notes.join(' '), /hard to read|check/i)
  assert.equal(view.question.editable, false)
  assert.equal(view.question.heading, 'Question')

  const clear = presentCamera(on(S.WAITING_FOR_NEXT, { current: QUESTION }))
  assert.equal(clear.question.lowConfidence, false)
  assert.deepEqual(clear.question.notes, [])
  assert.deepEqual(clear.question.tags, ['Calculation', 'Maths'])
})

test('an unknown question type or no subject adds no empty tag', () => {
  const view = presentCamera(on(S.WAITING_FOR_NEXT, { current: { ...QUESTION, type: 'other', subject: '' } }))
  assert.deepEqual(view.question.tags, [])
  assert.equal(presentCamera(on(S.READY)).question, null)
})

// ---- the answer --------------------------------------------------------------------------------------------------

test('an answer reads as the answer, the steps, the explanation, and how sure it is', () => {
  const view = presentCamera(on(S.WAITING_FOR_NEXT, { current: QUESTION, answer: { status: 'answered', questionId: 'q1', answer: ANSWER, markdown: '**42**' } }))
  assert.deepEqual(view.answer, {
    headline: '42',
    steps: ['6 x 7 = 42'],
    explanation: 'Multiply.',
    confidence: 'high',
    confidenceLabel: 'High confidence',
    unsure: false,
    uncertainty: null
  })
})

test('an unsure answer says so plainly and carries what it was unsure of', () => {
  const view = presentCamera(on(S.WAITING_FOR_NEXT, { answer: { answer: { ...ANSWER, confidence: 'low', uncertainty: 'The picture was blurred.' } } }))
  assert.equal(view.answer.unsure, true)
  assert.equal(view.answer.confidenceLabel, 'Low confidence')
  assert.equal(view.answer.uncertainty, 'The picture was blurred.')
  assert.equal(presentCamera(on(S.WAITING_FOR_NEXT, { answer: { answer: { ...ANSWER, confidence: 'medium' } } })).answer.unsure, true, 'medium is also "check it"')
})

test('a reply that was not in the expected format is shown as text, with no empty answer line', () => {
  const view = presentCamera(on(S.WAITING_FOR_NEXT, { answer: { answer: { subject: '', type: '', answer: '', steps: [], explanation: 'It is Paris.', confidence: 'low', uncertainty: 'The reply was not in the expected format, so it is shown as written.' } } }))
  assert.equal(view.answer.headline, '')
  assert.equal(view.answer.explanation, 'It is Paris.')
})

test('nothing is shown as an answer while there is none', () => {
  assert.equal(presentCamera(on(S.ANALYSING, { current: QUESTION })).answer, null)
})

// ---- the history -------------------------------------------------------------------------------------------------

test('previous questions are numbered, newest first, with long text clipped and a short answer line', () => {
  const long = 'Explain in detail why the sky appears blue during the day but red at sunset, with reference to scattering.'
  const view = presentCamera(
    on(S.WAITING_FOR_NEXT, {
      history: [
        { questionId: 'q2', text: long, answer: { ...ANSWER, answer: '', explanation: 'Rayleigh scattering favours short wavelengths, so blue light is scattered most.', confidence: 'medium' }, markdown: '' },
        { questionId: 'q1', text: 'What is 6 x 7?', answer: ANSWER, markdown: '' }
      ]
    })
  )
  assert.deepEqual(view.history.map((h) => h.number), [2, 1])
  assert.equal(view.history[0].title.length <= 90, true)
  assert.match(view.history[0].title, /…$/)
  assert.equal(view.history[0].headline.length <= 90, true)
  assert.match(view.history[0].headline, /Rayleigh/)
  assert.equal(view.history[1].title, 'What is 6 x 7?')
  assert.equal(view.history[1].headline, '42')
  assert.equal(view.history[1].detail.headline, '42')
})

// ---- robustness --------------------------------------------------------------------------------------------------

test('a partial or odd state never throws', () => {
  for (const state of [{}, { phase: 'NOPE' }, base({ current: {} }), base({ answer: {} }), base({ answer: { answer: null } }), base({ history: [null, {}, { text: 5, answer: 'x' }] })]) {
    assert.doesNotThrow(() => presentCamera(state), JSON.stringify(state))
  }
})
