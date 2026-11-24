import assert from 'node:assert/strict'
import test from 'node:test'
import { analyseQuestion, classifyTask, instructionsOf, marksOf, requiredCount, splitParts } from './questionAnalysis.js'

const task = (text, extra = {}) => classifyTask({ text, options: [], ...extra })

test('every kind of question is recognised from how it is worded', () => {
  assert.equal(task('Define “opportunity cost”.'), 'define')
  assert.equal(task('What is meant by inflation?'), 'define')
  assert.equal(task('1. Explain how TCP achieves reliable delivery.'), 'explain')
  assert.equal(task('Why does the moon have phases?'), 'explain')
  assert.equal(task('List four functions of money.'), 'list')
  assert.equal(task('Name three layers of the OSI model.'), 'list')
  assert.equal(task('What are the types of memory in a computer?'), 'list')
  assert.equal(task('Compare TCP and UDP.'), 'compare')
  assert.equal(task('What is the difference between a stack and a queue?'), 'compare')
  assert.equal(task('Discuss the role of indexing in query performance.'), 'discuss')
  assert.equal(task('Evaluate the effectiveness of rent control.'), 'evaluate')
  assert.equal(task('To what extent is the waterfall model still useful?'), 'evaluate')
  assert.equal(task('Analyse the causes of the 2008 financial crisis.'), 'analyse')
  assert.equal(task('Calculate the mean of 4, 8 and 15.'), 'calculate')
  assert.equal(task('Work out the area of a circle with radius 3 cm.'), 'calculate')
  assert.equal(task('Using the supply and demand model, predict what happens to price when supply falls.'), 'apply')
  assert.equal(task('How would you apply normalisation to this table?'), 'apply')
  assert.equal(task('Which of these is a primary key?', { options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }] }), 'multiple_choice')
  assert.equal(task('True or false: SQL is a procedural language.', { type: 'true-false' }), 'multiple_choice')
  assert.equal(task('Something unusual altogether'), 'explain', 'what the rules cannot place is explained, never refused')
})

test('multi-part questions are split into their labelled parts, whatever the labelling', () => {
  const lettered = splitParts('Question 8.\n(a) Define inflation. (2)\n(b) Calculate the rate of inflation. (2)\n(c) State one effect on savers. (2)')
  assert.deepEqual(lettered.parts.map((p) => [p.key, p.label]), [['a', '(a)'], ['b', '(b)'], ['c', '(c)']])
  assert.match(lettered.parts[1].text, /^Calculate the rate of inflation/)
  assert.equal(lettered.stem, 'Question 8.')

  const inline = splitParts('Consider a loan. a) Find the interest. b) Find the total repaid.')
  assert.deepEqual(inline.parts.map((p) => p.key), ['a', 'b'])
  assert.equal(inline.stem, 'Consider a loan.')

  const roman = splitParts('(i) State the law.\n(ii) Give an example.\n(iii) Explain a limit.')
  assert.deepEqual(roman.parts.map((p) => p.key), ['i', 'ii', 'iii'])

  const numbered = splitParts('Read the passage.\n1. Who is the narrator?\n2. Where is it set?')
  assert.deepEqual(numbered.parts.map((p) => p.key), ['1', '2'])
})

test('things that look like part labels but are not, are left alone', () => {
  assert.deepEqual(splitParts('Explain what e.g. means, and why i.e. differs from it.').parts, [])
  assert.deepEqual(splitParts('Describe Figure 2.1 in the textbook (page 3).').parts, [])
  assert.deepEqual(splitParts('(a) Only one part is shown here.').parts, [], 'one marker is not a multi-part question')
  assert.deepEqual(splitParts('(b) Starts at b, so it does not follow from the start (c) either.').parts, [], 'the run must begin at the start of its scheme')
  const mcq = analyseQuestion({ text: 'Which is right? A) one B) two', options: [{ label: 'A', text: 'one' }, { label: 'B', text: 'two' }] })
  assert.deepEqual(mcq.parts, [], 'the options of a multiple-choice question are never parts')
})

