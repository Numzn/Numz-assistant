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
import { errorHandler, notFoundHandler } from '../http/errorHandler.js'

const ADMIN = 'admin-token-'.padEnd(40, 'x')
const SECRET = 'ticket-secret-'.padEnd(40, 'y')
const quiet = { error() {}, warn() {}, info() {}, log() {} }

/** Builds the real router + auth + error handling in-process, with a controllable clock. */
function buildApp({ clock = { now: () => Date.now() }, adminToken = ADMIN, ticketSecret = SECRET, ticketTtlSeconds, service, logger = quiet } = {}) {
  const database = createDatabase({ filename: ':memory:' })
  const meetingService =
    service ??
    createMeetingSessionService({
      meetingRepository: createMeetingRepository(database),
      speechSessionRepository: createSpeechSessionRepository(database),
      transcriptRepository: createTranscriptRepository(database),
      clock: clock.now
    })
  const auth = createMeetingAuth({ adminToken, ticketSecret, ticketTtlSeconds, clock: clock.now, logger })
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use((req, _res, next) => {
    req.id = 'test-request'
    next()
  })
  app.use('/api/v1/meetings', createMeetingsRouter({ meetingService, auth }))
  app.use('/api', notFoundHandler)
  app.use(errorHandler({ logger }))
  return { app, meetingService, database }
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

async function call(base, method, path, { token, body, raw } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  let payload
  if (raw !== undefined) {
    payload = raw
    headers['Content-Type'] = 'application/json'
  } else if (body !== undefined) {
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
  return { status: res.status, json, text, headers: res.headers }
}

const seg = (id, start, text) => ({ id, start, end: start + 1, text, speaker: null, words: [], confidence: null, language: 'en', uncertain: true })
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('client mistakes map to 400, 404 and 409 with stable codes, never 500 and never a stack', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const admin = (method, path, extra) => call(base, method, path, { token: ADMIN, ...extra })

    const badId = await admin('POST', '/not-a-uuid/start')
    assert.equal(badId.status, 400)
    assert.equal(badId.json.code, 'invalid-meeting-id')

    const badMeta = await admin('POST', '', { body: { metadata: [1, 2] } })
    assert.equal(badMeta.status, 400)
    assert.equal(badMeta.json.code, 'invalid-metadata')

    const malformed = await admin('POST', '', { raw: '{"metadata": ' })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.json.code, 'bad-request')
    assert.doesNotMatch(malformed.text, /\n\s+at /, 'no stack frames in the response')

    const missing = await admin('GET', `/${UUID(999)}`)
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'meeting-not-found')

    const created = await admin('POST', '', { body: {} })
    assert.equal(created.status, 201)
    const id = created.json.meetingId
    const pause = await admin('POST', `/${id}/pause`)
    assert.equal(pause.status, 409)
    assert.equal(pause.json.code, 'invalid-meeting-transition')

    const unknownRoute = await call(base, 'GET', '/../../nothing', { token: ADMIN })
    assert.ok([404, 400].includes(unknownRoute.status))
  } finally {
    await close()
  }
})

test('authentication: missing, wrong, forged and cross-meeting credentials are refused', async () => {
  const { app, meetingService } = buildApp()
  const { base, close } = await serve(app)
  try {
    const created = await call(base, 'POST', '', { token: ADMIN, body: {} })
    const meetingId = created.json.meetingId
    const ticket = created.json.ticket.token
    const other = (await call(base, 'POST', '', { token: ADMIN, body: {} })).json

    const anonymous = await call(base, 'GET', `/${meetingId}`)
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.code, 'auth-required')
    assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer')

    const wrong = await call(base, 'GET', `/${meetingId}`, { token: 'x'.repeat(40) })
    assert.equal(wrong.status, 401)

    const ticketOnAdminRoute = await call(base, 'GET', `/${meetingId}`, { token: ticket })
    assert.equal(ticketOnAdminRoute.status, 403)
    assert.equal(ticketOnAdminRoute.json.code, 'forbidden')

    const crossMeeting = await call(base, 'POST', `/${other.meetingId}/sessions`, { token: ticket, body: {} })
    assert.equal(crossMeeting.status, 403, 'a ticket for meeting A must not write to meeting B')

    const forged = ticket.slice(0, -4) + 'AAAA'
    const tampered = await call(base, 'POST', `/${meetingId}/sessions`, { token: forged, body: {} })
    assert.equal(tampered.status, 401)

    const notStarted = await call(base, 'POST', `/${meetingId}/sessions`, { token: ticket, body: {} })
    assert.equal(notStarted.status, 409, 'a meeting that is not started cannot take a session')
    assert.equal(notStarted.json.code, 'meeting-not-attachable')

    await call(base, 'POST', `/${meetingId}/start`, { token: ADMIN })
    const sessionWithTicket = await call(base, 'POST', `/${meetingId}/sessions`, { token: ticket, body: {} })
    assert.equal(sessionWithTicket.status, 201, 'a valid ticket may attach a speech session to its own meeting')
    assert.equal(meetingService.getMeeting(meetingId).status, 'LIVE')
  } finally {
    await close()
  }
})

