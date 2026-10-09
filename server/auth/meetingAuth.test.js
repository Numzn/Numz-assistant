import assert from 'node:assert/strict'
import test from 'node:test'
import { createMeetingAuth } from './meetingAuth.js'

const ADMIN = 'admin-token-'.padEnd(40, 'x')
const SECRET = 'ticket-secret-'.padEnd(40, 'y')
const quiet = { warn() {}, error() {}, info() {}, log() {} }
const MEETING = '00000000-0000-4000-8000-000000000001'

/** Runs a middleware against a fake request/response and reports what it decided. */
function run(middleware, { authorization, headers = {}, params = { meetingId: MEETING } } = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value
      return this
    }
  }
  const req = { headers: { ...(authorization ? { authorization } : {}), ...headers }, params, id: 'r1' }
  let passed = false
  middleware(req, res, () => {
    passed = true
  })
  return { passed, status: passed ? 200 : res.statusCode, body: res.body, principal: req.principal, responseHeaders: res.headers }
}

test('tickets carry the meeting, expire, and cannot be re-signed by anyone without the secret', () => {
  let now = Date.parse('2026-10-08T10:00:00.000Z')
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, ticketTtlSeconds: 100, clock: () => now, logger: quiet })
  const { token, expiresAt } = auth.issueTicket(MEETING)
  assert.equal(new Date(expiresAt).getTime(), now + 100_000)

  const writer = auth.requireMeetingWriter()
  assert.equal(run(writer, { authorization: `Bearer ${token}` }).passed, true)

  const [payload] = token.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({ v: 1, scope: 'meeting-write', mid: '00000000-0000-4000-8000-0000000000ff', exp: 9999999999 })).toString('base64url')
  assert.equal(run(writer, { authorization: `Bearer ${forgedPayload}.${token.split('.')[1]}` }).status, 401, 'payload swap breaks the signature')

  const otherSecret = createMeetingAuth({ adminToken: ADMIN, ticketSecret: 'z'.repeat(40), clock: () => now, logger: quiet })
  assert.equal(run(writer, { authorization: `Bearer ${otherSecret.issueTicket(MEETING).token}` }).status, 401, 'a ticket from another secret is invalid')

  now += 101_000
  const expired = run(writer, { authorization: `Bearer ${token}` })
  assert.equal(expired.status, 401)
  assert.equal(expired.body.code, 'ticket-expired')
  assert.ok(payload.length > 0)
})

test('admin tokens are compared in constant time and only admin passes admin-only routes', () => {
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, clock: () => Date.now(), logger: quiet })
  const admin = auth.requireAdmin()
  assert.equal(run(admin, { authorization: `Bearer ${ADMIN}` }).passed, true)
  assert.equal(run(admin, { authorization: `bearer ${ADMIN}` }).passed, true, 'scheme is case-insensitive')
  assert.equal(run(admin, { authorization: `Bearer ${ADMIN}x` }).status, 401)
  assert.equal(run(admin, { authorization: 'Basic abc' }).status, 401)
  const ticket = auth.issueTicket(MEETING).token
  const denied = run(admin, { authorization: `Bearer ${ticket}` })
  assert.equal(denied.status, 403, 'a ticket never grants admin operations')
})

test('secrets shorter than 32 characters are treated as not configured', () => {
  const warnings = []
  const auth = createMeetingAuth({
    adminToken: 'short',
    ticketSecret: 'also-short',
    logger: { warn: (m) => warnings.push(m) }
  })
  assert.deepEqual(auth.enabled, { admin: false, tickets: false })
  assert.equal(auth.issueTicket(MEETING), null)
  assert.equal(warnings.length, 2)
  assert.equal(run(auth.requireAdmin(), { authorization: 'Bearer short' }).status, 503)
})

test('a meeting writer for meeting A is refused for meeting B', () => {
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, clock: () => Date.now(), logger: quiet })
  const { token } = auth.issueTicket(MEETING)
  const other = '00000000-0000-4000-8000-0000000000aa'
  const result = run(auth.requireMeetingWriter(), { authorization: `Bearer ${token}`, params: { meetingId: other } })
  assert.equal(result.status, 403)
  assert.equal(result.body.code, 'forbidden')
})

