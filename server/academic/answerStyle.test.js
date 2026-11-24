import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatChatMessages } from '../providers/deepseek/formatter.js'
import { checkAnswer } from './answerCheck.js'
import { analyseQuestion } from './questionAnalysis.js'
import { buildMessages, buildSystemPrompt, buildUserMessage, verifyCitations } from './responseEngine.js'
import { COMMAND_GUIDE, STYLE_NATURAL, commandsOf, detectSourceOnly, marksGuide, overclaimProblems, paddingProblems, referenceProblems, sourceKind } from './answerStyle.js'

const prompt = (text, extra = {}, situation = {}) => {
  const question = { text, options: [], ...extra }
  const analysis = analyseQuestion(question, { related: extra.related ?? [] })
  return { analysis, system: buildSystemPrompt({ task: analysis.task, analysis, hasCourse: true, hasSources: true, ...situation }) }
}
const check = (text, markdown, extra = {}, sourcesText = '') => {
  const question = { text, options: [], ...extra }
  return checkAnswer({ analysis: analyseQuestion(question), question, parts: [{ key: null, markdown }], sourcesText })
}

test('1. an answer begins with the answer: the rule is in the prompt, and a lead-in is found', () => {
  assert.match(prompt('Define opportunity cost. (2 marks)').system, /Start with the answer itself: a direct statement or a short definition, never a lead-in that repeats the question/)
  for (const opening of ['Certainly! I would be delighted to explain what opportunity cost is.', 'In today\'s rapidly evolving economy, opportunity cost matters.', 'This is a very important topic in economics.', 'Great question! Opportunity cost is the next best choice.', 'Let me explain: opportunity cost is the next best choice.']) {
    assert.deepEqual(paddingProblems(opening).map((p) => p.code).includes('padded-opening'), true, opening)
  }
  assert.deepEqual(paddingProblems('Opportunity cost is the value of the next best choice you give up.'), [])
  assert.deepEqual(check('Define opportunity cost.', 'Certainly! I would be delighted to explain this.').codes.includes('padded-opening'), true)
  assert.deepEqual(check('Define opportunity cost.', 'Opportunity cost is the value of the next best choice you give up.').codes, [])
})

test('2. plain language: inflated wording is found, ordinary technical words are not', () => {
  assert.equal(paddingProblems('Opportunity cost is a multifaceted idea that we must delve into.').some((p) => p.code === 'inflated-wording'), true)
  assert.equal(paddingProblems('It is important to note that prices rise.').some((p) => p.code === 'inflated-wording'), true)
  assert.equal(paddingProblems('We leverage a holistic framework to utilise resources.').some((p) => p.code === 'inflated-wording'), true, 'several weak words together')
  assert.deepEqual(paddingProblems('A robust test suite catches errors before the code is released.'), [], 'one ordinary word is not padding')
  assert.deepEqual(paddingProblems('A router sends packets towards their destination. It reads the address on each packet.'), [])
  assert.match(STYLE_NATURAL, /everyday English/)
  assert.match(STYLE_NATURAL, /Short to medium sentences, one idea in each/)
})

test('3 and 4. the marks set the depth: 5 marks is four or five points, 10 marks is developed with examples, and neither is a rule', () => {
  const five = marksGuide(5)
  const ten = marksGuide(10)
  assert.match(five, /direct definition or statement, then usually four or five relevant points, each with a short explanation/)
  assert.match(five, /If the question is about a case, use the details of the case/)
  assert.match(five, /Do not force exactly five bullets/)
  assert.match(ten, /explain the main features, stages, reasons or differences and develop each enough to show understanding/)
  assert.match(ten, /examples, a table or a diagram when it helps or is asked for, and a short conclusion only when it adds something/)
  assert.match(ten, /not the most words/)
  assert.notEqual(five, ten)
  assert.doesNotMatch(five, /table or a diagram/, 'a 5-mark answer is not asked for a diagram')
  assert.match(marksGuide(2), /one clear point for each mark/)
  assert.match(marksGuide(7), /worth 7 marks/)
  assert.equal(marksGuide(null), null)
  // from the question itself
  assert.match(prompt('Explain the OSI model. (5 marks)').system, /This question is worth 5 marks/)
  assert.match(prompt('Explain the OSI model. (10 marks)').system, /This question is worth 10 marks/)
  assert.doesNotMatch(prompt('Explain the OSI model. (10 marks)').system, /worth 5 marks/)
  assert.doesNotMatch(prompt('Explain the OSI model.').system, /This question is worth/, 'no marks, no depth from marks: the size of the question decides')
  assert.match(prompt('Explain the OSI model.', { marks: '5' }).system, /worth 5 marks/, 'marks from the reading count too')
})

