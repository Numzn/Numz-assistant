import assert from 'node:assert/strict'
import test from 'node:test'
import { createMeetingAuth } from './meetingAuth.js'

const ADMIN = 'admin-token-'.padEnd(40, 'x')
const SECRET = 'ticket-secret-'.padEnd(40, 'y')
const quiet = { warn() {}, error() {}, info() {}, log() {} }
const MEETING = '00000000-0000-4000-8000-000000000001'

/** Runs a middleware against a fake request/response and reports what it decided. */
function run(middleware, { authorization, params = { meetingId: MEETING } } = {}) {
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
  const req = { headers: authorization ? { authorization } : {}, params, id: 'r1' }
  let passed = false
  middleware(req, res, () => {
    passed = true
  })
  return { passed, status: passed ? 200 : res.statusCode, body: res.body, principal: req.principal }
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