const LAUNCH = 'launch-code-for-tests-only'
const withCode = (code) => ({ headers: { 'x-meeting-launch-code': code } })

test('the launch gate admits only the right code, with a different answer for missing and wrong', () => {
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode: LAUNCH, logger: quiet })
  const gate = auth.requireLaunchCode()
  assert.equal(auth.launchEnabled, true)
  assert.equal(run(gate, withCode(LAUNCH)).passed, true)

  const missing = run(gate)
  assert.equal(missing.status, 401)
  assert.equal(missing.body.code, 'launch-code-required')
  const wrong = run(gate, withCode(`${LAUNCH}x`))
  assert.equal(wrong.status, 401)
  assert.equal(wrong.body.code, 'launch-code-invalid')
  assert.equal(run(gate, withCode(LAUNCH.toUpperCase())).status, 401, 'case matters')
  assert.equal(wrong.responseHeaders['www-authenticate'], undefined, 'it is a code, not a Bearer challenge')
})

test('the launch gate fails closed: no code, a short code, or no tickets all answer 503', () => {
  const warnings = []
  const logger = { warn: (m) => warnings.push(m) }
  for (const [launchCode, ticketSecret] of [['', SECRET], ['short', SECRET], [LAUNCH, '']]) {
    const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret, launchCode, logger })
    assert.equal(auth.launchEnabled, false)
    const result = run(auth.requireLaunchCode(), withCode(launchCode))
    assert.equal(result.status, 503)
    assert.equal(result.body.code, 'launch-not-configured')
  }
  assert.equal(warnings.filter((m) => /MEETING_LAUNCH_CODE/.test(m)).length, 2, 'a set-but-unusable code is warned about; an unset one is not')
})

test('ten wrong codes in a minute lock the gate for everyone, then it recovers', () => {
  let now = Date.parse('2026-10-09T10:00:00.000Z')
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode: LAUNCH, clock: () => now, logger: quiet })
  const gate = auth.requireLaunchCode()

  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal(run(gate, withCode('wrong-guess')).status, 401)
    now += 1000
  }
  const locked = run(gate, withCode(LAUNCH))
  assert.equal(locked.status, 429, 'even the right code is refused while locked')
  assert.equal(locked.body.code, 'too-many-attempts')
  assert.ok(Number(locked.responseHeaders['retry-after']) >= 1)

  now += 61_000
  assert.equal(run(gate, withCode(LAUNCH)).passed, true, 'after the window the right code works again')
})

test('good launches never count against the throttle', () => {
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode: LAUNCH, logger: quiet })
  const gate = auth.requireLaunchCode()
  for (let launch = 0; launch < 30; launch++) assert.equal(run(gate, withCode(LAUNCH)).passed, true)
})

test('the launch code is not an admin token or a ticket, and grants nothing else', () => {
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode: LAUNCH, logger: quiet })
  assert.equal(run(auth.requireAdmin(), { authorization: `Bearer ${LAUNCH}` }).status, 401)
  assert.equal(run(auth.requireAdmin(), withCode(LAUNCH)).status, 401)
  assert.equal(run(auth.requireMeetingWriter(), { authorization: `Bearer ${LAUNCH}` }).status, 401)
  assert.equal(run(auth.requireMeetingWriter(), withCode(LAUNCH)).status, 401)
  assert.equal(auth.authenticateToken(LAUNCH).kind, 'invalid')
})

test('authenticateToken tells admin, live ticket, expired ticket and rubbish apart (for sockets with no headers)', () => {
  let now = Date.parse('2026-10-09T10:00:00.000Z')
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, ticketTtlSeconds: 60, clock: () => now, logger: quiet })
  const { token } = auth.issueTicket(MEETING)
  assert.deepEqual(auth.authenticateToken(ADMIN), { kind: 'admin' })
  assert.deepEqual(auth.authenticateToken(token), { kind: 'ticket', meetingId: MEETING })
  assert.equal(auth.authenticateToken('not-a-token').kind, 'invalid')
  assert.equal(auth.authenticateToken('').kind, 'anonymous')
  assert.equal(auth.authenticateToken(undefined).kind, 'anonymous')
  now += 61_000
  assert.equal(auth.authenticateToken(token).kind, 'expired')
})
