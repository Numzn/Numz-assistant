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
  return { app, meetingService }
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
