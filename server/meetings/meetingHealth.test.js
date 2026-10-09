import assert from 'node:assert/strict'
import test from 'node:test'
import { createMeetingAuth } from '../auth/meetingAuth.js'
import { logMeetingsConfig, meetingsHealth } from './meetingHealth.js'

const quiet = { error() {}, warn() {}, info() {}, log() {} }
const strong = (seed) => seed.padEnd(40, 'z')

test('health says ready only when both credential types are usable', () => {
  const both = createMeetingAuth({ adminToken: strong('admin'), ticketSecret: strong('ticket'), logger: quiet })
  assert.deepEqual(meetingsHealth({ auth: both, schemaVersion: 3 }), {
    ready: true,
    schemaVersion: 3,
    auth: { admin: true, tickets: true },
    launch: { enabled: false }
  })

  for (const [adminToken, ticketSecret, expected] of [
    ['', strong('ticket'), { admin: false, tickets: true }],
    [strong('admin'), '', { admin: true, tickets: false }],
    ['', '', { admin: false, tickets: false }],
    ['too-short', strong('ticket'), { admin: false, tickets: true }]
  ]) {
    const health = meetingsHealth({ auth: createMeetingAuth({ adminToken, ticketSecret, logger: quiet }), schemaVersion: 3 })
    assert.equal(health.ready, false)
    assert.deepEqual(health.auth, expected)
    assert.match(health.problem, /MEETING_API_TOKEN and MEETING_TICKET_SECRET/)
  }
})

test('health says whether the browser can start meetings, and only when a code and tickets are both usable', () => {
  const launch = (launchCode, ticketSecret = strong('ticket')) =>
    meetingsHealth({ auth: createMeetingAuth({ adminToken: strong('admin'), ticketSecret, launchCode, logger: quiet }) }).launch
  assert.deepEqual(launch(''), { enabled: false })
  assert.deepEqual(launch('short'), { enabled: false }, 'a code under 12 characters is refused')
  assert.deepEqual(launch('a-long-enough-code'), { enabled: true })
  assert.deepEqual(launch('a-long-enough-code', ''), { enabled: false }, 'no tickets, so nothing could be handed to the browser')
})

test('health never contains a secret, even when one is configured', () => {
  const adminToken = strong('super-secret-admin')
  const ticketSecret = strong('super-secret-ticket')
  const launchCode = 'super-secret-launch-code'
  const auth = createMeetingAuth({ adminToken, ticketSecret, launchCode, logger: quiet })
  const text = JSON.stringify(meetingsHealth({ auth }))
  assert.equal(text.includes(adminToken), false)
  assert.equal(text.includes(ticketSecret), false)
  assert.equal(text.includes(launchCode), false)
})

test('startup logs state each fact and warn loudly when persistence cannot work', () => {
  const lines = { log: [], warn: [] }
  const logger = { log: (m) => lines.log.push(m), warn: (m) => lines.warn.push(m) }

  logMeetingsConfig({
    auth: createMeetingAuth({ adminToken: strong('a'), ticketSecret: strong('t'), launchCode: 'a-long-enough-code', logger: quiet }),
    logger
  })
  assert.deepEqual(lines.log, ['[meetings] auth: admin enabled, tickets enabled', '[meetings] browser launch: enabled'])
  assert.deepEqual(lines.warn, [])

  lines.log.length = 0
  logMeetingsConfig({ auth: createMeetingAuth({ adminToken: strong('a'), ticketSecret: strong('t'), logger: quiet }), logger })
  assert.deepEqual(lines.log, ['[meetings] auth: admin enabled, tickets enabled', '[meetings] browser launch: DISABLED'])
  assert.match(lines.warn[0], /MEETING_LAUNCH_CODE/, 'persistence works, but the browser cannot start meetings')

  lines.log.length = 0
  lines.warn.length = 0
  logMeetingsConfig({ auth: createMeetingAuth({ adminToken: '', ticketSecret: '', logger: quiet }), logger })
  assert.deepEqual(lines.log, ['[meetings] auth: admin DISABLED, tickets DISABLED', '[meetings] browser launch: DISABLED'])
  assert.match(lines.warn[0], /persistence is NOT usable/)
})
