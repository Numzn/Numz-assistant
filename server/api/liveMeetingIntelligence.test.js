import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import express from 'express'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createMeetingRepository } from '../persistence/meetingRepository.js'
import { createSpeechSessionRepository } from '../persistence/speechSessionRepository.js'
import { createTranscriptRepository } from '../persistence/transcriptRepository.js'
import { createMeetingSessionService } from '../services/meetingSessionService.js'
import { createLiveMeetingIntelligence } from '../services/liveMeetingIntelligenceService.js'
import { createMeetingAuth } from '../auth/meetingAuth.js'
import { createMeetingsRouter } from '../routes/meetings.js'
import { errorHandler, notFoundHandler } from '../http/errorHandler.js'

/**
 * The pipeline from a persisted segment to a finding someone can ask about, through the real router, auth, service,
 * persistence (SQLite in memory) and event bus, over real HTTP. The model and the clock are stand-ins; what is under
 * test is everything the server does with them.
 */

const ADMIN = 'admin-token-'.padEnd(40, 'x')
const SECRET = 'ticket-secret-'.padEnd(40, 'y')
const quiet = { error() {}, warn() {}, info() {}, log() {} }
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

function manualTimers() {
  let id = 0
  const tasks = new Map()
  return {
    setTimeout(fn, ms) {
      const task = { id: ++id, fn, ms, unref() {} }
      tasks.set(task.id, task)
      return task
    },
    clearTimeout(task) {
      if (task) tasks.delete(task.id)
    },
    waiting: () => [...tasks.values()].map((task) => task.ms),
    async fire() {
      const due = [...tasks.values()]
      tasks.clear()
      for (const task of due) task.fn()
      await settle()
    }
  }
}

/** A model that answers per script and remembers what it was asked. */
function scriptedModel() {
  const calls = []
  const model = {
    calls,
    mode: 'good', // good | fail | junk | gate
    gate: null,
    async rolling(messages) {
      const prompt = messages[1].content
      calls.push(prompt)
      if (model.mode === 'gate') await model.gate
      if (model.mode === 'fail') throw Object.assign(new Error('provider down'), { statusCode: 502 })
      if (model.mode === 'junk') return 'I am sorry, I cannot do that.'
      const ids = [...prompt.matchAll(/\[(seg_[^ ]+) \|/g)].map((m) => m[1])
      const lines = prompt.split('New segments:\n')[1] ?? ''
      const firstId = ids[0]
      const decision = /decided|agreed/i.test(lines)
      return JSON.stringify({
        currentTopics: ids.length ? [{ topic: 'Launch planning and testing', source: { segmentIds: ids.slice(0, 2) } }] : [],
        decisions: decision ? [{ decision: 'Move the launch to Friday', source: { segmentIds: [firstId] } }] : [],
        openQuestions: [
          { question: 'Does the budget cover the servers?', source: { segmentIds: ['seg_does_not_exist'] } },
          { question: 'Budget for servers', source: { segmentIds: ids.slice(-1) } }
        ],
        actionItems: [],
        importantPoints: ids.length ? [{ point: 'Testing runs on Thursday', source: { segmentIds: ids.slice(-1) } }] : []
      })
    },
    async final({ segments }) {
      calls.push('FINAL')
      if (model.finalMode === 'fail') throw Object.assign(new Error('provider down'), { statusCode: 502 })
      if (model.finalMode === 'junk') return { notes: null, parseError: 'not json' }
      const first = segments[0].id
      return {
        notes: {
          summary: 'The team agreed to move the launch to Friday. Marcus approved 40000 dollars.',
          keyTopics: [{ topic: 'Launch date', source: { segmentIds: [first] } }],
          decisions: [{ decision: 'Launch moves to Friday', source: { segmentIds: [first] } }],
          actionItems: [{ action: 'Run the final testing', owner: 'Priya', due: 'by Thursday', source: { segmentIds: [segments[1].id] } }],
          openQuestions: [{ question: 'Does the budget cover the servers?', source: { segmentIds: ['seg_invented'] } }]
        }
      }
    },
    finalMode: 'good'
  }
  return model
}

function harness({ model = scriptedModel(), options = {} } = {}) {
  const database = createDatabase({ filename: ':memory:' })
  const eventBus = new EventEmitter()
  const meetingService = createMeetingSessionService({
    meetingRepository: createMeetingRepository(database),
    speechSessionRepository: createSpeechSessionRepository(database),
    transcriptRepository: createTranscriptRepository(database),
    eventBus
  })
  const timers = manualTimers()
  const live = createLiveMeetingIntelligence({
    meetingService,
    eventBus,
    generateRolling: (m) => model.rolling(m),
    generateFinal: (t) => model.final(t),
    timers,
    logger: quiet,
    ...options
  })
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode: '', logger: quiet })
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use((req, _res, next) => {
    req.id = 'test-request'
    next()
  })
  app.use('/api/v1/meetings', createMeetingsRouter({ meetingService, auth, liveIntelligence: live }))
  app.use('/api', notFoundHandler)
  app.use(errorHandler({ logger: quiet }))
  return { app, database, eventBus, meetingService, live, timers, model }
}

