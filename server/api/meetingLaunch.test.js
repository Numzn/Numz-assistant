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

async function call(base, method, path, { token, code, body, cookie, headers: extra = {} } = {}) {
  const headers = { ...extra }
  if (cookie) headers.Cookie = cookie
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

// ---- Launch session: type the code once, then start meetings (by voice or button) without it ----------------

const COOKIE = 'numz_launch_session'
const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0]
const setCookie = (res) => res.headers.get('set-cookie') || ''

test('a launch with the code also starts a launch session: an HttpOnly, Strict cookie that only the meeting API sees', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const res = await call(base, 'POST', '/launch', { code: LAUNCH, body: {} })
    assert.equal(res.status, 201)
    const header = setCookie(res)
    assert.match(header, new RegExp(`^${COOKIE}=v1\\.\\d+\\.[0-9a-f]{64};`))
    assert.match(header, /HttpOnly/i)
    assert.match(header, /SameSite=Strict/i)
    assert.match(header, /Path=\/api\/v1\/meetings/)
    assert.match(header, /Max-Age=\d+/)
    assert.doesNotMatch(header, /Secure/i, 'plain http in the test: Secure is only added behind https')
    assert.equal(JSON.stringify(res.json).includes(LAUNCH), false, 'the code is never echoed back')
    assert.equal(header.includes(LAUNCH), false, 'and the cookie does not contain it')
  } finally {
    await close()
  }
})

test('behind https the cookie is also Secure', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const res = await call(base, 'POST', '/launch', { code: LAUNCH, body: {}, headers: { 'X-Forwarded-Proto': 'https' } })
    assert.match(setCookie(res), /Secure/i)
  } finally {
    await close()
  }
})

test('with the session cookie a meeting starts without any code, and its ticket is the same narrow ticket', async () => {
  const { app, database } = buildApp()
  const { base, close } = await serve(app)
  try {
    const first = await call(base, 'POST', '/launch', { code: LAUNCH, body: {} })
    const cookie = cookieFrom(first)
    const second = await call(base, 'POST', '/launch', { cookie, body: { title: 'By voice' } })
    assert.equal(second.status, 201)
    assert.equal(second.json.status, 'LIVE')
    assert.notEqual(second.json.meetingId, first.json.meetingId)
    assert.equal(meetingCount(database), 2)
    assert.equal(setCookie(second), '', 'a cookie-only launch does not extend the session')

    // The ticket still cannot do administration or touch another meeting.
    const ticket = second.json.ticket.token
    assert.equal((await call(base, 'GET', `/${first.json.meetingId}`, { token: ticket })).status, 403)
    assert.equal((await call(base, 'POST', `/${first.json.meetingId}/end`, { token: ticket, body: {} })).status, 403)
    assert.equal((await call(base, 'POST', `/${second.json.meetingId}/sessions`, { token: ticket, body: {} })).status, 201)
  } finally {
    await close()
  }
})

test('the cookie authorises launching and nothing else', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const cookie = cookieFrom(await call(base, 'POST', '/launch', { code: LAUNCH, body: {} }))
    const created = await call(base, 'POST', '/launch', { cookie, body: {} })
    const id = created.json.meetingId
    for (const [method, path] of [['GET', `/${id}`], ['GET', `/${id}/transcript`], ['POST', `/${id}/ticket`], ['POST', '/'], ['POST', `/${id}/cancel`], ['POST', `/${id}/sessions`], ['POST', `/${id}/end`]]) {
      const res = await call(base, method, path, { cookie, body: method === 'GET' ? undefined : {} })
      assert.equal(res.status, 401, `${method} ${path} must not accept the launch cookie`)
    }
  } finally {
    await close()
  }
})

