/**
 * Question intelligence, the pure part: from the words of a question (and what is shown with it) to what the question WANTS, so that the
 * answer can be the right size and shape. It decides, with no model and no network (a few microseconds):
 *
 *   task        what kind of question it is: definition, explanation, list, comparison, discussion, evaluation, calculation, application,
 *               case study, multiple choice (the older tasks keep their names)
 *   parts       the labelled parts of a multi-part question, (a) (b) (c) / (i) (ii) (iii) / (1) (2) (3), each with its own task
 *   instructions every separate thing the question tells the student to do ("define X", "give two examples", "show your working")
 *   count       how many items it asks for ("list four", "give two reasons"), so that fewer is never presented as complete
 *   complexity  simple | moderate | complex: how much thinking the answer needs (this decides how much checking it gets)
 *
 * Everything here is a plain rule over text. A question it cannot place is "explain", and a question that is not quite what the rules expect
 * still gets an answer: the analysis only shapes and checks it, it never refuses.
 */

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const COUNT = '(one|two|three|four|five|six|seven|eight|nine|ten|\\d{1,2})'

const DIRECTIVES = [
  'define', 'state', 'explain', 'describe', 'outline', 'list', 'name', 'identify', 'give', 'suggest', 'recommend', 'advise', 'compare', 'contrast', 'distinguish',
  'discuss', 'evaluate', 'assess', 'analyse', 'analyze', 'justify', 'calculate', 'compute', 'work out', 'find', 'solve', 'determine', 'show', 'illustrate',
  'summarise', 'summarize', 'differentiate', 'examine', 'comment on', 'argue', 'predict', 'derive', 'prove', 'interpret', 'critique', 'propose', 'provide', 'draw', 'sketch', 'label', 'apply', 'use'
]
const DIRECTIVE_AT_START = new RegExp(`^(?:${DIRECTIVES.join('|')})\\b`, 'i')
const DIRECTIVE_AFTER_AND = new RegExp(`\\s*(?:,|;|\\band\\b|\\bthen\\b|\\balso\\b)\\s+(?=(?:${DIRECTIVES.join('|')})\\b)`, 'i')

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x']
const LETTERS = 'abcdefgh'.split('')
const SCHEMES = [LETTERS, ROMAN, ['1', '2', '3', '4', '5', '6', '7', '8']]

const stripNumbering = (text) => String(text ?? '').trim().replace(/^\(?\d+[.)]\s*|^\(?[a-z][.)]\s+/i, '').replace(/^(?:question|q)\s*\d+[.:)]?\s*/i, '')
const wordsIn = (text) => String(text ?? '').split(/\s+/).filter(Boolean).length

/** The marks a question is worth, from "(4 marks)", "[6]", "5 marks" or a bare number (the reading's own field), else null. */
export function marksOf(marks, text = '') {
  const own = String(marks ?? '').match(/\d+(?:\.\d+)?/)
  if (own) return Number(own[0])
  const inText = String(text).match(/[(\[]\s*(\d{1,2})\s*(?:marks?|pts?|points?)?\s*[)\]]\s*$/i) ?? String(text).match(/\b(\d{1,2})\s*marks?\b/i)
  return inText ? Number(inText[1]) : null
}

/** How many items the question asks for ("list four functions", "give 3 examples"), or null. */
export function requiredCount(text) {
  const t = String(text ?? '')
  const direct = t.match(new RegExp(`\\b(?:list|name|state|give|identify|outline|suggest|recommend|provide|mention|write down|describe|explain|advise on|propose)\\b[^.?!\\n]{0,40}?\\b(?:any\\s+)?${COUNT}\\b(?!\\s*(?:%|percent|marks?|km|kg|m\\b|cm|hours?|years?|minutes?|days?))`, 'i'))
  const asked = direct ?? t.match(new RegExp(`\\b${COUNT}\\s+(?:actions?|ways?|reasons?|examples?|factors?|steps?|features?|advantages?|disadvantages?|functions?|types?|kinds?|causes?|effects?|differences?|similarities|points?|arguments?|methods?|benefits?|problems?|solutions?|characteristics|stages?|principles?|elements?|components?)\\b`, 'i'))
  if (!asked) return null
  const raw = asked[1].toLowerCase()
  const n = WORD_NUMBERS[raw] ?? Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 2 && n <= 10 ? n : null
}

