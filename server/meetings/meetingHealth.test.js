import assert from 'node:assert/strict'
import test from 'node:test'
import { createMeetingAuth } from '../auth/meetingAuth.js'
import { logMeetingsConfig, meetingsHealth } from './meetingHealth.js'

const quiet = { error() {}, warn() {}, info() {}, log() {} }
const strong = (seed) => seed.padEnd(40, 'z')

test('health says ready only when both credential types are usable', () => {
  const both = createMeetingAuth({ adminToken: strong('admin'), ticketSecret: strong('ticket'), logger: quiet })
  assert.deepEqual(meetingsHealth({ auth: both, schemaVersion: 3 }), { ready: true, schemaVersion: 3, auth: { admin: true, tickets: true } })

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

test('health never contains a secret, even when one is configured', () => {
  const adminToken = strong('super-secret-admin')
  const ticketSecret = strong('super-secret-ticket')
  const auth = createMeetingAuth({ adminToken, ticketSecret, logger: quiet })
  const text = JSON.stringify(meetingsHealth({ auth }))
  assert.equal(text.includes(adminToken), false)
  assert.equal(text.includes(ticketSecret), false)
})

test('startup logs state each fact and warn loudly when persistence cannot work', () => {
  const lines = { log: [], warn: [] }
  const logger = { log: (m) => lines.log.push(m), warn: (m) => lines.warn.push(m) }

  logMeetingsConfig({ auth: createMeetingAuth({ adminToken: strong('a'), ticketSecret: strong('t'), logger: quiet }), logger })
  assert.deepEqual(lines.log, ['[meetings] auth: admin enabled, tickets enabled'])
  assert.deepEqual(lines.warn, [])

  lines.log.length = 0
  logMeetingsConfig({ auth: createMeetingAuth({ adminToken: '', ticketSecret: '', logger: quiet }), logger })
  assert.deepEqual(lines.log, ['[meetings] auth: admin DISABLED, tickets DISABLED'])
  assert.match(lines.warn[0], /persistence is NOT usable/)
})
