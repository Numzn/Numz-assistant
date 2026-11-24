// Measures the screenshot-to-answer pipeline with the REAL vision and answer models, stage by stage, on the corpus in corpus.mjs.
//
//   node scripts/smart-eval/run.mjs [--root <checkout>] [--runs 3] [--only mcq,calculate] [--label before] [--out result.json]
//
// `--root` is the checkout whose server code is measured (default: this one), so the same harness times the code before and after a change.
// The models' keys are read from the main checkout's .env and .env.secrets and are never printed. Nothing is deployed or written to the
// application's database: the stack lives in memory, like the tests'.
//
// Stages (milliseconds), per scenario and run:
//   read      the picture sent to the vision model, until the questions are known           (captureService.read)
//   classify  the question understood: kind, parts, strategy                                (pure, in process)
//   first     from asking for the answer until the first words can be shown                 (equal to `answer` when the answer is not streamed)
//   answer    from asking for the answer until it is complete                               (includes the lookup, the model and any checking)
//   total     read + answer: what the person waits for after the screen settles
// The HTTP hop between the page and the server and the desktop app's own capture are not included here (see docs/smart-screenshot.md).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { renderCorpus } from './corpus.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const root = path.resolve(arg('root', repo))
const runs = Number.parseInt(arg('runs', '3'), 10) || 3
const only = arg('only', '') ? new Set(arg('only').split(',')) : null
const label = arg('label', path.basename(root))
const outFile = arg('out', '')
const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href)