async function serve(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  return {
    base: `http://127.0.0.1:${server.address().port}/api/v1/meetings`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

async function call(base, method, path, { token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json }
}

const seg = (n, text, extra = {}) => ({
  id: `seg_${String(n).padStart(4, '0')}`,
  start: n * 10,
  end: n * 10 + 8,
  text,
  speaker: null,
  speakerConfidence: null,
  words: [],
  confidence: null,
  language: 'en',
  uncertain: false,
  ...extra
})

/** A live meeting with a speech session, as the browser and sidecar make it. */
async function liveMeeting(base) {
  const created = await call(base, 'POST', '/', { token: ADMIN, body: {} })
  const { meetingId, ticket } = created.json
  await call(base, 'POST', `/${meetingId}/start`, { token: ADMIN, body: {} })
  const session = (await call(base, 'POST', `/${meetingId}/sessions`, { token: ticket.token, body: {} })).json
  const put = (segment) =>
    call(base, 'POST', `/${meetingId}/transcript/final`, {
      token: ticket.token,
      body: { speechSessionId: session.speechSessionId, segment }
    })
  const finish = async ({ committed } = {}) => {
    await call(base, 'POST', `/${meetingId}/sessions/${session.speechSessionId}/end`, {
      token: ticket.token,
      body: committed === undefined ? { reason: 'stopped' } : { reason: 'stopped', committedSegments: committed }
    })
    return call(base, 'POST', `/${meetingId}/end`, { token: ticket.token, body: {} })
  }
  return { meetingId, ticket: ticket.token, session: session.speechSessionId, put, finish }
}

const getLive = (base, meetingId, token, query = '') => call(base, 'GET', `/${meetingId}/intelligence/live${query}`, { token })

const LINES = [
  'The team agreed to move the launch to Friday.',
  'Priya will run the final testing by Thursday.',
  'Does the budget cover the extra servers?'
]

test('a persisted segment reaches that meeting\'s tracker, is merged after the debounce, and is readable with its evidence', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    assert.equal((await m.put(seg(1, LINES[0]))).status, 201)
    assert.equal((await m.put(seg(2, LINES[1]))).status, 201)

    // Before the update: the words themselves are already findings, the model has not been asked.
    let state = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(state.phase, 'live')
    assert.equal(state.provisional, true)
    assert.equal(state.analysis.pendingSegments, 2)
    assert.equal(h.model.calls.length, 0)
    assert.deepEqual(state.findings.decisions.map((d) => [d.status, d.source.segmentIds[0]]), [['confirmed', 'seg_0001']])
    assert.deepEqual(h.timers.waiting(), [8000], 'one update is scheduled, not one per segment')

    await h.timers.fire()
    state = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(h.model.calls.length, 1)
    assert.equal(state.analysis.status, 'current')
    assert.equal(state.analysis.pendingSegments, 0)
    assert.equal(state.analysis.mergedSegments, 2)
    assert.ok(state.analysis.lastSuccessAt)
    assert.equal(state.findings.topics[0].text, 'Launch planning and testing')
    assert.deepEqual(state.findings.topics[0].source.segmentIds, ['seg_0001', 'seg_0002'])
    assert.equal(state.findings.topics[0].evidence[0].text, LINES[0], 'the quote is the saved line, not the model\'s words')
    assert.equal(state.findings.topics[0].status, 'inferred', 'a model reading is never confirmed')
    assert.equal(state.findings.notes[0].text, 'Testing runs on Thursday')
    assert.equal(state.findings.actionItems[0].owner.name, 'Priya')
    assert.equal(state.findings.actionItems[0].due, 'by Thursday')
  } finally {
    await close()
  }
})

