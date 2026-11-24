import assert from 'node:assert/strict'
import test from 'node:test'
import { analyseQuestion } from './questionAnalysis.js'
import { checkAnswer, chosenOption, itemsIn, reviewVerdict } from './answerCheck.js'

const check = (question, markdown, parts = null) => {
  const q = { options: [], ...question }
  return checkAnswer({ analysis: analyseQuestion(q), question: q, parts: parts ?? [{ key: null, markdown }] })
}
const mcq = { text: 'What is the average speed?', options: [{ label: 'A', text: '40' }, { label: 'B', text: '60' }, { label: 'C', text: '75' }] }

test('a multiple-choice answer must name one of the options', () => {
  assert.deepEqual(check(mcq, '**B) 60 km/h**').codes, [])
  assert.deepEqual(check(mcq, 'Option C').codes, [])
  assert.deepEqual(check(mcq, '60 km/h').codes, ['no-option'])
  assert.deepEqual(check(mcq, '**E) something**').codes, ['invalid-option'])
  assert.equal(chosenOption('**B) 60 km/h**'), 'B')
  assert.equal(chosenOption('The answer is C'), 'C')
  assert.equal(chosenOption('Because of the formula'), null)
})

test('a true-or-false answer must say which', () => {
  const q = { text: 'True or false: SQL is procedural.', type: 'true-false' }
  assert.deepEqual(check(q, '**False.** SQL is declarative.').codes, [])
  assert.deepEqual(check(q, 'It is declarative.').codes, ['no-verdict'])
})

test('a calculation needs a number', () => {
  const q = { text: 'Calculate the interest on $2,000 at 5% for 3 years.' }
  assert.deepEqual(check(q, 'I = 2,000 × 0.05 × 3 = $300\n\n**$300**').codes, [])
  assert.deepEqual(check(q, 'It depends on the rate and the time.').codes, ['no-number'])
})

test('every part must be answered; the items asked for must all be given', () => {
  const q = { text: '(a) Define inflation.\n(b) Calculate the rate.\n(c) List two effects on savers.' }
  const full = [{ key: 'a', markdown: 'A rise in prices.' }, { key: 'b', markdown: '**5%**' }, { key: 'c', markdown: '- loses value\n- lower real return' }]
  assert.deepEqual(check(q, '', full).codes, [])
  const missing = check(q, '', full.slice(0, 2))
  assert.deepEqual(missing.codes, ['missing-part'])
  assert.match(missing.issues[0], /Part \(c\) is not answered/)
  const few = check(q, '', [full[0], full[1], { key: 'c', markdown: '- loses value' }])
  assert.deepEqual(few.codes, ['too-few'])
  assert.match(few.issues[0], /asks for 2 items in part \(c\); the answer gives 1/)
  assert.deepEqual(check({ text: 'List four functions of money.' }, '1. a\n2. b\n3. c').codes, ['too-few'])
  assert.deepEqual(check({ text: 'List four functions of money.' }, 'medium of exchange, store of value, unit of account, deferred payment').codes, [], 'an answer whose items cannot be counted is not failed')
  assert.equal(itemsIn('- a\n- b\n- c'), 3)
  assert.equal(itemsIn('| x | y |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'), 2)
})

test('an answer that is not an answer, or is about something else, or stops in the middle, is found', () => {
  assert.deepEqual(check({ text: 'Define opportunity cost.' }, "I can't see the question you want answered.").codes, ['not-an-answer'])
  assert.deepEqual(check({ text: 'Define opportunity cost.' }, '').codes, ['empty'])
  const off = check({ text: 'Explain how photosynthesis converts sunlight into chemical energy in plants.' }, 'The French revolution began in 1789 when the estates general met at Versailles and the commons declared themselves a national assembly with the support of many nobles and clergy who joined them in the weeks that followed, after which the king was forced to accept the new order and return to Paris, where the assembly then wrote a declaration of rights and began to reform the laws, the taxes and the church.')
  assert.deepEqual(off.codes, ['off-topic'])
  const cut = check({ text: 'Explain how photosynthesis converts light into energy in plants.' }, 'Plants take in light and use it to turn water and carbon dioxide into sugar, and then the sugar is used by')
  assert.deepEqual(cut.codes, ['unfinished'])
  assert.deepEqual(check({ text: 'Explain how photosynthesis converts sunlight into chemical energy.' }, 'Plants use chlorophyll to capture sunlight and turn water and carbon dioxide into glucose and oxygen.').codes, [])
})

test('the second look: OK stands, a corrected answer replaces', () => {
  assert.deepEqual(reviewVerdict('OK'), { ok: true })
  assert.deepEqual(reviewVerdict('ok.'), { ok: true })
  assert.deepEqual(reviewVerdict(''), { ok: true })
  assert.deepEqual(reviewVerdict('The draft is correct.'), { ok: true })
  assert.deepEqual(reviewVerdict('#### ANSWER\n**$320**'), { ok: false, corrected: '#### ANSWER\n**$320**' })
  assert.equal(reviewVerdict('I have checked it and it is fine.').ok, true)
  assert.deepEqual(reviewVerdict('#### ANSWER\nThe question refers to a case, but the draft states facts that I cannot verify.'), { ok: true, ignored: 'commentary' }, 'a correction that is only talk about the draft is not used')
})