test('expired tickets are refused with a specific code', async () => {
  let now = Date.parse('2026-10-08T10:00:00.000Z')
  const clock = { now: () => now }
  const { app } = buildApp({ clock, ticketTtlSeconds: 60 })
  const { base, close } = await serve(app)
  try {
    const created = (await call(base, 'POST', '', { token: ADMIN, body: {} })).json
    await call(base, 'POST', `/${created.meetingId}/start`, { token: ADMIN })
    now += 61_000
    const late = await call(base, 'POST', `/${created.meetingId}/sessions`, { token: created.ticket.token, body: {} })
    assert.equal(late.status, 401)
    assert.equal(late.json.code, 'ticket-expired')
  } finally {
    await close()
  }
})

test('with no credentials configured, every meeting route fails closed with 503', async () => {
  const { app } = buildApp({ adminToken: '', ticketSecret: '' })
  const { base, close } = await serve(app)
  try {
    const create = await call(base, 'POST', '', { token: 'anything-at-all-anything-at-all-1234', body: {} })
    assert.equal(create.status, 503)
    assert.equal(create.json.code, 'auth-not-configured')
    const read = await call(base, 'GET', `/${UUID(1)}`, { token: 'anything-at-all-anything-at-all-1234' })
    assert.equal(read.status, 503)
  } finally {
    await close()
  }
})

test('the full segment outcome contract over HTTP: INSERTED, ALREADY_EXISTS, CONFLICT, invalid', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const created = (await call(base, 'POST', '', { token: ADMIN, body: {} })).json
    await call(base, 'POST', `/${created.meetingId}/start`, { token: ADMIN })
    const session = (await call(base, 'POST', `/${created.meetingId}/sessions`, { token: created.ticket.token, body: {} })).json
    const post = (segment, speechSessionId = session.speechSessionId) =>
      call(base, 'POST', `/${created.meetingId}/transcript/final`, { token: created.ticket.token, body: { speechSessionId, segment } })

    const first = await post(seg('seg-a', 1, 'hello'))
    assert.equal(first.status, 201)
    assert.equal(first.json.status, 'INSERTED')

    const duplicate = await post(seg('seg-a', 1, 'hello'))
    assert.equal(duplicate.status, 200)
    assert.equal(duplicate.json.status, 'ALREADY_EXISTS')

    const collision = await post(seg('seg-a', 1, 'different'))
    assert.equal(collision.status, 409)
    assert.equal(collision.json.code, 'segment-id-conflict')

    const badSegment = await post({ ...seg('seg-b', 5, 'x'), start: 'five' })
    assert.equal(badSegment.status, 400)
    assert.equal(badSegment.json.code, 'invalid-segment')

    const badSession = await post(seg('seg-c', 1, 'x'), UUID(404))
    assert.equal(badSession.status, 404)
    assert.equal(badSession.json.code, 'speech-session-not-found')

    const transcript = await call(base, 'GET', `/${created.meetingId}/transcript`, { token: ADMIN })
    assert.deepEqual(transcript.json.segments.map((s) => s.text), ['hello'], 'collisions never overwrite stored text')
  } finally {
    await close()
  }
})