test('5. a comparison is made on the dimensions the question names, in a table where it helps', () => {
  const { analysis, system } = prompt('Compare TCP and UDP in terms of reliability, speed and use. (4 marks)')
  assert.deepEqual(analysis.commands, ['compare'])
  assert.match(system, /compare the exact dimensions the question names; a simple table makes differences easy to take in/)
  assert.match(system, /If it asks which is better, choose one clearly and justify the choice/)
  assert.match(buildSystemPrompt({ task: 'compare', style: 'explain' }), /on the exact dimensions the question names/)
})

test('6. a case study is answered from the case: its details are in the message and the prompt says to use them', () => {
  const scenario = 'Maple Bakery sells bread and cakes in a small town. Over the last year its flour and energy costs rose 20% while sales stayed the same because a supermarket opened nearby. The owner has not changed her prices in three years.'
  const question = { text: 'Advise the owner on two actions to return to profit. (5 marks)', options: [] }
  const related = [{ kind: 'paragraph', text: scenario }]
  const analysis = analyseQuestion(question, { related })
  assert.equal(analysis.caseStudy, true)
  const messages = buildMessages({ mode: 'full', task: analysis.task, analysis, question, marks: '5', passages: [], research: [], related })
  assert.match(messages[0].content, /Case study: use the actual details of the case and explain how the idea applies to that situation/)
  assert.match(messages[0].content, /Use its own names, figures and facts/)
  assert.match(messages[0].content, /worth 5 marks/)
  assert.match(messages[1].content, /<related_content>[\s\S]*Maple Bakery[\s\S]*supermarket opened nearby/)
})

