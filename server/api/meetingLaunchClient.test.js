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
import { createMeetingApi } from '../../src/interfaces/meeting/meetingApi.js'
import { createMeetingController } from '../../src/interfaces/meeting/meetingController.js'
import { createCommandRouter } from '../../src/interfaces/commands/meetingCommands.js'
import { createMemoryMeetingStorage } from '../../src/interfaces/meeting/meetingStorage.js'

/**
 * The browser's own meeting code (api + controller + command router) against the real server router, over
 * real HTTP, with a cookie jar standing in for the browser. It proves the two sides agree on the launch
 * session: header names, cookie, response shapes, idempotency. Nothing here touches a deployed service.
 */

const ADMIN = 'admin-token-'.padEnd(40, 'x')
const SECRET = 'ticket-secret-'.padEnd(40, 'y')
const LAUNCH = 'launch-code-for-tests-only'
const quiet = { error() {}, warn() {}, info() {}, log() {} }

async function serverAndBrowser({ dropFirstLaunchResponse = false } = {}) {
  const database = createDatabase({ filename: ':memory:' })
  const meetingService = createMeetingSessionService({
    meetingRepository: createMeetingRepository(database),
    speechSessionRepository: createSpeechSessionRepository(database),
    transcriptRepository: createTranscriptRepository(database)
  })
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode: LAUNCH, logger: quiet })
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use((req, _res, next) => {
    req.id = 'test-request'
    next()
  })
  app.use('/api/v1/meetings', createMeetingsRouter({ meetingService, auth }))
  app.use('/api', notFoundHandler)
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const origin = `http://127.0.0.1:${server.address().port}`

  // A browser's cookie handling, as much as this needs: keep what the server sets, send it back, honour deletion.
  const jar = new Map()
  const seen = { cookieHeaders: [], launchCodeHeaders: [] }
  let dropNext = dropFirstLaunchResponse
  const fetchFn = async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}) }
    if (jar.size) headers.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    if (url.endsWith('/launch')) {
      seen.cookieHeaders.push(headers.Cookie ?? null)
      seen.launchCodeHeaders.push(headers['X-Meeting-Launch-Code'] ?? null)
    }
    const res = await fetch(`${origin}${url}`, { ...init, headers })
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim())
      const [name, ...rest] = pair.split('=')
      const expired = attributes.some((a) => /^max-age=0$/i.test(a) || /^expires=.*1970/i.test(a))
      if (expired) jar.delete(name)
      else jar.set(name, rest.join('='))
    }
    if (dropNext && url.endsWith('/launch') && res.ok) {
      dropNext = false
      throw new Error('the connection dropped before the answer arrived')
    }
    return res
  }

  const lives = []
  const controller = createMeetingController({
    api: createMeetingApi({ fetchFn }),
    storage: createMemoryMeetingStorage(),
    createLiveClient: (options) => {
      const handlers = {}
      const live = {
        options,
        async start() {},
        async stop() {},
        setOnReady: (fn) => (handlers.ready = fn),
        setOnPartial() {},
        setOnStabilizing() {},
        setOnFinalSegment() {},
        setOnError() {},
        setOnStopped() {},
        ready: () => handlers.ready({ sessionId: 's', persistence: 'meeting' })
      }
      lives.push(live)
      return live
    },
    sleep: async () => {},
    retryDelaysMs: [1]
  })
  const panels = []
  const router = createCommandRouter({ meeting: controller, openPanel: (o) => panels.push(o) })
  return {
    controller,
    router,
    panels,
    lives,
    jar,
    seen,
    database,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

const meetings = (database) => database.prepare('SELECT count(*) AS n FROM meetings').get().n

test('typing the code once unlocks the browser; the next meeting starts by voice with no code', async () => {
  const b = await serverAndBrowser()
  try {
    assert.equal(await b.controller.refreshLaunchSession(), false, 'a fresh browser is locked')
    const locked = await b.router.handle('start a meeting')
    assert.match(locked.reply, /launch code/i, 'locked: the command asks for the code and starts nothing')
    assert.equal(meetings(b.database), 0)

    await b.controller.start({ code: LAUNCH, title: 'First' })
    assert.equal(b.controller.getState().open, true)
    assert.equal(b.controller.getState().launchReady, true, 'the server set a launch session')
    assert.ok([...b.jar.keys()].some((name) => /launch/i.test(name)), 'as a cookie')
    assert.doesNotMatch(JSON.stringify([...b.jar.values()]), new RegExp(LAUNCH), 'the cookie does not contain the code')

    b.lives[0].ready()
    await b.controller.stop()
    assert.equal(b.controller.getState().phase, 'done')
    b.controller.reset()

    const before = b.seen.launchCodeHeaders.length
    const reply = await b.router.handle('start the meeting')
    assert.equal(b.seen.launchCodeHeaders.length, before + 1)
    assert.equal(b.seen.launchCodeHeaders.at(-1), null, 'no code was sent')
    assert.ok(b.seen.cookieHeaders.at(-1), 'the launch session cookie was')
    assert.match(reply.reply, /Starting the meeting/)
    assert.equal(meetings(b.database), 2)
    assert.equal(b.lives.length, 2, 'and a recording client was created for the new meeting')
    assert.notEqual(b.lives[1].options.meetingId, b.lives[0].options.meetingId)
  } finally {
    await b.close()
  }
})

test('locking removes the session on the server side too: the next start needs the code again', async () => {
  const b = await serverAndBrowser()
  try {
    await b.controller.start({ code: LAUNCH })
    b.lives[0].ready()
    await b.controller.stop()
    b.controller.reset()
    assert.equal(b.controller.getState().launchReady, true)

    await b.controller.lock()
    assert.equal(b.controller.getState().launchReady, false)
    assert.equal(await b.controller.refreshLaunchSession(), false, 'the server agrees')

    const before = meetings(b.database)
    await b.controller.start({})
    assert.equal(meetings(b.database), before, 'no meeting without the code or a session')
    assert.match(b.controller.getState().message, /Enter the launch code/)
  } finally {
    await b.close()
  }
})

test('a launch whose answer was lost is retried into the SAME meeting, not a second one', async () => {
  const b = await serverAndBrowser({ dropFirstLaunchResponse: true })
  try {
    await b.controller.start({ code: LAUNCH, title: 'Once' })
    assert.equal(b.controller.getState().phase, 'idle', 'the first attempt looked like a failure to the page')
    assert.equal(meetings(b.database), 1, 'but the server had created the meeting')

    await b.controller.start({ code: LAUNCH, title: 'Once' })
    assert.equal(b.controller.getState().open, true)
    assert.equal(meetings(b.database), 1, 'the retry reused it')
    assert.equal(b.lives.length, 1)
  } finally {
    await b.close()
  }
})

test('a wrong code is refused as before and does not unlock anything', async () => {
  const b = await serverAndBrowser()
  try {
    await b.controller.start({ code: 'definitely-not-the-code' })
    assert.equal(b.controller.getState().open, false)
    assert.match(b.controller.getState().message, /not accepted/)
    assert.equal(b.jar.size, 0)
    assert.equal(await b.controller.refreshLaunchSession(), false)
    assert.equal(meetings(b.database), 0)
  } finally {
    await b.close()
  }
})