test('unexpected failures return a generic 500 and never leak internal detail', async () => {
  const logged = []
  const logger = { error: (...args) => logged.push(args), warn() {}, info() {}, log() {} }
  const brokenService = {
    getMeeting() {
      throw new Error('SQLITE internal detail /srv/projects/secret-path')
    }
  }
  const { app } = buildApp({ service: brokenService, logger })
  const { base, close } = await serve(app)
  try {
    const res = await call(base, 'GET', `/${UUID(1)}`, { token: ADMIN })
    assert.equal(res.status, 500)
    assert.equal(res.json.code, 'internal-error')
    assert.doesNotMatch(res.text, /SQLITE|secret-path|at /)
    assert.ok(logged.length > 0, 'the full error is logged server-side')
  } finally {
    await close()
  }
})

test('cancel and fail are admin-only lifecycle routes; a closed meeting refuses everything with 409', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const admin = (method, path, extra) => call(base, method, path, { token: ADMIN, ...extra })
    const created = (await admin('POST', '', { body: {} })).json
    const id = created.meetingId

    assert.equal((await call(base, 'POST', `/${id}/cancel`)).status, 401, 'no credentials')
    assert.equal((await call(base, 'POST', `/${id}/fail`, { token: created.ticket.token })).status, 403, 'a ticket cannot close a meeting')
    assert.equal((await admin('POST', `/${UUID(999)}/cancel`)).status, 404)
    assert.equal((await admin('POST', '', { body: { metadata: { closeReason: 'forged' } } })).status, 400, 'closeReason is reserved')

    await admin('POST', `/${id}/start`)
    const tooLong = await admin('POST', `/${id}/fail`, { body: { reason: 'x'.repeat(201) } })
    assert.equal(tooLong.status, 400)
    assert.equal(tooLong.json.code, 'invalid-close-reason')
    assert.equal((await admin('GET', `/${id}`)).json.status, 'LIVE', 'a rejected request changes nothing')

    const session = (await call(base, 'POST', `/${id}/sessions`, { token: created.ticket.token, body: {} })).json
    const cancelled = await admin('POST', `/${id}/cancel`, { body: { reason: 'duplicate meeting' } })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.json.status, 'CANCELLED')
    assert.equal(cancelled.json.metadata.closeReason, 'duplicate meeting')

    for (const [method, path] of [['POST', 'fail'], ['POST', 'start'], ['POST', 'resume'], ['POST', 'end']]) {
      const refused = await admin(method, `/${id}/${path}`)
      assert.equal(refused.status, 409, `${path} on a cancelled meeting`)
      assert.equal(refused.json.code, 'invalid-meeting-transition')
    }
    // A retry of the same close is safe and rewrites nothing.
    const retried = await admin('POST', `/${id}/cancel`, { body: { reason: 'a different reason' } })
    assert.equal(retried.status, 200)
    assert.equal(retried.json.endedAt, cancelled.json.endedAt, 'the end time did not move')
    assert.equal(retried.json.metadata.closeReason, 'duplicate meeting', 'the original reason stands')
    const append = await call(base, 'POST', `/${id}/transcript/final`, {
      token: created.ticket.token,
      body: { speechSessionId: session.speechSessionId, segment: seg('late', 1, 'too late') }
    })
    assert.equal(append.status, 409)
    assert.equal(append.json.code, 'meeting-not-accepting-transcript')
    assert.equal((await call(base, 'POST', `/${id}/sessions`, { token: created.ticket.token, body: {} })).status, 409)

    const failedMeeting = (await admin('POST', '', { body: {} })).json
    await admin('POST', `/${failedMeeting.meetingId}/start`)
    const failed = await admin('POST', `/${failedMeeting.meetingId}/fail`, { body: { reason: 'transcript can never be completed' } })
    assert.equal(failed.json.status, 'FAILED')
    assert.equal(failed.json.endedAt !== null, true)
  } finally {
    await close()
  }
})

