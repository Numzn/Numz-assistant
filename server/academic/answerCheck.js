/**
 * Checking an answer before the person is given it. Two levels, so that a simple question is never made to wait for a hard question's care:
 *
 *   checkAnswer     every answer, in a few microseconds, with no model: is there an answer; for a multiple-choice question, is it one of the
 *                   options; for a calculation, is there a result; are all the parts there; are there as many items as were asked for; does
 *                   it look like an answer to THIS question; is it finished. What it finds is described in plain words, so that a draft
 *                   which fails can be sent back with exactly what was wrong (one repair, at most).
 *   reviewVerdict   a complex question's draft is also read by the model a second time (responseEngine.buildReviewMessages), which redoes any
 *                   calculation and checks relevance, correctness, completeness and clarity; this reads that reply: "OK", or a corrected answer.
 */

import { plainText } from './answerFormat.js'

const STOP = new Set('about above after again also another because been before being between both could does doing each from have having here into just like made make many more most much must only other over same should some such than that their them then there these they this those through under until very were what when where which while whom whose will with would your explain describe define state give list name outline question answer'.split(' '))
const wordsIn = (text) => String(text ?? '').split(/\s+/).filter(Boolean).length
const contentWords = (text) => new Set((String(text ?? '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)))

const NOT_AN_ANSWER = /^\W*(?:i (?:can(?:'|no)t|am (?:not )?unable|am not able|do not|don't)\b|unfortunately\b|there is no (?:question|text)|no question (?:was|is|has been) (?:shown|provided|visible|given))|\b(?:can(?:'|no)t see (?:the|a|any) (?:question|text|image|screen)|no (?:question|text) (?:is|was) (?:visible|shown|provided))\b/i

const ITEM = /^\s*(?:[-*•]|\d{1,2}[.)]|\(?[a-z][.)])\s+\S/

/** How many separate items an answer lists: bullet or numbered lines, else numbered inline ("1) x 2) y"), else null when it cannot tell. */
export function itemsIn(markdown) {
  const lines = String(markdown ?? '').split('\n')
  const marked = lines.filter((l) => ITEM.test(l)).length
  if (marked) return marked
  const rows = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|?\s*:?-{2,}/.test(l)).length
  if (rows >= 3) return rows - 1 // a table: the first row is the heading
  const inline = String(markdown ?? '').match(/(?:^|\s)\(?\d{1,2}[.)]\s+\S/g)
  return inline && inline.length >= 2 ? inline.length : null
}

function optionLetters(question) {
  return (question.options ?? []).map((o, i) => String(o.label || String.fromCharCode(65 + i)).replace(/[^A-Za-z0-9]/g, '').toUpperCase()).filter(Boolean)
}

/** The option an answer names: "B) 60 km/h", "**B**", "Option B", "The answer is B". Null if none can be found. */
export function chosenOption(text) {
  const t = plainText(text)
  const m = t.match(/^\W*(?:option\s+|answer(?:\s+is)?\s*:?\s+|the (?:correct )?answer is\s+)?\(?([A-H])\)?(?=[\s).:,\-–—]|$)/i)
  return m ? m[1].toUpperCase() : null
}

/**
 * @param {{ analysis: object, question: { text: string, options?: object[], type?: string }, parts: { key: string|null, markdown: string }[] }} input
 * @returns {{ issues: string[], codes: string[] }}
 */
export function checkAnswer({ analysis, question, parts }) {
  const issues = []
  const codes = []
  const flag = (code, message) => {
    codes.push(code)
    issues.push(message)
  }
  const whole = parts.map((p) => p.markdown).join('\n')

  if (!whole.trim()) {
    flag('empty', 'There is no answer.')
    return { issues, codes }
  }
  if (NOT_AN_ANSWER.test(whole.trim())) flag('not-an-answer', 'It does not answer the question. The question is the text given: answer it.')

  // Every part the question has must be answered, each in its own block.
  const expected = (analysis.parts ?? []).map((p) => p.key)
  if (expected.length >= 2) {
    const have = new Set(parts.filter((p) => p.markdown.trim()).map((p) => p.key))
    const missing = expected.filter((k) => !have.has(k))
    if (missing.length) flag('missing-part', `Part${missing.length > 1 ? 's' : ''} ${missing.map((k) => `(${k})`).join(', ')} ${missing.length > 1 ? 'are' : 'is'} not answered. Answer every part, each under its own "#### ANSWER (letter)" line.`)
  }

  const asked = expected.length >= 2 ? analysis.parts : [{ key: null, task: analysis.task, count: analysis.count, text: question.text }]
  for (const spec of asked) {
    const part = parts.find((p) => p.key === spec.key) ?? (spec.key === null ? parts[0] : null)
    if (!part?.markdown?.trim()) continue
    const text = part.markdown
    const where = spec.key ? ` in part (${spec.key})` : ''

    if (spec.task === 'multiple_choice' && (question.options?.length ?? 0) >= 2) {
      const letters = optionLetters(question)
      const chosen = chosenOption(text)
      if (!chosen) flag('no-option', `The answer must name one of the options (${letters.join(', ')}) by its letter.`)
      else if (!letters.includes(chosen)) flag('invalid-option', `"${chosen}" is not one of the options (${letters.join(', ')}). Choose from those.`)
    } else if (question.type === 'true-false' || (spec.task === 'multiple_choice' && !question.options?.length)) {
      if (!/\b(true|false)\b/i.test(plainText(text))) flag('no-verdict', 'The answer must say whether the statement is true or false.')
    }
    if (spec.task === 'calculate' && !/\d/.test(text)) flag('no-number', `A calculation needs a numerical result${where}, and there is none.`)
    if (spec.count) {
      const n = itemsIn(text)
      if (n !== null && n < spec.count) flag('too-few', `The question asks for ${spec.count} items${where}; the answer gives ${n}.`)
    }
  }

  // It must look like an answer to THIS question: a long reply sharing no word of substance with it is about something else.
  const stem = contentWords(question.text)
  if (stem.size >= 5 && wordsIn(whole) >= 60) {
    const answerWords = contentWords(whole)
    const shared = [...stem].some((w) => answerWords.has(w) || [...answerWords].some((a) => a.length >= 5 && w.length >= 5 && (a.startsWith(w.slice(0, 5)) || w.startsWith(a.slice(0, 5)))))
    if (!shared) flag('off-topic', 'The answer does not seem to be about this question. Answer the question that was asked.')
  }

  // Cut off: the reply stops in the middle of a thought (a model that ran out of room, or a connection that dropped).
  const last = whole.trim().split('\n').pop().trim()
  // (a lowercase small word at the very end: "Vitamin A" or "Option B" are endings, "is used by" is not)
  if (wordsIn(whole) > 12 && /(?:[,:;(]|\b(?:and|or|but|the|of|to|with|because|by|in|on|for|from|as|that|which|is|are|into|at|than)\s*)$/.test(last)) flag('unfinished', 'The answer stops in the middle of a sentence. Finish it.')
  if ((whole.match(/```/g) ?? []).length % 2 === 1) flag('unfinished', 'A code block is left open. Close it.')

  return { issues, codes }
}

/**
 * Reads the second look's reply. `OK` (alone, or with a full stop) means the draft stands; anything else of substance is the corrected
 * answer. A reply that is empty or only talks about the draft changes nothing.
 */
export function reviewVerdict(reply) {
  const t = String(reply ?? '').trim()
  if (!t || /^ok\b[.!\s]*$/i.test(t) || /^(?:the )?draft (?:is|looks) (?:fine|correct|good|ok)\b/i.test(t)) return { ok: true }
  if (/^(?:i (?:have|'ve) (?:checked|reviewed)|the draft)\b/i.test(t) && !/#### ANSWER/.test(t) && wordsIn(t) < 25) return { ok: true }
  // A "correction" that talks about the draft or the check, or says it lacks what it needs, is not an answer: the draft stands.
  if (/\b(?:the|this|my) draft\b|\bthis check\b|\bthe request\b|\b(?:cannot|can't|unable to) verify\b|\b(?:no|not) (?:case )?details? (?:are |is |were )?(?:given|provided)\b/i.test(t)) return { ok: true, ignored: 'commentary' }
  return { ok: false, corrected: t }
}
