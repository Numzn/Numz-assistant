/**
 * node scripts/bundle-report.js [dist]
 *
 * Prints what a visitor downloads for each page ("first load") and what is built but waits until it is needed
 * ("lazy"). Sizes are raw, gzip -9 and Brotli 11 of each file. Run it after `npm run build`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { firstLoad, lazyScripts } from './lib/bundleReport.js'

const dir = path.resolve(process.argv[2] ?? 'dist')
if (!fs.existsSync(path.join(dir, 'index.html'))) {
  console.error(`[bundle-report] ${dir}/index.html not found; run the build first`)
  process.exit(1)
}

const kb = (bytes) => (bytes / 1024).toFixed(1).padStart(9)
const row = (label, s) => console.log(`${kb(s.raw)} ${kb(s.gzip)} ${kb(s.brotli)}  ${label}`)

for (const page of ['index.html', 'history.html']) {
  if (!fs.existsSync(path.join(dir, page))) continue
  const result = firstLoad(dir, page)
  console.log(`\nFirst load of ${page}`)
  console.log('   raw KB   gzip KB  brotli KB')
  for (const file of result.files) row(file.url, file)
  row('TOTAL', result.totals)
}

const lazy = lazyScripts(dir)
console.log('\nLazy (built, fetched only when needed)')
console.log('   raw KB   gzip KB  brotli KB')
for (const file of lazy) row(file.url, file)