test('ending a meeting is refused with details while a stream is open or segments are missing, then works', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const admin = (method, path, extra) => call(base, method, path, { token: ADMIN, ...extra })
    const created = (await admin('POST', '', { body: {} })).json
    const id = created.meetingId
    const ticket = created.ticket.token
    await admin('POST', `/${id}/start`)
    const session = (await call(base, 'POST', `/${id}/sessions`, { token: ticket, body: {} })).json
    const post = (segment) => call(base, 'POST', `/${id}/transcript/final`, { token: ticket, body: { speechSessionId: session.speechSessionId, segment } })
    assert.equal((await post(seg('c-1', 1, 'delivered'))).status, 201)

    // 1. The stream is still open and has produced transcript.
    const streaming = await admin('POST', `/${id}/end`)
    assert.equal(streaming.status, 409)
    assert.equal(streaming.json.code, 'speech-session-active')
    assert.equal(streaming.json.details.sessions.find((s) => s.speechSessionId === session.speechSessionId).state, 'OPEN')
    assert.doesNotMatch(streaming.text, /\n\s+at /)
    assert.equal((await admin('GET', `/${id}`)).json.status, 'LIVE', 'the refusal left the meeting live')

    // 2. The transport stops and reports two committed segments, but only one is stored.
    const ended = await call(base, 'POST', `/${id}/sessions/${session.speechSessionId}/end`, { token: ticket, body: { reason: 'stopped', committedSegments: 2 } })
    assert.equal(ended.status, 200)
    assert.equal(ended.json.committedSegments, 2)
    const incomplete = await admin('POST', `/${id}/end`)
    assert.equal(incomplete.status, 409)
    assert.equal(incomplete.json.code, 'transcript-incomplete')
    assert.equal(incomplete.json.details.missingSegments, 1)
    assert.equal((await admin('GET', `/${id}`)).json.status, 'LIVE')
    const listed = (await admin('GET', `/${id}/sessions`)).json.speechSessions.find((s) => s.speechSessionId === session.speechSessionId)
    assert.deepEqual([listed.committedSegments, listed.storedSegments], [2, 1], 'the operator can see the gap per session')

    // 3. The missing segment is delivered late from the ended session, and the meeting can end.
    assert.equal((await post(seg('c-2', 3, 'late delivery'))).status, 201)
    const done = await admin('POST', `/${id}/end`)
    assert.equal(done.status, 200)
    assert.equal(done.json.status, 'COMPLETED')
    assert.equal(done.json.integrity.verified, true)
    const transcript = (await admin('GET', `/${id}/transcript`)).json
    assert.deepEqual(transcript.segments.map((s) => s.text), ['delivered', 'late delivery'])
    assert.equal(transcript.integrity.verified, true)

    // 4. A malformed count is a 400 and changes nothing.
    const other = (await admin('POST', '', { body: {} })).json
    await admin('POST', `/${other.meetingId}/start`)
    const otherSession = (await call(base, 'POST', `/${other.meetingId}/sessions`, { token: other.ticket.token, body: {} })).json
    for (const committedSegments of [-1, 1.5, '3']) {
      const bad = await call(base, 'POST', `/${other.meetingId}/sessions/${otherSession.speechSessionId}/end`, {
        token: other.ticket.token,
        body: { reason: 'stopped', committedSegments }
      })
      assert.equal(bad.status, 400, `committedSegments ${JSON.stringify(committedSegments)}`)
      assert.equal(bad.json.code, 'invalid-committed-segments')
    }
  } finally {
    await close()
  }
})