test('7. an answer follows the supplied material: the kind of each source is given, with the order of authority', () => {
  const passages = [
    { label: 'S1', title: 'Lecture 3', sourceType: 'lecture_notes', text: 'The lecturer defines a process as a program in execution.' },
    { label: 'S2', title: 'Assignment 2', sourceType: 'other', text: 'A simulated scheduler.' },
    { label: 'S3', title: 'Past paper 2023', sourceType: 'study_guide', text: 'Q2: What is a process?' }
  ]
  const message = buildUserMessage({ question: { text: 'What is a process?', options: [] }, task: 'define', passages })
  assert.match(message, /<source id="S1" kind="lecturer" title="Lecture 3"/)
  assert.match(message, /<source id="S2" kind="assignment" title="Assignment 2"/)
  assert.match(message, /<source id="S3" kind="past paper" title="Past paper 2023"/)
  const { system } = prompt('What is a process?')
  assert.match(system, /Sources, in order of authority: \(1\) the lecturer's own materials[\s\S]*\(2\) the student's assignments, handouts[\s\S]*\(3\) past papers[\s\S]*\(4\) general knowledge, only as set out below/)
  assert.match(system, /A past-paper question shows that a topic was examined, not that the lecture notes explain it/)
  assert.match(system, /An assignment may be a simplified or simulated example/)
  assert.match(system, /Keep the lecturer's wording and terms\. Do not quietly swap a definition/)
  assert.match(system, /do not quietly replace the course's position|Do not quietly replace the course's position/i)
  assert.equal(sourceKind({ sourceType: 'lecture_transcript', title: 'Exam revision lecture' }), 'lecturer', 'a lecture is a lecture even when it is about the exam')
  assert.equal(sourceKind({ sourceType: 'textbook', title: 'Operating Systems' }), 'textbook')
})

test('8 and 9. when the sources do not explain a topic the answer says so, and what it adds from general knowledge is labelled supplementary', () => {
  const { system } = prompt('Explain the four types of memory.')
  assert.match(system, /Answer from the sources first\. If they name or list something but do not explain it, say so in one short sentence \(for example "The uploaded lecture notes list these four types but do not explain them in detail\."\)/)
  assert.match(system, /goes after a label "Supplementary:"/)
  assert.match(system, /must not read as if it came from the lecturer's slides and must not overwrite what the sources say/)
  assert.match(system, /at the student's course level/)
  const none = prompt('Explain the four types of memory.', {}, { hasSources: false }).system
  assert.match(none, /none of its materials matched this question[\s\S]*"Not from your notes:"/)
  assert.doesNotMatch(none, /Answer from the sources first/)
  const noCourse = prompt('Explain the four types of memory.', {}, { hasSources: false, hasCourse: false }).system
  assert.match(noCourse, /No course was identified[\s\S]*without remarking on it/)
})

test('10. "use only my notes" means no general knowledge: it is found in the note or in the question, and the prompt forbids filling gaps', () => {
  for (const said of ['use only my notes', 'Please answer using only the notes I uploaded', 'only from my lecture notes', 'Answer from my slides only', 'don\'t use outside knowledge', 'rely solely on the supplied documents', 'stick to just my notes']) assert.equal(detectSourceOnly(said), true, said)
  for (const said of ['explain this in simple words', 'use my notes and add examples', 'what do my notes say about caching?', 'only two marks', '']) assert.equal(detectSourceOnly(said), false, said)
  const only = prompt('Explain virtual memory.', {}, { sourceOnly: true }).system
  assert.match(only, /asked to use ONLY their own notes\. Use only what the sources say\. Do not add general knowledge, even to fill a gap/)
  assert.match(only, /The uploaded notes do not explain this/)
  assert.doesNotMatch(only, /Supplementary:/, 'no label for something that is not to be added')
  assert.doesNotMatch(only, /Not from your notes/)
})

test('11. nothing is invented: a source label that was not given is removed, and a page number or author-year that is not in the sources is found', () => {
  assert.equal(verifyCitations('Paging splits memory [S1]. It is also in [S7].', ['S1']).text, 'Paging splits memory [S1]. It is also in.')
  const sources = 'Silberschatz explains paging on page 12 of the notes. (Tanenbaum, 2014) is quoted there.'
  assert.deepEqual(referenceProblems('Paging is explained on page 12.', sources), [])
  assert.deepEqual(referenceProblems('As explained by (Tanenbaum, 2014).', sources), [])
  assert.equal(referenceProblems('Paging is explained on p. 45.', sources)[0].code, 'invented-reference')
  assert.equal(referenceProblems('This is argued by (Smith et al., 2019).', sources)[0].code, 'invented-reference')
  assert.equal(referenceProblems('Paging is explained on page 12.', '').length, 1, 'with no sources at all, any page number is invented')
  assert.deepEqual(check('What is paging?', 'Paging splits memory into fixed blocks (Smith, 2019).', {}, sources).codes, ['invented-reference'])
  assert.match(prompt('What is paging?').system, /Never invent a source, author, date, page, quotation or reference/)
})

test('12. natural wording means correct wording: the style demands correct spelling and grammar and never asks for mistakes', () => {
  const { system } = prompt('Explain paging.')
  assert.match(system, /Keep spelling, grammar and technical meaning correct, and never add mistakes on purpose/)
  assert.doesNotMatch(system, /misspell|typo|make (a few )?errors|deliberate(ly)? (error|mistake)|imperfect|sound (more )?human/i)
})

test('13. no promises: nothing in the prompt is about beating detection, and an answer that promises full marks or that it cannot be recognised is found', () => {
  const everything = [prompt('Explain paging. (10 marks)').system, STYLE_NATURAL, ...Object.values(COMMAND_GUIDE)].join('\n')
  assert.doesNotMatch(everything, /detector|undetectable|evade|bypass|turnitin/i)
  assert.match(STYLE_NATURAL, /never claim the answer will get full marks or cannot be recognised as machine-written/)
  for (const promise of ['This answer is undetectable.', 'It will not be detected by any checker.', 'You will get full marks with this.', 'I guarantee full marks.', 'This bypasses AI detection.']) {
    assert.equal(overclaimProblems(promise).length, 1, promise)
  }
  assert.deepEqual(overclaimProblems('Paging splits memory into fixed-size blocks.'), [])
})

test('14. the study style stays in the study pipeline: ordinary conversation, coding help and voice never receive it', () => {
  const chat = formatChatMessages([{ role: 'user', content: 'Write me a function that reverses a string.' }])
  const text = JSON.stringify(chat)
  assert.doesNotMatch(text, /Supplementary|kind="lecturer"|worth \d+ marks|ANSWER|everyday English|Not from your notes/)
  // and no module of the conversation, the voice assistant or the providers imports the academic style or prompt engine
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const users = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      if (statSync(file).isDirectory()) walk(file)
      else if (name.endsWith('.js') && !name.endsWith('.test.js') && /from ['"][^'"]*\/(answerStyle|responseEngine)\.js['"]/.test(readFileSync(file, 'utf8'))) users.push(path.relative(root, file))
    }
  }
  walk(root)
  assert.deepEqual(users.sort(), ['academic/answerCheck.js', 'academic/answerService.js', 'academic/questionAnalysis.js', 'academic/responseEngine.js', 'screenshots/screenshotPrompts.js'])
})

test('15. a diagram question gets a labelled diagram, or a clear text one, and an answer without one is sent back', () => {
  const { analysis, system } = prompt('Draw a diagram of client-server communication and explain it. (5 marks)')
  assert.equal(analysis.commands.includes('draw'), true)
  assert.match(system, /Draw \/ diagram: give a labelled diagram, as a plain-text diagram in a code block if you cannot draw one/)
  assert.match(system, /Client {2}---> {2}Request {2}---> {2}Server/)
  assert.match(system, /explain the main components and the direction of communication/)
  assert.equal(commandsOf('Sketch the stages.', []).includes('draw'), true)
  const text = 'Draw a diagram of client-server communication and explain it. (5 marks)'
  assert.deepEqual(check(text, 'The client asks and the server answers.').codes.includes('no-diagram'), true)
  assert.deepEqual(check(text, '```\nClient  --->  Request  --->  Server\nClient  <---  Response <---  Server\n```\nThe client sends a request; the server sends a response.').codes.includes('no-diagram'), false)
})

test('the command words of a question pick out the guidance it needs', () => {
  assert.deepEqual(commandsOf('Define cache memory and give two examples.', ['Define cache memory', 'give two examples']), ['define', 'state', 'illustrate'])
  assert.deepEqual(analyseQuestion({ text: 'State and explain two causes of inflation.' }).commands, ['state', 'explain'])
  assert.deepEqual(analyseQuestion({ text: 'Describe the stages of the compiler.' }).commands, ['describe'])
  assert.deepEqual(analyseQuestion({ text: 'Illustrate the idea with an example.' }).commands, ['illustrate'])
  assert.match(prompt('Describe the stages of the compiler. (5 marks)').system, /Describe: say the main features, parts, stages or characteristics, in a logical order/)
  assert.match(prompt('State three types of memory.').system, /State \/ list \/ identify \/ name: give the facts or points asked for with no introduction/)
})