test('a forged, tampered, expired or rotated-code cookie is not a launch credential and creates nothing', async () => {
  const issuedAt = Date.parse('2026-10-10T10:00:00Z')
  let nowMs = issuedAt
  const database = createDatabase({ filename: ':memory:' })
  const meetingService = createMeetingSessionService({
    meetingRepository: createMeetingRepository(database),
    speechSessionRepository: createSpeechSessionRepository(database),
    transcriptRepository: createTranscriptRepository(database)
  })
  const makeApp = (launchCode) => {
    const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode, launchSessionTtlSeconds: 3600, clock: () => nowMs, logger: quiet })
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => ((req.id = 'r'), next()))
    app.use('/api/v1/meetings', createMeetingsRouter({ meetingService, auth }))
    app.use('/api', notFoundHandler)
    app.use(errorHandler({ logger: quiet }))
    return app
  }
  const a = await serve(makeApp(LAUNCH))
  try {
    const good = cookieFrom(await call(a.base, 'POST', '/launch', { code: LAUNCH, body: {} }))
    const [v, exp, sig] = good.split('=')[1].split('.')
    const before = meetingCount(database)
    const forged = [
      `${COOKIE}=v1.${Number(exp) + 99999}.${sig}`, // expiry changed, signature kept
      `${COOKIE}=v1.${exp}.${'0'.repeat(64)}`, // signature invented
      `${COOKIE}=${v}.${exp}`, // truncated
      `${COOKIE}=garbage`
    ]
    for (const cookie of forged) {
      const res = await call(a.base, 'POST', '/launch', { cookie, body: {} })
      assert.equal(res.status, 401, cookie)
      assert.equal(res.json.code, 'launch-code-required')
    }
    assert.equal(meetingCount(database), before, 'nothing was created')

    nowMs = issuedAt + 3601 * 1000 // past its lifetime
    assert.equal((await call(a.base, 'POST', '/launch', { cookie: good, body: {} })).status, 401, 'expired')
    nowMs = issuedAt
    assert.equal((await call(a.base, 'POST', '/launch', { cookie: good, body: {} })).status, 201, 'valid again inside its lifetime')
  } finally {
    await a.close()
  }
  // The launch code is rotated: every session made with the old one is void.
  const rotated = await serve(makeApp('a-different-launch-code-entirely'))
  try {
    const old = await (async () => {
      const first = await serve(makeApp(LAUNCH))
      try {
        return cookieFrom(await call(first.base, 'POST', '/launch', { code: LAUNCH, body: {} }))
      } finally {
        await first.close()
      }
    })()
    assert.equal((await call(rotated.base, 'POST', '/launch', { cookie: old, body: {} })).status, 401)
  } finally {
    await rotated.close()
  }
})

test('the session endpoint reports whether a launch would be accepted, logs in with the code, and logs out', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    assert.deepEqual((await call(base, 'GET', '/launch/session')).json, { available: true, authenticated: false })
    assert.equal((await call(base, 'POST', '/launch/session', { body: {} })).status, 401, 'no code, no session')
    assert.equal((await call(base, 'POST', '/launch/session', { code: 'wrong-code-wrong', body: {} })).status, 401)

    const login = await call(base, 'POST', '/launch/session', { code: LAUNCH, body: {} })
    assert.equal(login.status, 200)
    assert.equal(login.json.authenticated, true)
    const cookie = cookieFrom(login)
    assert.deepEqual((await call(base, 'GET', '/launch/session', { cookie })).json, { available: true, authenticated: true })

    const out = await call(base, 'DELETE', '/launch/session', { cookie })
    assert.equal(out.status, 204)
    assert.match(setCookie(out), /Max-Age=0/)
  } finally {
    await close()
  }
})

test('the launch endpoint reports nothing and allows nothing when no launch code is configured, cookie or not', async () => {
  const { app, database } = buildApp({ launchCode: '' })
  const { base, close } = await serve(app)
  try {
    assert.deepEqual((await call(base, 'GET', '/launch/session')).json, { available: false, authenticated: false })
    const res = await call(base, 'POST', '/launch', { cookie: `${COOKIE}=v1.9999999999.${'a'.repeat(64)}`, body: {} })
    assert.equal(res.status, 503)
    assert.equal(meetingCount(database), 0)
  } finally {
    await close()
  }
})