test('how many items are asked for, and every instruction in a question', () => {
  assert.equal(requiredCount('List four functions of money.'), 4)
  assert.equal(requiredCount('Give two examples of a renewable resource.'), 2)
  assert.equal(requiredCount('State any three causes of the war.'), 3)
  assert.equal(requiredCount('Suggest 3 ways to cut costs.'), 3)
  assert.equal(requiredCount('Calculate the interest on 5 years of savings.'), null, 'a number of years is not a number of items')
  assert.equal(requiredCount('Define inflation.'), null)
  assert.deepEqual(instructionsOf('Define opportunity cost and give two examples.'), ['Define opportunity cost', 'give two examples'])
  assert.deepEqual(instructionsOf('Calculate the total cost. Show your working, then state the unit.'), ['Calculate the total cost', 'Show your working', 'state the unit'])
  assert.deepEqual(instructionsOf('The sky is blue.'), [])
})

test('marks are read from the reading or the text', () => {
  assert.equal(marksOf('5'), 5)
  assert.equal(marksOf('(4 marks)'), 4)
  assert.equal(marksOf(null, 'Evaluate rent control. (6 marks)'), 6)
  assert.equal(marksOf(null, 'Define inflation. [2]'), 2)
  assert.equal(marksOf(null, 'No marks here'), null)
})

test('the size of the answer follows the question: simple, moderate or complex', () => {
  const level = (text, extra) => analyseQuestion({ text, options: [], ...extra }).complexity
  assert.equal(level('Define “opportunity cost”.'), 'simple')
  assert.equal(level('Which is a noun?', { options: [{ label: 'A', text: 'run' }, { label: 'B', text: 'dog' }] }), 'simple')
  assert.equal(level('Why is the sky blue?'), 'simple')
  assert.equal(level('Explain how a hash table handles collisions and why this affects performance.'), 'moderate')
  assert.equal(level('List four functions of money.'), 'moderate')
  assert.equal(level('Calculate the simple interest on $2,000 at 5% for 3 years.', { marks: '3' }), 'moderate')
  assert.equal(level('Evaluate the effectiveness of rent control.', { marks: '6' }), 'complex')
  assert.equal(level('Discuss the role of indexing.'), 'complex')
  assert.equal(level('(a) Define inflation.\n(b) Calculate it.\n(c) Explain an effect.'), 'complex', 'three parts need each part worked')
  assert.equal(level('(a) Define inflation.\n(b) Calculate it.'), 'moderate')
  assert.equal(level('Calculate the net present value of cash flows of 100, 200, 300, 400 at 8%.', { marks: '5' }), 'complex')
})

test('a case study is recognised from the scenario that comes with the question', () => {
  const scenario = 'Maple Bakery sells bread and cakes in a small town. Over the last year its flour and energy costs rose 20% while sales stayed the same because a supermarket opened nearby. The owner has not changed her prices in three years.'
  const withPassage = analyseQuestion({ text: 'Advise the owner on two actions to return to profit.', options: [] }, { related: [{ kind: 'paragraph', text: scenario }] })
  assert.equal(withPassage.task, 'case_study')
  assert.equal(withPassage.caseStudy, true)
  assert.equal(withPassage.complexity, 'complex')
  assert.equal(withPassage.count, 2)
  const inText = analyseQuestion({ text: `${scenario} Question: advise the owner on what to do.`, options: [] })
  assert.equal(inText.task, 'case_study')
  assert.equal(analyseQuestion({ text: 'Calculate 5% of 200.', options: [] }, { related: [{ kind: 'paragraph', text: scenario }] }).task, 'calculate', 'a calculation stays a calculation')
})

test('a question that is itself one labelled part keeps its label, and the analysis never refuses', () => {
  assert.equal(analyseQuestion({ text: '(b) Calculate the rate of inflation.', options: [] }).ownLabel, 'b')
  assert.equal(analyseQuestion({ text: 'Calculate the rate of inflation.', options: [] }).ownLabel, null)
  const odd = analyseQuestion({ text: '???', options: [] })
  assert.equal(odd.task, 'explain')
  assert.ok(['simple', 'moderate', 'complex'].includes(odd.complexity))
  const empty = analyseQuestion({})
  assert.equal(empty.task, 'explain')
  assert.deepEqual(empty.parts, [])
})

test('the analysis of a multi-part question carries each part\'s own task and count', () => {
  const a = analyseQuestion({ text: '(a) Define inflation.\n(b) Calculate the rate of inflation if prices rose from 200 to 210.\n(c) List two effects on savers.', options: [] })
  assert.deepEqual(a.parts.map((p) => [p.key, p.task, p.count]), [['a', 'define', null], ['b', 'calculate', null], ['c', 'list', 2]])
  assert.equal(a.review, true)
})