test('a model citation to a segment that does not exist is dropped, and counted', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, LINES[2]))
    await h.timers.fire()
    const state = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(state.findings.rejected, 1)
    assert.deepEqual(state.findings.openQuestions.map((q) => q.text), ['Budget for servers'])
  } finally {
    await close()
  }
})

test('segments the store refused never reach the model', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    assert.equal((await m.put(seg(1, LINES[0]))).status, 201)
    const invalid = await m.put({ id: 'seg_bad', start: 5, end: 1, text: '' })
    assert.equal(invalid.status, 400)
    const conflict = await m.put({ ...seg(1, 'A DIFFERENT TEXT FOR THE SAME ID') })
    assert.equal(conflict.status, 409)
    await h.timers.fire()
    assert.equal(h.model.calls.length, 1)
    assert.doesNotMatch(h.model.calls[0], /A DIFFERENT TEXT/)
    assert.equal((h.model.calls[0].match(/seg_0001/g) ?? []).length, 1)
    const state = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(state.analysis.mergedSegments, 1)
    assert.equal(state.transcript.segmentCount, 1)
  } finally {
    await close()
  }
})

test('a segment delivered twice is analysed once', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    assert.equal((await m.put(seg(1, LINES[0]))).json.status, 'INSERTED')
    assert.equal((await m.put(seg(1, LINES[0]))).json.status, 'ALREADY_EXISTS')
    assert.equal((await m.put(seg(1, LINES[0]))).json.status, 'ALREADY_EXISTS')
    await h.timers.fire()
    assert.equal((h.model.calls[0].match(/seg_0001/g) ?? []).length, 1)
    assert.equal(h.live._runtime(m.meetingId).tracker.mergedCount(), 1)
  } finally {
    await close()
  }
})

test('segments that arrive out of order are analysed in timeline order', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(3, 'Third thing said.'))
    await m.put(seg(1, 'First thing said.'))
    await m.put(seg(2, 'Second thing said.'))
    await h.timers.fire()
    const order = [...h.model.calls[0].matchAll(/\[(seg_\d+) \|/g)].map((x) => x[1])
    assert.deepEqual(order, ['seg_0001', 'seg_0002', 'seg_0003'])
  } finally {
    await close()
  }
})

test('enough waiting segments update at once instead of waiting for the clock', async () => {
  const h = harness({ options: { flushAtSegments: 3 } })
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, 'One.'))
    await m.put(seg(2, 'Two.'))
    assert.equal(h.model.calls.length, 0)
    await m.put(seg(3, 'Three.'))
    await settle()
    assert.equal(h.model.calls.length, 1)
  } finally {
    await close()
  }
})

test('while an update runs, new segments wait for the next one, and the state says it is updating', async () => {
  const model = scriptedModel()
  let release
  model.mode = 'gate'
  model.gate = new Promise((resolve) => (release = resolve))
  const h = harness({ model })
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, 'First line said before.'))
    h.timers.fire() // starts the update, which is now held by the gate
    await settle()
    await m.put(seg(2, 'Second line said while the model thinks.'))
    const during = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(during.analysis.status, 'updating')
    assert.equal(during.analysis.pendingSegments, 2, 'nothing is lost or merged early')
    release()
    await settle()
    await settle()
    model.mode = 'good'
    const after = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(model.calls.length, 1, 'one update at a time')
    assert.equal(after.analysis.mergedSegments, 1)
    assert.equal(after.analysis.pendingSegments, 1)
    await h.timers.fire()
    assert.equal(model.calls.length, 2)
    assert.equal((model.calls[1].split('New segments:\n')[1].match(/seg_/g) ?? []).length, 1, 'only the late segment went again')
  } finally {
    await close()
  }
})

