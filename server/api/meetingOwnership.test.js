import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { people } from '../academic/testSupport.js'
import { personIdentity } from '../auth/identity.js'
import { createMeetingAuth } from '../auth/meetingAuth.js'
import { errorHandler } from '../http/errorHandler.js'
import { createMeetingRepository } from '../persistence/meetingRepository.js'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createSpeechSessionRepository } from '../persistence/speechSessionRepository.js'
import { createTranscriptRepository } from '../persistence/transcriptRepository.js'
import { createMeetingsRouter } from '../routes/meetings.js'
import { createMeetingSessionService } from '../services/meetingSessionService.js'

const ADMIN = 'admin-token-'.padEnd(40, 'x')
const SECRET = 'ticket-secret-'.padEnd(40, 'y')
const quiet = { error() {}, warn() {}, info() {}, log() {} }

test('a meeting started by a signed-in person is theirs; one made with the admin token, or by the shared launch code, belongs to nobody', async () => {
  const database = createDatabase({ filename: ':memory:' })
  const who = people(database)
  const service = createMeetingSessionService({
    meetingRepository: createMeetingRepository(database),
    speechSessionRepository: createSpeechSessionRepository(database),
    transcriptRepository: createTranscriptRepository(database)
  })
  const alice = personIdentity({ id: who.alice, external_id: 'a', email: 'alice@example.com', name: 'alice', role: 'viewer' }, { ref: 'r', csrf: 'x' })
  const launch = (auth, identity) => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.id = 'r'
      next()
    })
    app.use('/m', createMeetingsRouter({ meetingService: service, auth, launchGuard: identity ? (req, _res, next) => { req.identity = identity; next() } : null }))
    app.use(errorHandler({ logger: quiet }))
    return new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}/m`, close: () => new Promise((r) => server.close(r)) }))
    })
  }

  const signedIn = await launch(createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, signedInLaunch: true, logger: quiet }), alice)
  const mine = await (await fetch(`${signedIn.base}/launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Lecture 1' }) })).json()
  await signedIn.close()
  assert.equal(service.getMeetingOwner(mine.meetingId), who.alice)
  assert.equal(service.getMeeting(mine.meetingId).metadata.launchedBy, who.alice)

  const code = await launch(createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode: 'a-launch-code-123', logger: quiet }), null)
  const shared = await (await fetch(`${code.base}/launch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-meeting-launch-code': 'a-launch-code-123' }, body: '{}' })).json()
  const admin = await (await fetch(`${code.base}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ title: 'by the host' }) })).json()
  await code.close()
  assert.equal(service.getMeetingOwner(shared.meetingId), null)
  assert.equal(service.getMeetingOwner(admin.meetingId), null)
})
