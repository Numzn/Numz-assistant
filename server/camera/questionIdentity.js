/**
 * What makes two readings "the same question". A question is read out of a photo of a screen, so the same one
 * arrives again and again slightly different (a misread letter, another crop, a different "Question 3." in front).
 * The Smart Camera must never answer one twice, and must never mistake a new one for an old one, so:
 *
 *   - the text is normalised first (case, spacing, numbering, sentence punctuation, the way maths is written);
 *   - numbers must match exactly: "150 km" and "160 km" are different questions however alike the sentences are;
 *   - the letters of the options (A, B, C ...) must match;
 *   - what is left must be nearly identical: 96% of the characters (about one misread letter in 25).
 *
 * The threshold errs towards "a different question": answering a question twice wastes a call, but taking a new
 * question for an old one would silently skip it. The 0.96 is an unmeasured default.
 */

const SAME_ABOVE = 0.96
const MAX_COMPARED = 2000 // characters: far more than any one question

const SUPERSCRIPTS = { '²': '^2', '³': '^3', '¹': '^1', '⁴': '^4', '⁵': '^5', '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9', '⁰': '^0' }

/** The text of a question reduced to what identifies it. Idempotent: normalising twice changes nothing more. */
export function normalizeQuestion(value) {
  if (typeof value !== 'string') return ''
  let text = value.replace(/[²³¹⁴⁵⁶⁷⁸⁹⁰]/g, (c) => SUPERSCRIPTS[c]).normalize('NFKC').toLowerCase()
  text = text
    .replace(/[−–—]/g, '-')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/[“”‘’"'`]/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 1,000 -> 1000
  text = text.replace(/^\s*(?:question|q)\s*\d+\s*[.:)\-]*\s*/, ' ').replace(/^\s*\d+\s*[.)]\s+/, ' ')
  text = text.replace(/(^|\s)\(?([a-h])[.)]\s+/g, ' $2) ') // "A. red" and "(a) red" are both "a) red"
  text = text.replace(/\.(?!\d)|(?<!\d)\./g, ' ').replace(/[,;:!?]/g, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

/** The stem and the options of a reading as one normalised string. */
export function identityText({ text, options = [] } = {}) {
  const stem = normalizeQuestion(text)
  const choices = (Array.isArray(options) ? options : [])
    .map((option) => `${normalizeQuestion(option?.label)}${option?.label ? ') ' : ''}${normalizeQuestion(option?.text)}`.trim())
    .filter(Boolean)
  return [stem, ...choices].join(' ').trim()
}

/** 1 for equal strings, 0 for nothing in common: 1 - edit distance / length of the longer. */
export function similarity(a, b) {
  const x = String(a ?? '').slice(0, MAX_COMPARED)
  const y = String(b ?? '').slice(0, MAX_COMPARED)
  if (x === y) return 1
  if (!x.length || !y.length) return 0
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const row = [i]
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    previous = row
  }
  return 1 - previous[y.length] / Math.max(x.length, y.length)
}

const numbersIn = (text) => (text.match(/\d+(?:\.\d+)?/g) ?? []).join(' ')
const optionLettersIn = (text) => [...text.matchAll(/(?:^|\s)([a-h])\)\s/g)].map((m) => m[1]).join('')

/** Whether two readings are the same question. Empty text is never the same as anything. */
export function sameQuestion(a, b) {
  const x = normalizeQuestion(a)
  const y = normalizeQuestion(b)
  if (!x || !y) return false
  if (numbersIn(x) !== numbersIn(y)) return false
  if (optionLettersIn(x) !== optionLettersIn(y)) return false
  return similarity(x, y) >= SAME_ABOVE
}

/** The first of `known` ({ questionId, identity }) that is this question, or null. */
export function findKnownQuestion(identity, known) {
  for (const entry of known ?? []) if (sameQuestion(identity, entry.identity)) return entry
  return null
}

const MIN_WORDS = 3
const MIN_CONFIDENCE = 0.5
const MAX_QUESTION_CHARS = 2000

/** Whether a reading is worth answering: { ok: true } or { ok: false, status: 'not-a-question' | 'unclear', reason }. */
export function validateReading(reading) {
  if (!reading || typeof reading !== 'object') return { ok: false, status: 'unclear', reason: 'Nothing could be read from that picture.' }
  if (reading.isQuestion !== true) return { ok: false, status: 'not-a-question', reason: String(reading.reason ?? '') }
  const text = typeof reading.text === 'string' ? reading.text.trim() : ''
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).length
  if (words < MIN_WORDS && !(words === 2 && text.length >= 14)) return { ok: false, status: 'unclear', reason: 'Too little text was readable.' }
  if (text.length > MAX_QUESTION_CHARS) return { ok: false, status: 'unclear', reason: 'That is too much text to be one question.' }
  if (!(Number(reading.confidence) >= MIN_CONFIDENCE)) return { ok: false, status: 'unclear', reason: 'The text could not be read with confidence.' }
  return { ok: true }
}
