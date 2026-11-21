import { CAMERA_STATES as S } from './cameraSession.js'

/**
 * What the Smart Camera's screen shows and allows, as a pure function of the session's state (cameraSession.js).
 * The DOM only draws this. Every rule about when a button is available, what the indicator says and how an answer
 * reads lives here, so it is tested without a browser.
 *
 * The indicator is the one the privacy rules lean on: it says plainly whether the camera is off, paused, scanning,
 * or in the middle of sending a picture, and "scanning" is only ever shown while pictures really may be sent.
 */

const LOW_CONFIDENCE_BELOW = 0.75
const CLIP = 90

const WATCHING = new Set([S.READY, S.WAITING_FOR_NEXT])
const SCANNING_PHASES = new Set([S.READY, S.QUESTION_DETECTED, S.CAPTURING, S.EXTRACTING, S.ANALYSING, S.ANSWER_READY, S.WAITING_FOR_NEXT, S.AWAITING_CONFIRMATION])

const TYPE_LABELS = {
  'multiple-choice': 'Multiple choice',
  'true-false': 'True / false',
  'short-answer': 'Short answer',
  calculation: 'Calculation',
  descriptive: 'Descriptive',
  'fill-in-the-blank': 'Fill in the blank'
}
const CONFIDENCE_LABELS = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }

const text = (value) => (typeof value === 'string' ? value : '')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const capitalise = (value) => (value ? value[0].toUpperCase() + value.slice(1) : '')

function clip(value, max = CLIP) {
  const flat = text(value).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function indicatorFor(state) {
  const { phase } = state
  if (!state.cameraOn) return phase === S.STARTING ? { kind: 'starting', label: 'Starting the camera…' } : { kind: 'off', label: 'Camera off' }
  if (phase === S.PAUSED) return { kind: 'paused', label: 'Paused · nothing is sent' }
  if (state.limitReached) return { kind: 'unavailable', label: 'Not scanning: session limit reached' }
  if (phase === S.ERROR) return { kind: 'error', label: 'Not scanning' }
  if (state.visionConfigured === false) return { kind: 'unavailable', label: 'Not scanning: no vision service' }
  switch (phase) {
    case S.CAPTURING:
      return { kind: 'sending', label: 'Scanning · taking a picture' }
    case S.EXTRACTING:
      return { kind: 'sending', label: 'Scanning · picture sent to be read' }
    case S.ANALYSING:
      return { kind: 'working', label: 'Working out the answer' }
    case S.AWAITING_CONFIRMATION:
      return { kind: 'review', label: 'Waiting for you to check the question' }
    default:
      return { kind: 'scanning', label: 'Scanning' }
  }
}

function busyFor(phase) {
  switch (phase) {
    case S.CAPTURING:
      return { label: 'Taking the picture…' }
    case S.EXTRACTING:
      return { label: 'Reading the question…' }
    case S.ANALYSING:
      return { label: 'Working out the answer…' }
    default:
      return null
  }
}

function controlsFor(state) {
  const { phase } = state
  const cameraOn = state.cameraOn === true
  const history = Array.isArray(state.history) ? state.history : []
  return {
    start: !cameraOn && (phase === S.IDLE || (phase === S.ERROR && !state.canRetry)),
    stop: cameraOn || phase === S.STARTING,
    pause: cameraOn && SCANNING_PHASES.has(phase),
    resume: phase === S.PAUSED,
    capture: WATCHING.has(phase) && state.visionConfigured !== false && !state.limitReached,
    retry: phase === S.ERROR && state.canRetry === true,
    confirm: phase === S.AWAITING_CONFIRMATION,
    skip: phase === S.AWAITING_CONFIRMATION,
    clear: history.length > 0 || (state.counts?.reads ?? 0) > 0,
    clearToContinue: cameraOn && state.limitReached === true,
    auto: state.auto === true
  }
}

function questionFor(state) {
  if (!isObject(state.current)) return null
  const q = state.current
  const lowConfidence = typeof q.confidence === 'number' && q.confidence < LOW_CONFIDENCE_BELOW
  const notes = []
  if (q.hasDiagram === true) notes.push('This question refers to a figure or table.')
  if (lowConfidence) notes.push('The text was hard to read: check the wording.')
  if (text(q.note)) notes.push(`The reader could not read all of it: ${text(q.note)}`)
  return {
    heading: state.phase === S.AWAITING_CONFIRMATION ? 'Check the question' : 'Question',
    text: text(q.text),
    options: (Array.isArray(q.options) ? q.options : []).filter(isObject).map((o) => ({ label: text(o.label), text: text(o.text) })),
    tags: [TYPE_LABELS[q.type] ?? '', capitalise(text(q.subject))].filter(Boolean),
    lowConfidence,
    notes,
    editable: state.phase === S.AWAITING_CONFIRMATION
  }
}

function answerView(answer) {
  if (!isObject(answer)) return null
  const confidence = answer.confidence in CONFIDENCE_LABELS ? answer.confidence : 'low'
  return {
    headline: text(answer.answer),
    steps: (Array.isArray(answer.steps) ? answer.steps : []).map(text).filter(Boolean),
    explanation: text(answer.explanation),
    confidence,
    confidenceLabel: CONFIDENCE_LABELS[confidence],
    unsure: confidence !== 'high',
    uncertainty: text(answer.uncertainty) || null
  }
}

function historyFor(state) {
  const items = (Array.isArray(state.history) ? state.history : []).filter(isObject)
  return items.map((item, index) => {
    const detail = answerView(item.answer)
    return {
      questionId: text(item.questionId),
      number: items.length - index,
      title: clip(item.text),
      headline: clip(detail?.headline || detail?.explanation),
      confidence: detail?.confidence ?? 'low',
      detail
    }
  })
}

export function presentCamera(state = {}) {
  const view = isObject(state) ? state : {}
  return {
    indicator: indicatorFor(view),
    status: { text: text(view.message), tone: view.tone === 'error' || view.tone === 'warn' || view.tone === 'ok' ? view.tone : 'info' },
    busy: busyFor(view.phase),
    showPlaceholder: view.cameraOn !== true,
    controls: controlsFor(view),
    question: questionFor(view),
    answer: answerView(view.answer?.answer),
    history: historyFor(view),
    counts: { reads: 0, answers: 0, duplicates: 0, skipped: 0, ...(isObject(view.counts) ? view.counts : {}) }
  }
}