test('a provider failure keeps everything, says so, backs off, and recovers', async () => {
  const model = scriptedModel()
  const h = harness({ model })
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, LINES[0]))
    await h.timers.fire() // a good update first
    const good = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(good.analysis.status, 'current')
    const goodAt = good.analysis.lastSuccessAt

    model.mode = 'fail'
    await m.put(seg(2, LINES[1]))
    await h.timers.fire()
    const failed = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(failed.analysis.status, 'error')
    assert.equal(failed.analysis.error.code, 'update-failed')
    assert.match(failed.analysis.error.message, /provider down/)
    assert.equal(failed.analysis.pendingSegments, 1, 'the segment is still waiting')
    assert.equal(failed.analysis.lastSuccessAt, goodAt, 'the last SUCCESS is not moved by a failure')
    assert.equal(failed.findings.topics.length, 1, 'what was known is kept, and flagged as behind')
    assert.deepEqual(h.timers.waiting(), [15000], 'a retry is scheduled with backoff')
    assert.equal(h.live._runtime(m.meetingId).failures, 1)

    // it fails again: the backoff grows
    await h.timers.fire()
    assert.deepEqual(h.timers.waiting(), [30000])

    model.mode = 'good'
    await h.timers.fire()
    const healed = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(healed.analysis.status, 'current')
    assert.equal(healed.analysis.error, null)
    assert.equal(healed.analysis.pendingSegments, 0)
    assert.equal(healed.analysis.mergedSegments, 2)
  } finally {
    await close()
  }
})

test('an unusable model answer is an error, keeps the segments pending, and never touches the transcript', async () => {
  const model = scriptedModel()
  model.mode = 'junk'
  const h = harness({ model })
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, LINES[0]))
    await m.put(seg(2, LINES[1]))
    const before = h.meetingService.getTranscript(m.meetingId)
    await h.timers.fire()
    const state = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(state.analysis.status, 'error')
    assert.equal(state.analysis.error.code, 'model-output-unusable')
    assert.equal(state.analysis.pendingSegments, 2)
    assert.deepEqual(h.meetingService.getTranscript(m.meetingId), before, 'the canonical transcript is untouched')
    assert.equal(state.transcript.segmentCount, 2)
  } finally {
    await close()
  }
})

test('two meetings at once never see each other', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const a = await liveMeeting(base)
    const b = await liveMeeting(base)
    await a.put(seg(1, 'Alpha budget approved by the board.'))
    await b.put(seg(1, 'Bravo roadmap discussed with engineering.'))
    await h.timers.fire()
    const prompts = h.model.calls
    assert.equal(prompts.length, 2)
    assert.ok(prompts.some((p) => /Alpha budget/.test(p) && !/Bravo/.test(p)))
    assert.ok(prompts.some((p) => /Bravo roadmap/.test(p) && !/Alpha/.test(p)))
    const stateA = (await getLive(base, a.meetingId, a.ticket)).json
    const stateB = (await getLive(base, b.meetingId, b.ticket)).json
    assert.equal(stateA.meetingId, a.meetingId)
    assert.doesNotMatch(JSON.stringify(stateA), /Bravo/)
    assert.doesNotMatch(JSON.stringify(stateB), /Alpha/)
    assert.equal(stateA.transcript.segmentCount, 1)
  } finally {
    await close()
  }
})

