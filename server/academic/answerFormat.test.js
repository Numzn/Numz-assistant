import assert from 'node:assert/strict'
import test from 'node:test'
import { answerLabel, formatAnswers, normalizeAnswer, parseAnswers, plainText, splitSources, trimFiller } from './answerFormat.js'

test('an answer without headings is one part labelled ANSWER; the ANSWER word must be in capitals to count', () => {
  const one = parseAnswers('**B) 60 km/h**')
  assert.equal(one.labelled, false)
  assert.deepEqual(one.parts, [{ key: null, label: 'ANSWER', markdown: '**B) 60 km/h**' }])
  const ordinary = parseAnswers('## Answer\nThis heading is ordinary text, not a block.')
  assert.equal(ordinary.labelled, false, 'a heading that merely says "Answer" is never turned into a block')
})

test('parts are read from their headings in any of the ways a model writes them', () => {
  const text = '#### ANSWER (a)\nInflation is a rise in prices.\n\n**ANSWER (b)**\n5%\n\nANSWER (c):\nSavings lose value.'
  const parsed = parseAnswers(text)
  assert.equal(parsed.labelled, true)
  assert.deepEqual(parsed.parts.map((p) => [p.key, p.label, p.markdown]), [['a', 'ANSWER (a)', 'Inflation is a rise in prices.'], ['b', 'ANSWER (b)', '5%'], ['c', 'ANSWER (c)', 'Savings lose value.']])
  assert.equal(parseAnswers('### ANSWER\nOne.').parts[0].key, null)
})

test('a heading inside a code block is code, not a part', () => {
  const parsed = parseAnswers('#### ANSWER\nRun this:\n```\n#### ANSWER (b)\nprint(1)\n```')
  assert.equal(parsed.parts.length, 1)
  assert.match(parsed.parts[0].markdown, /print\(1\)/)
})

test('sources belong to the whole answer, not to its last part', () => {
  const text = '#### ANSWER (a)\nOne [S1].\n\n#### ANSWER (b)\nTwo.\n\n**Sources**\n- [S1] Lecture 3'
  assert.deepEqual(splitSources(text), { body: '#### ANSWER (a)\nOne [S1].\n\n#### ANSWER (b)\nTwo.', sources: '**Sources**\n- [S1] Lecture 3' })
  const parsed = parseAnswers(text)
  assert.equal(parsed.parts[1].markdown, 'Two.')
  assert.equal(parsed.sources, '**Sources**\n- [S1] Lecture 3')
  assert.equal(formatAnswers(parsed.parts, parsed.sources), text.replace('#### ANSWER (a)\nOne', '#### ANSWER (a)\n\nOne').replace('#### ANSWER (b)\nTwo', '#### ANSWER (b)\n\nTwo'))
})

test('a reply is brought to the stored form: fillers removed, a single answer labelled, parts recovered from "(a)" lines', () => {
  const single = normalizeAnswer('Sure!\n\nOpportunity cost is the next best thing you give up.\n\nI hope this helps.')
  assert.equal(single.markdown, '#### ANSWER\n\nOpportunity cost is the next best thing you give up.')
  assert.deepEqual(single.parts.map((p) => p.key), [null])

  const recovered = normalizeAnswer('(a) A rise in prices.\n**(b)** 5%\nc) Savings lose value.', ['a', 'b', 'c'])
  assert.equal(recovered.recovered, true)
  assert.deepEqual(recovered.parts.map((p) => [p.key, p.markdown]), [['a', 'A rise in prices.'], ['b', '5%'], ['c', 'Savings lose value.']])

  const lead = normalizeAnswer('Both parts below.\n#### ANSWER (a)\nOne.\n#### ANSWER (b)\nTwo.', ['a', 'b'])
  assert.match(lead.parts[0].markdown, /^Both parts below\./, 'words before the first heading are kept, not lost')
  assert.equal(answerLabel('b'), 'ANSWER (b)')
})

test('filler lines go and meaningful lines never do', () => {
  assert.equal(trimFiller('Certainly:\nThe answer is 7.\nLet me know if you want more.'), 'The answer is 7.')
  assert.equal(trimFiller('In conclusion, rent control has costs and benefits.'), 'In conclusion, rent control has costs and benefits.')
  assert.equal(trimFiller('Here are four functions:\n1. a\n2. b'), 'Here are four functions:\n1. a\n2. b', 'a lead-in that carries words is kept')
})

test('plain text for a box with no formatting: marks removed, structure kept', () => {
  const text = '**Total** = `300`\n\n- first\n- second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSee [the notes](https://example.org/n).'
  assert.equal(plainText(text), 'Total = 300\n\n- first\n- second\n\na\tb\n1\t2\n\nSee the notes (https://example.org/n).')
})