test('two speech sessions writing concurrently never collide, and a genuine id clash is reported, never swallowed', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const admin = (method, path, extra) => call(base, method, path, { token: ADMIN, ...extra })
    const created = (await admin('POST', '', { body: {} })).json
    const id = created.meetingId
    const ticket = created.ticket.token
    await admin('POST', `/${id}/start`)
    const a = (await call(base, 'POST', `/${id}/sessions`, { token: ticket, body: {} })).json
    const b = (await call(base, 'POST', `/${id}/sessions`, { token: ticket, body: {} })).json // supersedes A, which keeps writing
    const post = (session, segment) =>
      call(base, 'POST', `/${id}/transcript/final`, { token: ticket, body: { speechSessionId: session.speechSessionId, segment } })

    const writes = []
    for (let n = 1; n <= 25; n++) {
      writes.push(post(a, seg(`a-${n}`, n, `A${n}`)))
      writes.push(post(b, seg(`b-${n}`, n, `B${n}`)))
    }
    const results = await Promise.all(writes)
    assert.deepEqual([...new Set(results.map((r) => r.status))], [201], 'fifty concurrent writes, all stored, none a 5xx')

    // The old failure: two sessions both numbering from the same counter. One wins; the other is told.
    const clash = await Promise.all([post(a, seg('seg_0001', 100, 'from A')), post(b, seg('seg_0001', 100, 'from B'))])
    assert.deepEqual(clash.map((r) => r.status).sort(), [201, 409])
    assert.equal(clash.find((r) => r.status === 409).json.code, 'segment-id-conflict')

    const stored = (await admin('GET', `/${id}/transcript`)).json.segments
    assert.equal(stored.length, 51)
    assert.equal(new Set(stored.map((s) => s.id)).size, 51, 'no duplicate ids')
    for (const segment of stored.filter((s) => /^[AB]\d+$/.test(s.text))) {
      const owner = segment.text.startsWith('A') ? a : b
      assert.equal(segment.speechSessionId, owner.speechSessionId, `${segment.text} is linked to the session that wrote it`)
    }
    for (let i = 1; i < stored.length; i++) assert.ok(stored[i].start >= stored[i - 1].start, 'ordered on the meeting timeline')
  } finally {
    await close()
  }
})

test('a database failure is an explicit 500, never a false success', async () => {
  const logged = []
  const logger = { error: (...args) => logged.push(args), warn() {}, info() {}, log() {} }
  const { app, database } = buildApp({ logger })
  const { base, close } = await serve(app)
  try {
    const admin = (method, path, extra) => call(base, method, path, { token: ADMIN, ...extra })
    const created = (await admin('POST', '', { body: {} })).json
    await admin('POST', `/${created.meetingId}/start`)
    const session = (await call(base, 'POST', `/${created.meetingId}/sessions`, { token: created.ticket.token, body: {} })).json

    database.close() // the database goes away underneath the API

    const write = await call(base, 'POST', `/${created.meetingId}/transcript/final`, {
      token: created.ticket.token,
      body: { speechSessionId: session.speechSessionId, segment: seg('seg-lost', 1, 'must never be reported as saved') }
    })
    assert.equal(write.status, 500, 'the caller is told the write failed')
    assert.equal(write.json.code, 'internal-error')
    assert.equal(write.json.status, undefined, 'no INSERTED or ALREADY_EXISTS claim')
    assert.doesNotMatch(write.text, /sqlite|not open|database|\n\s+at /i, 'no internal detail leaks')
    assert.ok(logged.length > 0, 'the real error is logged for the operator')

    const read = await admin('GET', `/${created.meetingId}/transcript`)
    assert.equal(read.status, 500, 'reads fail loudly too, rather than returning an empty transcript')
  } finally {
    await close()
  }
})

test('REGRESSION: over HTTP, a session that never reported is never verified, even with nothing stored', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const admin = (method, path, extra) => call(base, method, path, { token: ADMIN, ...extra })
    const created = (await admin('POST', '', { body: {} })).json
    const id = created.meetingId
    await admin('POST', `/${id}/start`)
    const session = (await call(base, 'POST', `/${id}/sessions`, { token: created.ticket.token, body: {} })).json
    // The transport attached but never delivered or reported anything (for example it could not reach the API).

    const done = await admin('POST', `/${id}/end`)
    assert.equal(done.status, 200, 'nothing is known to be missing, so ending is allowed')
    assert.equal(done.json.integrity.verified, false)
    assert.equal(done.json.integrity.unverifiedSessions, 1)
    assert.equal(done.json.integrity.sessions.find((s) => s.speechSessionId === session.speechSessionId).state, 'UNVERIFIED')

    const transcript = (await admin('GET', `/${id}/transcript`)).json
    assert.equal(transcript.integrity.verified, false, 'the stored transcript says so too')
  } finally {
    await close()
  }
})
