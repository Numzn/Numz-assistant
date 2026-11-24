// The size of the first load of the app (what tests/bundleBudget.test.js holds to a budget), for this checkout.
//   node scripts/smart-eval/size.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { firstLoad } from '../lib/bundleReport.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'numz-size-'))
const dist = path.join(scratch, 'dist')
await build({ root, configFile: path.join(root, 'vite.config.js'), logLevel: 'silent', envDir: path.join(scratch, 'no-env'), build: { outDir: dist, emptyOutDir: true, reportCompressedSize: false } })
const i = firstLoad(dist, 'index.html')
console.log(`scripts raw ${(i.scripts.raw / 1024).toFixed(1)} KB, gzip ${(i.scripts.gzip / 1024).toFixed(1)} KB, page brotli ${(i.totals.brotli / 1024).toFixed(1)} KB`)
fs.rmSync(scratch, { recursive: true, force: true })