/** Every separate thing the question tells the student to do, as short phrases, in order. */
export function instructionsOf(text) {
  const out = []
  const sentences = String(text ?? '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.?!])\s+|\n/)
  for (const sentence of sentences) {
    const clean = stripNumbering(sentence)
    const clauses = clean.split(DIRECTIVE_AFTER_AND).map((c) => c.trim()).filter(Boolean)
    for (const clause of clauses) if (DIRECTIVE_AT_START.test(clause)) out.push(clause.replace(/[\s.?!,;:]+$/, '').slice(0, 140))
  }
  return out.slice(0, 8)
}

/** Which of the known schemes a label belongs to, and where in it. */
function schemeOf(label) {
  const l = label.toLowerCase()
  for (const scheme of SCHEMES) {
    const at = scheme.indexOf(l)
    if (at !== -1) return { scheme, at }
  }
  return null
}

/**
 * The labelled parts of a multi-part question. Markers are (a) (b), a) b), (i) (ii), (1) (2), or 1. 2. / a. b. at the start of a line;
 * they count only when there are at least two and they follow each other from the start of their scheme, so "e.g." and "No. 3" are not
 * parts. Only lowercase letters are parts: capital letters (A) B) C)) are the options of a multiple-choice question, see `extractOptions`.
 */
export function splitParts(text) {
  const source = String(text ?? '')
  const markers = []
  const pattern = /(?:^|(?<=\s))(?:\(([a-hivx]{1,4}|\d{1,2})\)|([a-h]|[ivx]{1,4}|\d{1,2})\)|^([a-h1-9])\.)(?=\s)/gm
  for (const m of source.matchAll(pattern)) {
    const label = (m[1] ?? m[2] ?? m[3]).toLowerCase()
    if (!schemeOf(label)) continue
    const lineStart = m.index === 0 || source[m.index - 1] === '\n'
    // "1." and "a." count only at the start of a line; a closing bracket marker may sit mid-line after a full stop.
    if (m[3] && !lineStart) continue
    markers.push({ label, index: m.index, end: m.index + m[0].length })
  }
  // The longest run that follows its scheme from the start (a, b, c ... or i, ii ... or 1, 2 ...).
  for (const scheme of SCHEMES) {
    const run = []
    for (const marker of markers) {
      const info = schemeOf(marker.label)
      if (info?.scheme !== scheme) continue
      if (info.at === run.length) run.push(marker)
    }
    if (run.length >= 2) {
      const stem = source.slice(0, run[0].index).trim()
      const parts = run.map((marker, i) => ({ key: marker.label, label: `(${marker.label})`, text: source.slice(marker.end, run[i + 1]?.index ?? source.length).trim() })).filter((p) => p.text)
      if (parts.length >= 2) return { stem, parts }
    }
  }
  return { stem: source.trim(), parts: [] }
}

/**
 * The options of a multiple-choice question typed (or copied) into its text: "What is 2+2? A) 3 B) 4 C) 5". Capital letters in order from A,
 * at least two, after a stem. Returns `{ stem, options }` or null. A question that already comes with its options never needs this.
 */
export function extractOptions(text) {
  const source = String(text ?? '')
  const found = []
  for (const m of source.matchAll(/(?:^|(?<=\s))\(?([A-H])[.)]\s+(?=\S)/g)) {
    if (m[1].charCodeAt(0) - 65 === found.length) found.push({ label: m[1], index: m.index, end: m.index + m[0].length })
  }
  if (found.length < 2) return null
  const stem = source.slice(0, found[0].index).trim()
  if (!stem) return null
  const options = found.map((f, i) => ({ label: f.label, text: source.slice(f.end, found[i + 1]?.index ?? source.length).trim().replace(/[;,]$/, '') })).filter((o) => o.text)
  return options.length >= 2 ? { stem, options } : null
}

/** The kind of task a question sets, from how it begins (and what it carries). Decides the shape of the answer: never one template for everything. */
export function classifyTask(question) {
  const raw = String(question?.text ?? question ?? '')
  const text = stripNumbering(raw).toLowerCase()
  if (question?.options?.length >= 2 || question?.type === 'multiple-choice' || question?.type === 'true-false') return 'multiple_choice'
  const rules = [
    ['calculate', /^(calculate|compute|work out|find the (value|sum|product|area|volume|mean|average|total|rate|percentage|cost|profit|interest)|solve|determine the (value|amount|rate|total)|how (much|many|far|long|fast)\b.*\d)/],
    ['define', /^(define|what is meant by|state the meaning of|what does .* mean|give the (meaning|definition) of)/],
    ['compare', /^(compare|contrast|differentiate|distinguish between|what is the difference between|what are the differences between|how (does|do|is|are) .* differ)/],
    ['evaluate', /^(evaluate|assess|critically (assess|evaluate|examine)|to what extent|justify|how effective|how successful|is it (true|right|fair|worth)|do you agree)/],
    ['analyse', /^(analy[sz]e|examine|investigate|break down|what (are|were) the (causes|effects|implications|consequences|reasons))/],
    ['discuss', /^(discuss|argue|debate|consider|comment on|review|critique)/],
    ['list', /^(list|enumerate|name|identify|give|state|outline|mention|write down|suggest|provide)\b[^?]*\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|several|some|any)\b|^(list|enumerate)\b|^what are the (types|kinds|stages|steps|features|advantages|disadvantages|characteristics|functions|principles|elements|components|methods|examples|benefits|problems) of/],
    ['apply', /^(apply|use the|using the|how would you|what would happen|how could|how can .* (be )?(used|applied)|advise|recommend|suggest (how|what|a way|an? )|predict|in the context of|illustrate (how|with))/],
    ['explain', /^(explain|describe|outline|illustrate|why|how|what is|what are|state)/]
  ]
  for (const [task, pattern] of rules) if (pattern.test(text)) return task
  return 'explain'
}

