// The server half of the large-document measurement (scripts/knowledge-scale/run.mjs starts it): the REAL academic and knowledge routes, repository,
// background queue and chunker on a FILE database, in a process of their own, with a person signed in by fiat. It reports what the process costs:
// peak memory and how long its event loop was unable to answer (a timer meant to fire every 10 ms and is late), on /stats.
import { fileURLToPath } from 'node:url'
const R = fileURLToPath(new URL('../../', import.meta.url)) // the repository's root
const express = (await import('express')).default
const { createDatabase } = await import(`${R}server/persistence/sqliteDatabase.js`)
const { people } = await import(`${R}server/academic/testSupport.js`)
const { createAcademicRepository } = await import(`${R}server/persistence/academicRepository.js`)
const { createKnowledgeRepository } = await import(`${R}server/persistence/knowledgeRepository.js`)
const { createKnowledgeService } = await import(`${R}server/academic/knowledgeService.js`)
const { createMemoryLaneManager } = await import(`${R}server/academic/memoryLanes.js`)
const { createAcademicRouter } = await import(`${R}server/routes/academic.js`)
const { addKnowledgeRoutes } = await import(`${R}server/routes/academicKnowledge.js`)
const { LEGACY_IDENTITY, personIdentity } = await import(`${R}server/auth/identity.js`)
const { errorHandler } = await import(`${R}server/http/errorHandler.js`)
const { readKnowledgeLimits } = await import(`${R}server/academic/knowledgeLimits.js`)

const database = createDatabase({ filename: process.argv[2] })
const who = people(database)
const academic = createAcademicRepository(database)
const limits = readKnowledgeLimits()
const knowledge = createKnowledgeRepository(database, { limits })
const knowledgeService = createKnowledgeService({ knowledge })
const lanes = createMemoryLaneManager({ academic, knowledge, sessionManager: { forOwner: () => ({}) }, audit() {} })
const alice = personIdentity({ id: who.alice, external_id: 'a', email: 'alice@example.com', name: 'alice', role: 'viewer' }, { ref: 'r', csrf: 'x' })
const app = express()
app.use(express.json({ limit: '256kb' }))
app.use((req, _res, next) => { req.identity = alice; next() })
app.use('/academic', createAcademicRouter({ lanes, audit() {}, extend: [(router, helpers) => addKnowledgeRoutes(router, helpers, { knowledge, knowledgeService, limits })] }))
app.use(errorHandler({ logger: { error() {}, warn() {}, info() {}, log() {} } }))

// What the process costs: peak memory, and how long it was unable to answer anything (a timer that should fire every 10 ms and is late).
let peakRss = 0
let maxLag = 0
let last = performance.now()
setInterval(() => {
  const now = performance.now()
  const lag = now - last - 10
  if (lag > 400) console.error(`[loop blocked ${Math.round(lag)} ms at ${new Date().toISOString().slice(14, 23)}]`)
  maxLag = Math.max(maxLag, lag)
  last = now
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 10)
app.get('/stats', (_req, res) => res.json({ peakRssMB: Math.round(peakRss / 1048576), maxEventLoopLagMs: Math.round(maxLag), heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576), queued: knowledgeService.queued() }))
app.post('/reset-stats', (_req, res) => { peakRss = process.memoryUsage().rss; maxLag = 0; res.json({ ok: true }) })
const server = app.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })))