test('access: no credential 401, another meeting\'s ticket 403, admin allowed, bad id 400, unknown meeting 404', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const a = await liveMeeting(base)
    const b = await liveMeeting(base)
    for (const path of ['/intelligence/live']) {
      assert.equal((await call(base, 'GET', `/${a.meetingId}${path}`)).status, 401)
      assert.equal((await call(base, 'GET', `/${a.meetingId}${path}`, { token: 'wrong' })).status, 401)
      assert.equal((await call(base, 'GET', `/${a.meetingId}${path}`, { token: b.ticket })).status, 403)
    }
    assert.equal((await call(base, 'POST', `/${a.meetingId}/intelligence/refresh`, { body: {} })).status, 401)
    assert.equal((await call(base, 'POST', `/${a.meetingId}/intelligence/refresh`, { token: b.ticket, body: {} })).status, 403)
    assert.equal((await getLive(base, a.meetingId, ADMIN)).status, 200)
    assert.equal((await getLive(base, a.meetingId, a.ticket)).status, 200)
    assert.equal((await getLive(base, 'not-a-uuid', ADMIN)).status, 400)
    assert.equal((await getLive(base, '11111111-1111-4111-8111-111111111111', ADMIN)).status, 404)
    assert.equal((await getLive(base, a.meetingId, a.ticket, '?since=abc')).status, 400)
    // a refused request created no runtime and no model call
    assert.equal(h.model.calls.length, 0)
    assert.equal(h.live._runtime('11111111-1111-4111-8111-111111111111'), null)
  } finally {
    await close()
  }
})

test('since: an unchanged revision costs nothing and rebuilds nothing', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, LINES[0]))
    const first = (await getLive(base, m.meetingId, m.ticket)).json
    const again = (await getLive(base, m.meetingId, m.ticket, `?since=${first.revision}`)).json
    assert.deepEqual(again, { schemaVersion: '1.0', meetingId: m.meetingId, revision: first.revision, unchanged: true })
    await m.put(seg(2, LINES[1]))
    const next = (await getLive(base, m.meetingId, m.ticket, `?since=${first.revision}`)).json
    assert.notEqual(next.unchanged, true)
    assert.ok(next.revision > first.revision)
  } finally {
    await close()
  }
})

test('closure: pending work is drained, then the final record is written from the VERIFIED transcript, grounded', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, LINES[0]))
    await m.put(seg(2, LINES[1]))
    await m.put(seg(3, LINES[2]))
    const ended = await m.finish({ committed: 3 })
    assert.equal(ended.status, 200)
    assert.equal(ended.json.integrity.verified, true)
    await settle()
    await settle()

    const state = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(state.phase, 'final')
    assert.equal(state.provisional, false)
    assert.equal(state.transcript.state, 'verified')
    assert.equal(state.final.status, 'ready')
    assert.equal(state.analysis.pendingSegments, 0, 'the pending segments were drained before the final pass')
    assert.ok(h.model.calls.indexOf('FINAL') > 0, 'the rolling update came first')
    assert.match(state.final.summary.text, /move the launch to Friday/)
    assert.deepEqual(state.final.summary.unsupportedTerms.sort(), ['40000', 'Marcus'])
    assert.equal(state.final.summary.status, 'uncertain')
    const fin = state.final.findings
    assert.equal(fin.rejected, 1, 'the open question that cited an invented segment')
    assert.ok(fin.decisions.some((d) => d.status === 'confirmed' && d.source.segmentIds[0] === 'seg_0001'))
    assert.equal(fin.actionItems[0].owner.name, 'Priya')
  } finally {
    await close()
  }
})

test('a transcript that could not be verified gets no final summary, only what the words state', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, LINES[0]))
    const ended = await m.finish() // the recording never confirmed its count
    assert.equal(ended.status, 200)
    assert.equal(ended.json.integrity.verified, false)
    await settle()
    await settle()
    const state = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(state.final.status, 'withheld')
    assert.equal(state.final.reason, 'transcript-unverified')
    assert.equal(state.provisional, true)
    assert.equal(state.final.summary, null)
    assert.ok(!h.model.calls.includes('FINAL'), 'the model was not asked to write a final record')
    assert.equal(state.findings.decisions[0].status, 'confirmed')
  } finally {
    await close()
  }
})

