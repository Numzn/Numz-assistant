// The manual screenshot path with the REAL vision model: the screens of corpus.mjs analysed the way the chat's Screenshot button does it
// (server/screenshots/screenshotPrompts.js), checking that a question is answered, under ANSWER headings, in the size the question needs.
//
//   node scripts/smart-eval/manual.mjs [--root <checkout>] [--runs 1]
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { renderCorpus } from './corpus.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback)
const root = path.resolve(arg('root', path.resolve(here, '..', '..')))
const runs = Number.parseInt(arg('runs', '1'), 10) || 1
const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const env = {}
for (const file of ['.env', '.env.secrets']) {
  try {
    for (const line of readFileSync(path.join('/srv/projects/Numz-assistant', file), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  } catch {
    /* no file */
  }
}
const { createVisionFromEnv } = await imp('server/camera/vision.js')
const { buildAnalyzeMessages } = await imp('server/screenshots/screenshotPrompts.js')
const format = await import(pathToFileURL(path.join(root, 'server/academic/answerFormat.js')).href).catch(() => null)
const vision = createVisionFromEnv(env)
const corpus = await renderCorpus(path.join(os.tmpdir(), 'numz-smart-eval-corpus'))
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]
console.log(`manual screenshot analysis (${root}) — ${corpus.length} screens × ${runs}`)
let correct = 0
let total = 0
for (const s of corpus) {
  const times = []
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now()
    const text = await vision.answer({ messages: buildAnalyzeMessages(), image: { bytes: new Uint8Array(s.jpeg), mimeType: 'image/jpeg' } })
    const ms = performance.now() - t0
    times.push(ms)
    const parsed = format?.parseAnswers(text)
    const missing = s.expect.filter((re) => !re.test(text))
    const ok = missing.length === 0 && (s.parts ? (parsed?.parts.length ?? 0) >= s.parts : true)
    total++
    if (ok) correct++
    console.log(`${s.name.padEnd(10)} ${String(Math.round(ms)).padStart(6)} ms  ${String(text.split(/\s+/).length).padStart(4)}w  headings ${parsed ? (parsed.labelled ? parsed.parts.map((p) => p.label).join(', ') : 'none') : 'n/a'}  ${ok ? 'correct' : `NOT CORRECT ${missing.join(' ')}`}`)
  }
}
console.log(`\n${correct}/${total} correct`)