test('the wrong-code lockout still applies to the code, and the cookie does not become a way to guess it', async () => {
  const { app } = buildApp()
  const { base, close } = await serve(app)
  try {
    const cookie = cookieFrom(await call(base, 'POST', '/launch', { code: LAUNCH, body: {} }))
    for (let i = 0; i < 10; i++) await call(base, 'POST', '/launch', { code: `wrong-code-${i}-xxxx`, body: {} })
    const locked = await call(base, 'POST', '/launch', { code: LAUNCH, body: {} })
    assert.equal(locked.status, 429, 'the right code is refused while locked')
    assert.equal((await call(base, 'POST', '/launch/session', { code: LAUNCH, body: {} })).status, 429)
    assert.equal((await call(base, 'POST', '/launch', { cookie, body: {} })).status, 201, 'a valid session is a different credential and keeps working')
  } finally {
    await close()
  }
})

// ---- Duplicate starts ------------------------------------------------------------------------------------

test('the same start attempt, repeated, returns the same meeting with a fresh ticket instead of making another', async () => {
  const { app, database } = buildApp()
  const { base, close } = await serve(app)
  try {
    const key = 'start-attempt-0001-abcdefgh'
    const first = await call(base, 'POST', '/launch', { code: LAUNCH, body: { title: 'Standup' }, headers: { 'Idempotency-Key': key } })
    const again = await call(base, 'POST', '/launch', { code: LAUNCH, body: { title: 'Standup' }, headers: { 'Idempotency-Key': key } })
    assert.equal(first.status, 201)
    assert.equal(again.status, 200)
    assert.equal(again.json.meetingId, first.json.meetingId)
    assert.equal(again.json.reused, true)
    assert.equal(meetingCount(database), 1)
    const session = await call(base, 'POST', `/${first.json.meetingId}/sessions`, { token: again.json.ticket.token, body: {} })
    assert.equal(session.status, 201, 'the second ticket works for that meeting')
  } finally {
    await close()
  }
})

test('different attempts make different meetings, and a key can never reach a closed meeting', async () => {
  const { app, database } = buildApp()
  const { base, close } = await serve(app)
  try {
    const a = await call(base, 'POST', '/launch', { code: LAUNCH, body: {}, headers: { 'Idempotency-Key': 'attempt-aaaaaaaaaaaaaaaa' } })
    const b = await call(base, 'POST', '/launch', { code: LAUNCH, body: {}, headers: { 'Idempotency-Key': 'attempt-bbbbbbbbbbbbbbbb' } })
    assert.notEqual(a.json.meetingId, b.json.meetingId)
    assert.equal(meetingCount(database), 2)

    await call(base, 'POST', `/${a.json.meetingId}/cancel`, { token: ADMIN, body: {} })
    const retry = await call(base, 'POST', '/launch', { code: LAUNCH, body: {}, headers: { 'Idempotency-Key': 'attempt-aaaaaaaaaaaaaaaa' } })
    assert.equal(retry.status, 201, 'a cancelled meeting is not handed out again')
    assert.notEqual(retry.json.meetingId, a.json.meetingId)
  } finally {
    await close()
  }
})

test('a malformed idempotency key is refused rather than ignored', async () => {
  const { app, database } = buildApp()
  const { base, close } = await serve(app)
  try {
    for (const key of ['short', 'has spaces in it xxxxxxxxxxxx', 'x'.repeat(200), 'ünïcödé-key-0123456789']) {
      const res = await call(base, 'POST', '/launch', { code: LAUNCH, body: {}, headers: { 'Idempotency-Key': key } })
      assert.equal(res.status, 400, key)
      assert.equal(res.json.code, 'invalid-idempotency-key')
    }
    assert.equal(meetingCount(database), 0)
  } finally {
    await close()
  }
})