test('a failed final is reported, and asking again recovers it', async () => {
  const model = scriptedModel()
  model.finalMode = 'fail'
  const h = harness({ model })
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, LINES[0]))
    await m.put(seg(2, LINES[1]))
    await m.finish({ committed: 2 })
    await settle()
    await settle()
    let state = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(state.final.status, 'failed')
    assert.equal(state.final.reason, 'final-failed')
    assert.equal(state.provisional, true)
    assert.equal(state.transcript.state, 'verified', 'the transcript itself is fine and still verified')

    model.finalMode = 'good'
    const refreshed = await call(base, 'POST', `/${m.meetingId}/intelligence/refresh`, { token: m.ticket, body: {} })
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.json.final.status, 'ready')
    assert.equal(refreshed.json.provisional, false)
  } finally {
    await close()
  }
})

test('a refresh while the meeting is open runs the update and returns the new state', async () => {
  const h = harness()
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    await m.put(seg(1, LINES[0]))
    const res = await call(base, 'POST', `/${m.meetingId}/intelligence/refresh`, { token: m.ticket, body: {} })
    assert.equal(res.status, 200)
    assert.equal(res.json.analysis.status, 'current')
    assert.equal(res.json.analysis.mergedSegments, 1)
    assert.equal(h.model.calls.length, 1)
    // and a second refresh with nothing new asks the model nothing
    await call(base, 'POST', `/${m.meetingId}/intelligence/refresh`, { token: m.ticket, body: {} })
    assert.equal(h.model.calls.length, 1)
  } finally {
    await close()
  }
})

test('after a restart the runtime is rebuilt from the saved transcript and the model catches up', async () => {
  const first = harness()
  const { base, close } = await serve(first.app)
  let meetingId
  let ticket
  try {
    const m = await liveMeeting(base)
    meetingId = m.meetingId
    ticket = m.ticket
    await m.put(seg(1, LINES[0]))
    await m.put(seg(2, LINES[1]))
  } finally {
    await close()
  }
  // A second service over the SAME database: what a restarted server is.
  const model = scriptedModel()
  const eventBus = new EventEmitter()
  const meetingService = createMeetingSessionService({
    meetingRepository: createMeetingRepository(first.database),
    speechSessionRepository: createSpeechSessionRepository(first.database),
    transcriptRepository: createTranscriptRepository(first.database),
    eventBus
  })
  const timers = manualTimers()
  const live = createLiveMeetingIntelligence({
    meetingService,
    eventBus,
    generateRolling: (m) => model.rolling(m),
    generateFinal: (t) => model.final(t),
    timers,
    logger: quiet
  })
  const before = live.getState(meetingId)
  assert.equal(before.transcript.segmentCount, 2)
  assert.equal(before.analysis.pendingSegments, 2, 'what is saved is waiting to be analysed')
  await timers.fire()
  const after = live.getState(meetingId)
  assert.equal(after.analysis.status, 'current')
  assert.equal(after.analysis.mergedSegments, 2)
  assert.equal(after.findings.decisions[0].status, 'confirmed')
  assert.ok(ticket, 'the same meeting, the same ticket')
})

test('more segments than one prompt should hold are worked off in batches, none lost', async () => {
  const model = scriptedModel()
  const h = harness({ model, options: { maxModelBatch: 3, flushAtSegments: 100 } })
  const { base, close } = await serve(h.app)
  try {
    const m = await liveMeeting(base)
    for (let i = 1; i <= 7; i++) await m.put(seg(i, `Line number ${i} about the plan.`))
    assert.equal(h.live._runtime(m.meetingId).tracker.pendingCount(), 7)
    await h.timers.fire()
    const state = (await getLive(base, m.meetingId, m.ticket)).json
    assert.equal(model.calls.length, 3, '3 + 3 + 1 segments, not one prompt of 7')
    assert.equal(state.analysis.mergedSegments, 7)
    assert.equal(state.analysis.pendingSegments, 0)
    const sent = model.calls.map((prompt) => (prompt.split('New segments:\n')[1].match(/\[seg_/g) ?? []).length)
    assert.deepEqual(sent, [3, 3, 1])
  } finally {
    await close()
  }
})
