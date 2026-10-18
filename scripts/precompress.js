/**
 * node scripts/precompress.js [dist]
 *
 * Runs after `vite build` (see the "build" script). Leaves Brotli and gzip copies of the built files for the
 * server to send as they are; see scripts/lib/precompress.js and server/http/staticAssets.js.
 */
import fs from 'node:fs'
import path from 'node:path'
import { precompressDir } from './lib/precompress.js'

const dir = path.resolve(process.argv[2] ?? 'dist')
if (!fs.existsSync(dir)) {
  console.error(`[precompress] ${dir} does not exist; run vite build first`)
  process.exit(1)
}

const kb = (bytes) => (bytes === null ? '-' : (bytes / 1024).toFixed(1).padStart(8))
const results = precompressDir(dir)
console.log(`[precompress] ${dir}`)
console.log('         raw KB   brotli KB     gzip KB  file')
for (const { file, raw, br, gz } of results) {
  console.log(`${kb(raw)}    ${kb(br)}    ${kb(gz)}  ${file}`)
}
