import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { firstLoad, lazyScripts, readText } from '../scripts/lib/bundleReport.js'

/**
 * Builds the app for real (about two seconds) and holds the first page load to a budget. Before this work the
 * page shipped one 1.74 MB script (0.62 MB gzipped); the budgets below are about 1.5x what it is now, so they
 * catch a heavy dependency creeping back in, not ordinary growth. Raise one deliberately, with a reason.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KB = 1024
const BUDGET = {
  indexScriptsRaw: 220 * KB,
  indexScriptsGzip: 80 * KB,
  indexTotalBrotli: 75 * KB,
  historyTotalGzip: 20 * KB
}

/** Markers that appear only in the heavy libraries' code. */
const THREE_MARKERS = ['isWebGLRenderer', 'UnrealBloomPass']
const PICOVOICE_MARKERS = ['pv_porcupine']

let dist
let scratch

test.before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'numz-build-'))
  dist = path.join(scratch, 'dist')
  await build({
    root,
    configFile: path.join(root, 'vite.config.js'),
    logLevel: 'silent',
    // A developer's own .env must not change what is measured.
    envDir: path.join(scratch, 'no-env'),
    build: { outDir: dist, emptyOutDir: true, reportCompressedSize: false }
  })
})

test.after(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
})

test('the first load of the app is within budget', { timeout: 120_000 }, () => {
  const index = firstLoad(dist, 'index.html')
  const kb = (n) => `${(n / KB).toFixed(1)} KB`
  assert.ok(index.scripts.raw <= BUDGET.indexScriptsRaw, `scripts are ${kb(index.scripts.raw)} raw, budget ${kb(BUDGET.indexScriptsRaw)}`)
  assert.ok(index.scripts.gzip <= BUDGET.indexScriptsGzip, `scripts are ${kb(index.scripts.gzip)} gzipped, budget ${kb(BUDGET.indexScriptsGzip)}`)
  assert.ok(index.totals.brotli <= BUDGET.indexTotalBrotli, `page is ${kb(index.totals.brotli)} in Brotli, budget ${kb(BUDGET.indexTotalBrotli)}`)
  const history = firstLoad(dist, 'history.html')
  assert.ok(history.totals.gzip <= BUDGET.historyTotalGzip, `history page is ${kb(history.totals.gzip)} gzipped, budget ${kb(BUDGET.historyTotalGzip)}`)
})

test('no script loaded up front contains Three.js or the Picovoice SDK', () => {
  for (const page of ['index.html', 'history.html']) {
    for (const file of firstLoad(dist, page).files.filter((f) => f.kind === 'script')) {
      const code = readText(dist, file.url)
      for (const marker of [...THREE_MARKERS, ...PICOVOICE_MARKERS]) {
        assert.equal(code.includes(marker), false, `${file.url} (loaded by ${page}) contains ${marker}`)
      }
    }
  }
})

test('Three.js and the Picovoice SDK are built as separate files that are not loaded up front', () => {
  const lazy = lazyScripts(dist)
  const withMarker = (markers) => lazy.filter((f) => markers.every((m) => readText(dist, f.url).includes(m)))
  assert.equal(withMarker(THREE_MARKERS).length, 1, `lazy files: ${lazy.map((f) => f.url).join(', ')}`)
  assert.equal(withMarker(PICOVOICE_MARKERS).length, 1)
  assert.notEqual(withMarker(THREE_MARKERS)[0].url, withMarker(PICOVOICE_MARKERS)[0].url, 'each in its own file')
})

test('every file under /assets/ has a content hash, because the server caches that folder for a year', () => {
  const names = fs.readdirSync(path.join(dist, 'assets'))
  assert.ok(names.length >= 5)
  for (const name of names) {
    assert.match(name, /-[A-Za-z0-9_-]{8}\.[a-z]+$/, `${name} has no content hash and would be cached as immutable`)
  }
})

test('the HTML pages do not name any file by a path that could change under the same URL', () => {
  for (const page of ['index.html', 'history.html']) {
    const unhashed = firstLoad(dist, page).files.filter((f) => f.url !== `/${page}` && !f.url.startsWith('/assets/'))
    assert.deepEqual(unhashed.map((f) => f.url), [], `${page} loads a file outside /assets/ up front`)
  }
})
