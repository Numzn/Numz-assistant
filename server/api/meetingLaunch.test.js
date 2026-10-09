import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createMeetingRepository } from '../persistence/meetingRepository.js'
import { createSpeechSessionRepository } from '../persistence/speechSessionRepository.js'
import { createTranscriptRepository } from '../persistence/transcriptRepository.js'
import { createMeetingSessionService } from '../services/meetingSessionService.js'
import { createMeetingAuth } from '../auth/meetingAuth.js'
import { createMeetingsRouter } from '../routes/meetings.js'
import { MeetingDomainError } from '../meetings/meetingDomain.js'
import { errorHandler, notFoundHandler } from '../http/errorHandler.js'

/**
 * The browser's way in: POST /launch behind a launch code, and ending its own meeting with the ticket.
 * Real router, real auth, real SQLite (in memory), over real HTTP.
 */

const ADMIN = 'admin-token-'.padEnd(40, 'x')
const SECRET = 'ticket-secret-'.padEnd(40, 'y')
const LAUNCH = 'launch-code-for-tests-only'
const quiet = { error() {}, warn() {}, info() {}, log() {} }

function buildApp({ launchCode = LAUNCH, wrapService } = {}) {
  const database = createDatabase({ filename: ':memory:' })
  const real = createMeetingSessionService({
    meetingRepository: createMeetingRepository(database),
    speechSessionRepository: createSpeechSessionRepository(database),
    transcriptRepository: createTranscriptRepository(database)
  })
  const meetingService = wrapService ? wrapService(real) : real
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode, logger: quiet })
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use((req, _res, next) => {
    req.id = 'test-request'
    next()
  })
  app.use('/api/v1/meetings', createMeetingsRouter({ meetingService, auth }))
  app.use('/api', notFoundHandler)
  app.use(errorHandler({ logger: quiet }))
  return { app, real, database }
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

async function call(base, method, path, { token, code, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (code) headers['X-Meeting-Launch-Code'] = code
  let payload
  if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, headers: res.headers }
}

const meetingCount = (database) => database.prepare('SELECT count(*) AS n FROM meetings').get().n
const seg = (id, start, text) => ({ id, start, end: start + 1, text, speaker: null, words: [], confidence: null, language: 'en', uncertain: true })

test('a correct launch code creates a LIVE meeting and returns its own working ticket', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const launched = await call(base, 'POST', '/launch', { code: LAUNCH, body: { title: '  Weekly sync  ' } })
    assert.equal(launched.status, 201)
    assert.equal(launched.json.status, 'LIVE')
    assert.match(launched.json.meetingId, /^[0-9a-f-]{36}$/)
    assert.equal(typeof launched.json.ticket.token, 'string')
    assert.ok(Date.parse(launched.json.ticket.expiresAt) > Date.now())
    const { meetingId, ticket } = launched.json

    // The metadata says where it came from and keeps the trimmed title.
    const admin = await call(base, 'GET', `/${meetingId}`, { token: ADMIN })
    assert.equal(admin.json.metadata.source, 'browser')
    assert.equal(admin.json.metadata.title, 'Weekly sync')

    // The ticket does what a live client needs: attach a session and store a segment.
    const session = await call(base, 'POST', `/${meetingId}/sessions`, { token: ticket.token, body: {} })
    assert.equal(session.status, 201)
    const stored = await call(base, 'POST', `/${meetingId}/transcript/final`, {
      token: ticket.token,
      body: { speechSessionId: session.json.speechSessionId, segment: seg('seg_a_0001', 1, 'hello') }
    })
    assert.equal(stored.status, 201)
    assert.equal(stored.json.status, 'INSERTED')
  } finally {
    await close()
  }
})