/**
 * A scenario to work from, and the question asked about it. A scenario is a passage shown with the question (related content), or a long
 * stem (about three sentences of situation) before the sentence that gives the instruction. `ask` is that instruction onwards: it is what the
 * kind of task is read from, since the situation is not what the question asks.
 */
function scenarioOf({ text, related }) {
  const passage = (related ?? []).some((r) => ['paragraph', 'other', 'instructions'].includes(r.kind) && wordsIn(r.text) >= 35)
  const marked = /\bcase study\b|\bscenario\b/i.test(text)
  const sentences = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.?!])\s+/)
  let before = 0
  for (let i = 0; i < sentences.length; i++) {
    const sentence = stripNumbering(sentences[i]).replace(/^(?:question|task)\s*[:\-]\s*/i, '')
    if (i > 0 && before >= 35 && DIRECTIVE_AT_START.test(sentence)) return { scenario: true, ask: sentences.slice(i).join(' ').replace(/^(?:question|task)\s*[:\-]\s*/i, '') }
    before += wordsIn(sentences[i])
  }
  return { scenario: passage || marked, ask: null }
}

const COMPLEX_TASKS = new Set(['evaluate', 'discuss', 'analyse', 'case_study'])

function complexityOf({ task, parts, marks, words, instructions, caseStudy, numbers }) {
  if (parts.length >= 3 || caseStudy || COMPLEX_TASKS.has(task)) return 'complex'
  if ((marks ?? 0) >= 6 || instructions.length >= 4) return 'complex'
  if (task === 'calculate' && (numbers >= 5 || (marks ?? 0) >= 4)) return 'complex'
  if (parts.length === 2) return 'moderate'
  if (task === 'multiple_choice') return 'simple'
  if (task === 'define' && (marks ?? 2) <= 3) return 'simple'
  if (task === 'explain' && words <= 10 && (marks ?? 1) <= 2 && instructions.length <= 1) return 'simple'
  return 'moderate'
}

const FORMAT = { multiple_choice: 'multiple-choice', calculate: 'calculation', define: 'definition', list: 'list', compare: 'comparison', evaluate: 'evaluation', discuss: 'discussion', analyse: 'analysis', apply: 'application', case_study: 'case study', explain: 'explanation' }

/**
 * @param {{ text: string, options?: object[], type?: string, marks?: string|number|null }} question
 * @param {{ related?: { kind: string, text: string }[] }} [context]  other content on the same screen that the question refers to
 * @returns {{ task: string, format: string, complexity: 'simple'|'moderate'|'complex', parts: object[], stem: string, instructions: string[], count: number|null, marks: number|null, caseStudy: boolean, ownLabel: string|null, review: boolean }}
 */
export function analyseQuestion(question, { related = [] } = {}) {
  const given = String(question?.text ?? question ?? '')
  // Options written into the text of a typed question are found here; a question that comes with its options is used as it is.
  const inline = (question?.options?.length ?? 0) >= 2 ? null : extractOptions(given)
  const text = inline ? inline.stem : given
  const options = inline ? inline.options : question?.options ?? []
  const isChoice = options.length >= 2 || question?.type === 'multiple-choice' || question?.type === 'true-false'
  const { stem, parts } = isChoice ? { stem: text.trim(), parts: [] } : splitParts(text)
  const found = isChoice ? { scenario: false, ask: null } : scenarioOf({ text, related })
  const caseStudy = found.scenario
  const baseTask = isChoice ? 'multiple_choice' : classifyTask(found.ask ?? (parts.length ? stem || parts[0].text : question))
  const scenarioTask = caseStudy && !['calculate', 'define', 'multiple_choice'].includes(baseTask) ? 'case_study' : baseTask
  const marks = marksOf(question?.marks, text)
  const instructions = instructionsOf(parts.length ? `${stem}\n${parts.map((p) => p.text).join('\n')}` : text)
  const numbers = (text.match(/\d[\d,.]*/g) ?? []).length
  const words = wordsIn(text)
  const partsOut = parts.map((p) => ({ ...p, task: classifyTask({ text: p.text, options: [] }), count: requiredCount(p.text), marks: marksOf(null, p.text) }))
  const task = scenarioTask
  const complexity = complexityOf({ task, parts, marks, words, instructions, caseStudy, numbers })
  // A question that is itself one part of a bigger one (the vision model often lists (a) (b) (c) as separate questions) keeps its own label.
  const own = String(text).match(/^\s*\(?([a-h]|[ivx]{1,4})\)\s/i)
  return {
    task,
    format: FORMAT[task] ?? 'explanation',
    complexity,
    parts: partsOut,
    stem,
    instructions,
    count: parts.length ? null : requiredCount(text),
    marks,
    caseStudy,
    options,
    ownLabel: own && !parts.length ? own[1].toLowerCase() : null,
    review: complexity === 'complex'
  }
}