function loadEnv() {
  const env = {}
  for (const file of ['.env', '.env.secrets']) {
    let text = ''
    try {
      text = readFileSync(path.join('/srv/projects/Numz-assistant', file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return env
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null
}
const fmt = (n) => (n === null || n === undefined ? '   -  ' : `${Math.round(n)}`.padStart(6))
const wordsOf = (t) => String(t ?? '').split(/\s+/).filter(Boolean).length

const env = loadEnv()
const corpus = (await renderCorpus(path.join(os.tmpdir(), 'numz-smart-eval-corpus'))).filter((s) => !only || only.has(s.name))

const { rig, quiet } = await imp('server/academic/testSupport.js')
const { createAnswerService } = await imp('server/academic/answerService.js')
const { createCaptureService } = await imp('server/academic/captureService.js')
const { createKnowledgeService } = await imp('server/academic/knowledgeService.js')
const { createMemoryLaneManager } = await imp('server/academic/memoryLanes.js')
const { createSessionManager } = await imp('server/academic/sessionManager.js')
const { createKnowledgeRepository } = await imp('server/persistence/knowledgeRepository.js')
const { createSessionService } = await imp('server/sessions/sessionService.js')
const { createConversationRepository } = await imp('server/persistence/conversationRepository.js')
const { createVisionFromEnv } = await imp('server/camera/vision.js')
const { createAiProvider } = await imp('server/ai/providers/providerFactory.js')
const understanding = await imp('server/academic/questionUnderstanding.js')

const vision = createVisionFromEnv(env)
if (!vision.configured) throw new Error(`the vision service is not configured: ${vision.missing.join(', ')}`)
const provider = createAiProvider(env)

const usage = { vision: [], answer: [] }
const meter = {
  begin(_identity, kind) {
    const bucket = kind === 'academic_read' ? usage.vision : usage.answer
    return { signal: undefined, usage: (u) => bucket.push(u), finish() {}, fail() {} }
  }
}

const t = rig({ clock: { t: Date.now() } })
const knowledge = createKnowledgeRepository(t.database)
const knowledgeService = createKnowledgeService({ knowledge })
const sessions = createSessionManager({ academic: t.academic, clock: Date.now, ttlMs: 6 * 3_600_000, audit: t.audit })
const lanes = createMemoryLaneManager({ academic: t.academic, knowledge, sessionManager: sessions, audit: t.audit, clock: Date.now })
const conversations = createSessionService({ store: createConversationRepository(t.database), logger: quiet })
const captures = createCaptureService({ vision, sessionManager: sessions, courses: (u) => t.academic.forOwner(u).courses, now: Date.now, logger: quiet, limits: { minReadIntervalMs: 0 } })
const generate = (messages, opts = {}) => provider.generate({ messages, ...opts })
const stream = typeof provider.stream === 'function' ? (messages, opts = {}) => provider.stream({ messages, ...opts }) : undefined
const answers = createAnswerService({ generate, stream, knowledgeService, lanes, sessionManager: sessions, researchService: null, conversations, courses: (u) => t.academic.forOwner(u).courses, now: Date.now, audit: t.audit, logger: quiet })
const owner = t.who.alice
const myAnswers = answers.forOwner(owner)
const mySessions = sessions.forOwner(owner)
const myCaptures = captures.forOwner(owner)
const ctx = { identity: { ownerKey: owner }, requestId: 'eval', meter }

const results = []
console.log(`measuring ${label} (${root}) — ${corpus.length} screens × ${runs} runs, model ${env.AI_MODEL || '(default)'} / vision ${env.CAMERA_VISION_MODEL}`)

for (const scenario of corpus) {
  for (let run = 1; run <= runs; run++) {
    const session = mySessions.start({ type: 'study', captureEnabled: true })
    const row = { scenario: scenario.name, kind: scenario.kind, run, ok: false }
    try {
      usage.vision.length = 0
      usage.answer.length = 0
      const t0 = performance.now()
      const read = await myCaptures.read(session.id, { bytes: new Uint8Array(scenario.jpeg) }, ctx)
      row.read = performance.now() - t0
      const questions = (read.questions ?? []).filter((q) => !q.duplicate)
      row.questions = questions.length
      if (!questions.length) {
        row.error = `no question found (${read.status})`
        results.push(row)
        continue
      }
      const c0 = performance.now()
      const understood = questions.map((q) => (typeof understanding.analyseQuestion === 'function' ? understanding.analyseQuestion(q) : { task: understanding.classifyTask(q) }))
      row.classify = performance.now() - c0
      row.tasks = understood.map((u) => `${u.task}${u.complexity ? `/${u.complexity}` : ''}${u.parts?.length > 1 ? `/${u.parts.length}p` : ''}`)

      // The questions are answered the way the page does it for an automatic answer: all of them are asked for at once.
      const a0 = performance.now()
      let firstAt = null
      const hooks = { onEvent: (e) => { if (firstAt === null && (e.type === 'delta' || e.type === 'final')) firstAt = performance.now() } }
      const outcomes = await Promise.all(questions.slice(0, 3).map((q) => myAnswers.answer({ sessionId: session.id, questionId: q.id }, ctx, hooks)))
      row.answer = performance.now() - a0
      row.first = (firstAt ?? performance.now()) - a0
      const text = outcomes.map((o) => o.markdown ?? '').join('\n')
      row.words = wordsOf(text)
      row.parts = outcomes.reduce((n, o) => n + (o.parts?.length ?? 1), 0)
      row.understood = outcomes.map((o) => (o.analysis ? `${o.analysis.task}/${o.analysis.complexity}${o.analysis.parts ? `/${o.analysis.parts}p` : ''}` : o.task))
      row.timings = outcomes.map((o) => o.timings ?? null)
      row.checked = outcomes.map((o) => o.validation?.verdict ?? '-').join(',')
      row.calls = outcomes.reduce((n, o) => n + (o.validation?.calls ?? 1), 0)
      row.total = row.read + row.answer
      row.tokens = { visionIn: usage.vision.reduce((n, u) => n + (u.promptTokens ?? 0), 0), visionOut: usage.vision.reduce((n, u) => n + (u.completionTokens ?? 0), 0), answerIn: usage.answer.reduce((n, u) => n + (u.promptTokens ?? 0), 0), answerOut: usage.answer.reduce((n, u) => n + (u.completionTokens ?? 0), 0) }
      row.missing = scenario.expect.filter((re) => !re.test(text)).map(String)
      row.forbidden = (scenario.forbid ?? []).filter((re) => re.test(text)).map(String)
      row.partsOk = scenario.parts ? row.parts >= scenario.parts : true
      row.correct = row.missing.length === 0 && row.forbidden.length === 0 && row.partsOk
      row.sample = text.slice(0, 600)
      row.ok = true
    } catch (err) {
      row.error = `${err?.code ?? err?.name}: ${err?.message}`
    }
    results.push(row)
    console.log(`${scenario.name.padEnd(10)} #${run} read${fmt(row.read)} classify${fmt(row.classify)} first${fmt(row.first)} answer${fmt(row.answer)} total${fmt(row.total)}  ${String(row.words ?? '-').padStart(3)}w  ${row.ok ? (row.correct ? 'correct' : `NOT CORRECT ${row.missing.concat(row.forbidden).join(' ')}${row.partsOk ? '' : ' (parts)'}`) : row.error}`)
  }
}

const by = (name) => results.filter((r) => r.scenario === name && r.ok)
const summary = corpus.map((s) => {
  const rows = by(s.name)
  return { scenario: s.name, kind: s.kind, n: rows.length, read: median(rows.map((r) => r.read)), classify: median(rows.map((r) => r.classify)), first: median(rows.map((r) => r.first)), answer: median(rows.map((r) => r.answer)), total: median(rows.map((r) => r.total)), words: median(rows.map((r) => r.words)), correct: rows.filter((r) => r.correct).length }
})
const all = results.filter((r) => r.ok)
const overall = { read: median(all.map((r) => r.read)), first: median(all.map((r) => r.first)), answer: median(all.map((r) => r.answer)), total: median(all.map((r) => r.total)), words: median(all.map((r) => r.words)), correct: all.filter((r) => r.correct).length, runs: all.length, failed: results.length - all.length, modelCalls: all.reduce((n, r) => n + (r.calls ?? 1), 0) }
console.log('\nmedians (ms)')
console.log('scenario    kind                       read  first answer  total  words  correct')
for (const s of summary) console.log(`${s.scenario.padEnd(11)} ${s.kind.padEnd(24)} ${fmt(s.read)} ${fmt(s.first)} ${fmt(s.answer)} ${fmt(s.total)}  ${String(s.words ?? '-').padStart(4)}   ${s.correct}/${s.n}`)
console.log(`${'ALL'.padEnd(11)} ${''.padEnd(24)} ${fmt(overall.read)} ${fmt(overall.first)} ${fmt(overall.answer)} ${fmt(overall.total)}  ${String(overall.words ?? '-').padStart(4)}   ${overall.correct}/${overall.runs}${overall.failed ? `  (${overall.failed} failed)` : ''}`)

if (outFile) {
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
  writeFileSync(outFile, JSON.stringify({ label, root, at: new Date().toISOString(), model: env.AI_MODEL, vision: env.CAMERA_VISION_MODEL, runs, summary, overall, results: results.map(({ sample, ...r }) => ({ ...r, sample })) }, null, 2))
  console.log(`\nwritten to ${outFile}`)
}
