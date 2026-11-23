// Large-document measurement: uploads one big text/markdown file to the real routes (a server of its own, see server.mjs) exactly as the page does (the file
// is streamed as the request body), then watches it be cut and indexed in the background while asking the server ordinary questions every 150 ms, and
// prints: how soon the upload was answered, how long until the document was ready, how many passages, a search, the latency of the ordinary requests,
// peak memory, and the size of the database.
//
//   node scripts/knowledge-scale/make-doc.mjs /tmp/big.md 99        a 99 MB markdown document of ordinary prose with headings
//   node scripts/knowledge-scale/run.mjs /tmp/big.md                the file must be under the server's limit (ACADEMIC_MAX_DOCUMENT_MB, 100 MB)
//
// Measured on this host (2026-11-23, busy, disk sync about 0.3 s): 99 MB answered in 2.1 s, ready in 104 s as 117,106 passages, a search in 176 ms,
// ordinary requests median 202 ms / p95 974 ms / worst 2.2 s, peak memory 507 MB, database 372 MB.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const dir = path.dirname(new URL(import.meta.url).pathname)
const file = process.argv[2]
if (!file) throw new Error('usage: node scripts/knowledge-scale/run.mjs <file.md>')
const db = path.join(process.env.TMPDIR ?? '/tmp', `knowledge-scale-${process.pid}.sqlite`)
for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true })
const child = spawn('node', ['--no-warnings', path.join(dir, 'server.mjs'), db], { env: { ...process.env, NUMZ_SKIP_ENV_FILES: '1' }, stdio: ['ignore', 'pipe', 'inherit'] })
const port = await new Promise((resolve) => child.stdout.on('data', (c) => { try { resolve(JSON.parse(String(c)).port) } catch {} }))
const base = `http://127.0.0.1:${port}/academic`
const j = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, json: await r.json().catch(() => null) } }
const t0 = performance.now()
const secs = () => ((performance.now() - t0) / 1000).toFixed(1)
console.log('limits:', JSON.stringify((await j('/limits')).json))
const course = (await j('/courses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Big' }) })).json
await fetch(base.replace('/academic', '') + '/reset-stats', { method: 'POST' })
const size = fs.statSync(file).size

// the server is asked small things all the while: how long does an ordinary request wait?
let worst = 0
let asked = 0
const lat = []
let failed = 0
const probe = setInterval(async () => { const s = performance.now(); try { await fetch(base + '/courses', { headers: { connection: 'close' } }).then((r) => r.text()); const took = performance.now() - s; lat.push([Math.round((s - t0) / 1000), took]); worst = Math.max(worst, took); asked++ } catch { failed++ } }, 150)

const up0 = performance.now()
const res = await fetch(`${base}/courses/${course.id}/documents?title=Big%20textbook&type=textbook`, { method: 'POST', headers: { 'content-type': 'text/markdown', 'content-length': String(size) }, body: fs.createReadStream(file), duplex: 'half' })
const created = await res.json()
console.log(`upload of ${(size / 1048576).toFixed(0)} MB answered ${res.status} in ${((performance.now() - up0) / 1000).toFixed(1)} s; status=${created.document?.status}, processing=${created.processing}`)
let doc = created.document
let ticks = 0
while (doc.status === 'processing') {
  await new Promise((r) => setTimeout(r, 1000))
  doc = (await j(`/courses/${course.id}/documents`)).json.documents[0]
  if (++ticks % 10 === 0) console.log(`  t+${secs()} s: ${doc.status}, ${doc.chunkCount} parts so far`)
}
console.log(`document ${doc.status} after ${secs()} s in total: ${doc.chunkCount} parts, ${(doc.chars / 1048576).toFixed(0)} MB of text${doc.error ? `, error: ${doc.error}` : ''}`)
clearInterval(probe)
const s0 = performance.now()
const found = (await j(`/search?course=${course.id}&q=${encodeURIComponent('Section 31337')}`)).json
console.log(`search: ${(performance.now() - s0).toFixed(0)} ms; first hit: ${found.passages?.[0]?.headingPath} (${found.passages?.length} passages)`)
const stats = await (await fetch(base.replace('/academic', '') + '/stats')).json()
const sorted = lat.map((l) => l[1]).sort((a, b) => a - b)
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(0)
const slowest = lat.reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0])
console.log(`ordinary request latency while processing: median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, p99 ${pct(0.99)} ms, slowest ${slowest[1].toFixed(0)} ms at t+${slowest[0]} s (of ${secs()} s)`)
console.log(`while it all ran: ${asked} ordinary requests (${failed} failed), the slowest took ${worst.toFixed(0)} ms; ${JSON.stringify(stats)}`)
console.log(`database file: ${(fs.statSync(db).size / 1048576).toFixed(0)} MB (+ wal ${(fs.existsSync(db + '-wal') ? fs.statSync(db + '-wal').size / 1048576 : 0).toFixed(0)} MB)`)
child.kill('SIGTERM')
for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`]) fs.rmSync(f, { force: true })