test('a wrong, missing or unconfigured code creates nothing', async () => {
  const cases = [
    { name: 'missing', launchCode: LAUNCH, code: undefined, status: 401, error: 'launch-code-required' },
    { name: 'wrong', launchCode: LAUNCH, code: 'not-the-code-at-all', status: 401, error: 'launch-code-invalid' },
    { name: 'admin token offered instead', launchCode: LAUNCH, code: ADMIN, status: 401, error: 'launch-code-invalid' },
    { name: 'no code configured', launchCode: '', code: LAUNCH, status: 503, error: 'launch-not-configured' }
  ]
  for (const { name, launchCode, code, status, error } of cases) {
    const { app, database } = buildApp({ launchCode })
    const { base, close } = await serve(app)
    try {
      const res = await call(base, 'POST', '/launch', { code, body: {} })
      assert.equal(res.status, status, name)
      assert.equal(res.json.code, error, name)
      assert.equal(meetingCount(database), 0, `${name}: no meeting may be created`)
    } finally {
      await close()
    }
  }
})

test('ten wrong codes lock the endpoint with 429, even for the right code', async () => {
  const { app, database } = buildApp()
  const { base, close } = await serve(app)
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal((await call(base, 'POST', '/launch', { code: 'wrong-guess', body: {} })).status, 401)
    }
    const locked = await call(base, 'POST', '/launch', { code: LAUNCH, body: {} })
    assert.equal(locked.status, 429)
    assert.equal(locked.json.code, 'too-many-attempts')
    assert.ok(Number(locked.headers.get('retry-after')) >= 1)
    assert.equal(meetingCount(database), 0)
  } finally {
    await close()
  }
})

test('titles are validated: non-text and over-long are 400, blank is simply no title', async () => {
  const { app, database } = buildApp()
  const { base, close } = await serve(app)
  try {
    for (const title of [42, { a: 1 }, ['x'], 'x'.repeat(121)]) {
      const res = await call(base, 'POST', '/launch', { code: LAUNCH, body: { title } })
      assert.equal(res.status, 400)
      assert.equal(res.json.code, 'invalid-title')
    }
    assert.equal(meetingCount(database), 0, 'a rejected title must not leave a meeting behind')

    const blank = await call(base, 'POST', '/launch', { code: LAUNCH, body: { title: '   ' } })
    assert.equal(blank.status, 201)
    const admin = await call(base, 'GET', `/${blank.json.meetingId}`, { token: ADMIN })
    assert.equal(Object.hasOwn(admin.json.metadata, 'title'), false)
    assert.equal((await call(base, 'POST', '/launch', { code: LAUNCH })).status, 201, 'no body at all is fine')
  } finally {
    await close()
  }
})

test('a meeting that cannot be started is cancelled, not left half-made', async () => {
  const { app, real, database } = buildApp({
    wrapService: (service) => ({
      ...service,
      startMeeting() {
        throw new MeetingDomainError('cannot start right now', { statusCode: 409, code: 'invalid-meeting-transition' })
      }
    })
  })
  const { base, close } = await serve(app)
  try {
    const res = await call(base, 'POST', '/launch', { code: LAUNCH, body: {} })
    assert.equal(res.status, 409)
    assert.equal(meetingCount(database), 1)
    const row = database.prepare('SELECT meeting_id AS id FROM meetings').get()
    const meeting = real.getMeeting(row.id)
    assert.equal(meeting.status, 'CANCELLED')
    assert.equal(meeting.metadata.closeReason, 'launch-failed')
  } finally {
    await close()
  }
})

