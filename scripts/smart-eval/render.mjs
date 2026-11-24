// Times how long the page takes to draw an answer, in a real browser: the answer's Markdown to DOM (with answer blocks where the text has
// ANSWER headings), on answers of the sizes the study panel shows.
//
//   node scripts/smart-eval/render.mjs [--root <checkout>] [--reps 200]
//
// The page's own renderer (src/interfaces/chat/markdownView.js) is bundled with esbuild (a dependency of vite) and loaded into an empty
// Chromium page: nothing else of the app is involved, so what is measured is the drawing. `--root` selects the checkout, so the same script
// times the code before and after a change (before the change the same text has no headings and is drawn as plain Markdown).

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const root = path.resolve(arg('root', path.resolve(here, '..', '..')))
const reps = Number.parseInt(arg('reps', '200'), 10) || 200
// `--plain`: the answer as it was written before answer blocks (no ANSWER headings), for timing a checkout that does not have them
const labelled = !argv.includes('--plain')

const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM || '/srv/projects/ZEDFOOTBALL/frontend/package.json')('playwright')

const bundle = await build({ entryPoints: [path.join(root, 'src/interfaces/chat/markdownView.js')], bundle: true, format: 'iife', globalName: 'View', write: false, logLevel: 'silent' })
const code = bundle.outputFiles[0].text

const LONG = 'Rent control sets a legal maximum on rents, so it helps sitting tenants straight away but it does not make housing affordable for everyone. '.repeat(5)
const SAMPLES = {
  'one line (multiple choice)': (labelled) => `${labelled ? '#### ANSWER\n\n' : ''}**B) 60 km/h**`,
  'short paragraph (definition)': (labelled) => `${labelled ? '#### ANSWER\n\n' : ''}Opportunity cost is the value of the next best alternative that you give up when you make a choice.`,
  'list and table (comparison)': (labelled) => `${labelled ? '#### ANSWER\n\n' : ''}- TCP is connection-oriented; UDP is connectionless.\n- TCP is reliable (acknowledgements); UDP is not.\n- UDP is faster.\n\n| | TCP | UDP |\n|---|---|---|\n| Setup | handshake | none |\n| Delivery | ordered | not guaranteed |`,
  'three parts (a)(b)(c)': (labelled) => (labelled ? `#### ANSWER (a)\n\nA general rise in prices.\n\n#### ANSWER (b)\n\n**5%**\n\n- (210 - 200) / 200 x 100\n\n#### ANSWER (c)\n\nSavings buy less over time.` : `(a) A general rise in prices.\n\n(b) **5%**\n\n- (210 - 200) / 200 x 100\n\n(c) Savings buy less over time.`),
  'long essay (evaluation)': (labelled) => `${labelled ? '#### ANSWER\n\n' : ''}${LONG}\n\n**For**\n\n- ${LONG}\n- ${LONG}\n\n**Against**\n\n- ${LONG}\n\n${LONG}`
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent('<!doctype html><body><div id="host"></div></body>')
await page.addScriptTag({ content: code })
const rows = await page.evaluate(
  ({ samples, reps }) => {
    const host = document.getElementById('host')
    const median = (xs) => xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]
    const out = []
    for (const [name, text] of Object.entries(samples)) {
      const times = []
      for (let i = 0; i < reps + 20; i++) {
        const t = performance.now()
        View.renderMarkdown(host, text, document)
        host.offsetHeight // layout is part of what the person waits for
        if (i >= 20) times.push(performance.now() - t)
      }
      out.push({ name, ms: median(times), blocks: host.querySelectorAll('.answer-block').length, copy: host.querySelectorAll('.answer-copy').length })
    }
    return out
  },
  { samples: Object.fromEntries(Object.entries(SAMPLES).map(([k, f]) => [k, f(labelled)])), reps }
)
await browser.close()
console.log(`render time per answer, median of ${reps} (ms)  — ${root}`)
for (const r of rows) console.log(`${r.name.padEnd(30)} ${r.ms.toFixed(2).padStart(7)} ms   blocks ${r.blocks}   copy icons ${r.copy}`)
