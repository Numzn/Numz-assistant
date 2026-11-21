import { parseModelJson } from '../utils/prompt.js'

/**
 * Reading what a model says about a picture or a question. Whatever comes back is data to be made safe, never
 * trusted: every field is checked, typed, capped and stripped of control characters, and a reply that is not what
 * was asked for becomes a plain "could not read it" instead of an exception.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const QUESTION_TYPES = new Set(['multiple-choice', 'true-false', 'short-answer', 'calculation', 'descriptive', 'fill-in-the-blank', 'other'])
const CONFIDENCES = new Set(['high', 'medium', 'low'])

const clean = (value, max) => (typeof value === 'string' ? value.replace(CONTROL, '').trim().slice(0, max) : '')
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function cleanOptions(value) {
  if (!Array.isArray(value)) return []
  const options = []
  for (const item of value) {
    const option = typeof item === 'string' ? { label: '', text: clean(item, 400) } : isPlainObject(item) ? { label: clean(item.label, 8), text: clean(item.text, 400) } : null
    if (option?.text) options.push(option)
    if (options.length === 12) break
  }
  return options
}

/** -> { ok: true, reading } | { ok: false } */
export function parseReading(raw) {
  if (typeof raw !== 'string') return { ok: false }
  const parsed = parseModelJson(raw)
  if (!parsed.ok || !isPlainObject(parsed.value)) return { ok: false }
  const v = parsed.value
  const confidence = Number.isFinite(v.confidence) ? Math.min(1, Math.max(0, v.confidence)) : 0.7
  return {
    ok: true,
    reading: {
      isQuestion: v.isQuestion === true,
      text: clean(v.text, 4000),
      options: cleanOptions(v.options),
      type: QUESTION_TYPES.has(v.type) ? v.type : 'other',
      subject: clean(v.subject, 60),
      hasDiagram: v.hasDiagram === true,
      confidence,
      reason: clean(v.reason, 200)
    }
  }
}

const NOT_JSON = 'The reply was not in the expected format, so it is shown as written.'

/** -> { ok: true, answer } | { ok: false, answer } (the reply as the explanation, low confidence, and why) */
export function parseAnswer(raw) {
  const fallback = (text) => ({
    ok: false,
    answer: { subject: '', type: '', answer: '', steps: [], explanation: clean(text, 4000), confidence: 'low', uncertainty: NOT_JSON }
  })
  if (typeof raw !== 'string') return fallback('')
  const parsed = parseModelJson(raw)
  if (!parsed.ok || !isPlainObject(parsed.value)) return fallback(raw)
  const v = parsed.value
  const confidence = typeof v.confidence === 'string' ? v.confidence.trim().toLowerCase() : ''
  return {
    ok: true,
    answer: {
      subject: clean(v.subject, 60),
      type: clean(v.type, 40),
      answer: clean(v.answer, 1000),
      steps: (Array.isArray(v.steps) ? v.steps : []).map((step) => clean(step, 500)).filter(Boolean).slice(0, 20),
      explanation: clean(v.explanation, 4000),
      confidence: CONFIDENCES.has(confidence) ? confidence : 'low',
      uncertainty: clean(v.uncertainty, 500) || null
    }
  }
}

/** The answer laid out as Markdown for the chat renderer (bold, numbered list, paragraphs). */
export function toMarkdown(answer) {
  const parts = []
  if (answer.answer) parts.push(`**Answer:** ${answer.answer}`)
  if (answer.steps?.length) parts.push(['**Steps**', ...answer.steps.map((step, i) => `${i + 1}. ${step}`)].join('\n'))
  if (answer.explanation) parts.push(answer.explanation)
  const footer = []
  if (answer.confidence) footer.push(`Confidence: ${answer.confidence}`)
  if (answer.uncertainty) footer.push(`Not sure: ${answer.uncertainty}`)
  if (footer.length) parts.push(footer.join('\n'))
  return parts.join('\n\n')
}