test('the ticket holder can end its own meeting and learns whether it was verified', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const { json: launched } = await call(base, 'POST', '/launch', { code: LAUNCH, body: {} })
    const { meetingId, ticket } = launched
    const session = (await call(base, 'POST', `/${meetingId}/sessions`, { token: ticket.token, body: {} })).json
    await call(base, 'POST', `/${meetingId}/transcript/final`, {
      token: ticket.token,
      body: { speechSessionId: session.speechSessionId, segment: seg('seg_b_0001', 1, 'one line') }
    })

    // Still recording: refused, and the meeting stays open.
    const early = await call(base, 'POST', `/${meetingId}/end`, { token: ticket.token, body: {} })
    assert.equal(early.status, 409)
    assert.equal(early.json.code, 'speech-session-active')

    // The transport reports it committed one segment, which is stored: verified.
    await call(base, 'POST', `/${meetingId}/sessions/${session.speechSessionId}/end`, {
      token: ticket.token,
      body: { reason: 'stopped', committedSegments: 1 }
    })
    const done = await call(base, 'POST', `/${meetingId}/end`, { token: ticket.token, body: {} })
    assert.equal(done.status, 200)
    assert.equal(done.json.status, 'COMPLETED')
    assert.equal(done.json.integrity.verified, true)
    assert.equal(done.json.integrity.complete, true)

    // Closed meetings take nothing more.
    const late = await call(base, 'POST', `/${meetingId}/transcript/final`, {
      token: ticket.token,
      body: { speechSessionId: session.speechSessionId, segment: seg('seg_b_0002', 2, 'too late') }
    })
    assert.equal(late.status, 409)
  } finally {
    await close()
  }
})

test('missing segments block the ticket holder from ending, and the report says how many', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const { json: launched } = await call(base, 'POST', '/launch', { code: LAUNCH, body: {} })
    const { meetingId, ticket } = launched
    const session = (await call(base, 'POST', `/${meetingId}/sessions`, { token: ticket.token, body: {} })).json
    await call(base, 'POST', `/${meetingId}/sessions/${session.speechSessionId}/end`, {
      token: ticket.token,
      body: { reason: 'stopped', committedSegments: 3 }
    })
    const blocked = await call(base, 'POST', `/${meetingId}/end`, { token: ticket.token, body: {} })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.json.code, 'transcript-incomplete')
    assert.equal(blocked.json.details.sessions.find((s) => s.state === 'INCOMPLETE').storedSegments, 0)
  } finally {
    await close()
  }
})

test('a ticket ends only its own meeting and nothing else on the lifecycle', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const a = (await call(base, 'POST', '/launch', { code: LAUNCH, body: {} })).json
    const b = (await call(base, 'POST', '/launch', { code: LAUNCH, body: {} })).json

    assert.equal((await call(base, 'POST', `/${b.meetingId}/end`, { token: a.ticket.token, body: {} })).status, 403, "A cannot end B")
    assert.equal((await call(base, 'POST', `/${a.meetingId}/end`, { body: {} })).status, 401, 'no credentials')
    assert.equal((await call(base, 'POST', `/${a.meetingId}/end`, { code: LAUNCH, body: {} })).status, 401, 'the launch code cannot end anything')

    for (const [method, path] of [
      ['POST', `/${a.meetingId}/cancel`],
      ['POST', `/${a.meetingId}/fail`],
      ['POST', `/${a.meetingId}/pause`],
      ['POST', `/${a.meetingId}/ticket`],
      ['GET', `/${a.meetingId}`],
      ['GET', `/${a.meetingId}/transcript`],
      ['GET', `/${a.meetingId}/sessions`],
      ['POST', '/']
    ]) {
      const res = await call(base, method, path, { token: a.ticket.token, body: method === 'GET' ? undefined : {} })
      assert.equal(res.status, 403, `${method} ${path} must stay admin-only`)
    }

    assert.equal((await call(base, 'POST', `/${a.meetingId}/end`, { token: a.ticket.token, body: {} })).status, 200)
    assert.equal((await call(base, 'GET', `/${b.meetingId}`, { token: ADMIN })).json.status, 'LIVE', 'B was never touched')
  } finally {
    await close()
  }
})

test('the admin create route still answers as before', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const created = await call(base, 'POST', '/', { token: ADMIN, body: { metadata: { room: 'A' } } })
    assert.equal(created.status, 201)
    assert.equal(created.json.status, 'CREATED')
    assert.equal(typeof created.json.ticket.token, 'string')
    assert.equal((await call(base, 'POST', '/', { code: LAUNCH, body: {} })).status, 401, 'the launch code is not an admin credential')
  } finally {
    await close()
  }
})
