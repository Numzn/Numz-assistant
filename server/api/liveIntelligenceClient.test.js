import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import express from 'express'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createMeetingRepository } from '../persistence/meetingRepository.js'
import { createSpeechSessionRepository } from '../persistence/speechSessionRepository.js'
import { createTranscriptRepository } from '../persistence/transcriptRepository.js'
import { createMeetingSessionService } from '../services/meetingSessionService.js'
import { createLiveMeetingIntelligence } from '../services/liveMeetingIntelligenceService.js'
import { createMeetingAuth } from '../auth/meetingAuth.js'
import { createMeetingsRouter } from '../routes/meetings.js'
import { errorHandler, notFoundHandler } from '../http/errorHandler.js'
import { createMeetingApi } from '../../src/interfaces/meeting/meetingApi.js'
import { createMeetingController } from '../../src/interfaces/meeting/meetingController.js'
import { createCommandRouter } from '../../src/interfaces/commands/meetingCommands.js'
import { createMemoryMeetingStorage } from '../../src/interfaces/meeting/meetingStorage.js'

/**
 * The whole pipeline, with the browser's own code on one side and the server's on the other, over real HTTP:
 *
 *   sidecar persists a line (ticket) -> canonical store -> live intelligence -> GET .../intelligence/live
 *   -> the page's one copy of the state -> the meeting panel's state AND NUMZ AI chat's answer.
 *
 * Only the model and the microphone are stand-ins. A cookie jar is not needed (the launch code is typed).
 */

const ADMIN = 'admin-token-'.padEnd(40, 'x')
const SECRET = 'ticket-secret-'.padEnd(40, 'y')
const CODE = 'launch-code-for-tests-only'
const quiet = { error() {}, warn() {}, info() {}, log() {} }
// Real sockets are involved, so "let everything run" is a short real wait, not a few microtask turns.
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 15))
}

function manualTimers() {
  let id = 0
  const tasks = new Map()
  return {
    setTimeout(fn, ms) {
      const task = { id: ++id, fn, ms, unref() {} }
      tasks.set(task.id, task)
      return task
    },
    clearTimeout(task) {
      if (task) tasks.delete(task.id)
    },
    waiting: () => [...tasks.values()].map((t) => t.ms),
    async fire() {
      const due = [...tasks.values()]
      tasks.clear()
      for (const task of due) task.fn()
      await settle()
    }
  }
}

async function stack() {
  const database = createDatabase({ filename: ':memory:' })
  const eventBus = new EventEmitter()
  const meetingService = createMeetingSessionService({
    meetingRepository: createMeetingRepository(database),
    speechSessionRepository: createSpeechSessionRepository(database),
    transcriptRepository: createTranscriptRepository(database),
    eventBus
  })
  const serverTimers = manualTimers()
  const prompts = []
  const live = createLiveMeetingIntelligence({
    meetingService,
    eventBus,
    timers: serverTimers,
    logger: quiet,
    generateRolling: async (messages) => {
      const prompt = messages[1].content
      prompts.push(prompt)
      const ids = [...prompt.split('New segments:\n')[1].matchAll(/\[(seg_[^ ]+) \|/g)].map((m) => m[1])
      return JSON.stringify({
        currentTopics: [{ topic: 'Launch and testing', source: { segmentIds: ids } }],
        decisions: [],
        openQuestions: [{ question: 'Does the budget cover the servers?', source: { segmentIds: ids.slice(-1) } }],
        actionItems: [],
        importantPoints: [{ point: 'Testing is on Thursday', source: { segmentIds: ids.slice(-1) } }]
      })
    },
    generateFinal: async ({ segments }) => ({
      notes: {
        summary: 'The team agreed to move the launch to Friday and Priya will run the final testing by Thursday.',
        keyTopics: [{ topic: 'Launch date', source: { segmentIds: [segments[0].id] } }],
        decisions: [{ decision: 'Launch moves to Friday', source: { segmentIds: [segments[0].id] } }],
        actionItems: [{ action: 'Run the final testing', owner: 'Priya', due: 'by Thursday', source: { segmentIds: [segments[1].id] } }],
        openQuestions: [{ question: 'Does the budget cover the servers?', source: { segmentIds: [segments[2].id] } }]
      }
    })
  })
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, launchCode: CODE, logger: quiet })
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use((req, _res, next) => {
    req.id = 'test-request'
    next()
  })
  app.use('/api/v1/meetings', createMeetingsRouter({ meetingService, auth, liveIntelligence: live }))
  app.use('/api', notFoundHandler)
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, serverTimers, prompts, live, meetingService, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** One browser: the page's api, controller and command router, with a fake recorder. */
function browser(origin, { storage = createMemoryMeetingStorage() } = {}) {
  const launches = []
  const fetchFn = async (url, init = {}) => {
    const res = await fetch(`${origin}${url}`, init)
    if (url.endsWith('/launch') && res.ok) launches.push(await res.clone().json())
    return res
  }
  const api = createMeetingApi({ fetchFn })
  const clientTimers = manualTimers()
  const recorder = { stops: 0, onStop: null }
  const controller = createMeetingController({
    api,
    storage,
    createLiveClient: () => {
      let ready = () => {}
      return {
        async start() {
          queueMicrotask(() => ready({ persistence: 'meeting' }))
        },
        async stop() {
          recorder.stops += 1
          await recorder.onStop?.()
        },
        setOnReady: (fn) => (ready = fn),
        setOnPartial() {},
        setOnStabilizing() {},
        setOnFinalSegment() {},
        setOnError() {},
        setOnStopped() {}
      }
    },
    sleep: async () => {
      await settle()
    },
    retryDelaysMs: [1],
    intelligenceOptions: {
      setTimer: (fn, ms) => clientTimers.setTimeout(fn, ms),
      clearTimer: (t) => clientTimers.clearTimeout(t),
      isHidden: () => false
    }
  })
  const router = createCommandRouter({ meeting: controller, openPanel: () => {}, finalTimeoutMs: 5000 })
  return { api, controller, router, clientTimers, launches, recorder }
}

async function http(origin, method, path, { token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${origin}/api/v1/meetings${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

/** What the speech sidecar does: attach a session with the ticket and store each final line. */
async function sidecar(origin, meetingId, ticket) {
  const session = (await http(origin, 'POST', `/${meetingId}/sessions`, { token: ticket, body: {} })).json
  let n = 0
  return {
    async say(text, extra = {}) {
      n += 1
      const segment = {
        id: `seg_${String(n).padStart(4, '0')}`,
        start: n * 10,
        end: n * 10 + 8,
        text,
        speaker: null,
        speakerConfidence: null,
        words: [],
        confidence: null,
        language: 'en',
        uncertain: false,
        ...extra
      }
      const res = await http(origin, 'POST', `/${meetingId}/transcript/final`, {
        token: ticket,
        body: { speechSessionId: session.speechSessionId, segment }
      })
      assert.equal(res.status, 201)
      return segment
    },
    async finish() {
      return http(origin, 'POST', `/${meetingId}/sessions/${session.speechSessionId}/end`, {
        token: ticket,
        body: { reason: 'stopped', committedSegments: n }
      })
    }
  }
}

test('a spoken line becomes a finding the panel shows and chat can quote, from one copy of the state', async () => {
  const s = await stack()
  try {
    const b = browser(s.origin)
    await b.controller.start({ code: CODE, title: 'Weekly' })
    await settle()
    const { meetingId, ticket } = b.launches[0]
    const mic = await sidecar(s.origin, meetingId, ticket.token)

    await mic.say('The team agreed to move the launch to Friday.')
    await mic.say('Priya will run the final testing by Thursday.')
    await mic.say('Does the budget cover the extra servers?')

    // 1. the server's debounced update, then the page's next look
    await s.serverTimers.fire()
    await b.clientTimers.fire()
    const state = b.controller.getState()
    assert.equal(state.intelligence.meetingId, meetingId)
    assert.equal(state.intelligence.analysis.status, 'current')
    assert.equal(state.intelligence.analysis.mergedSegments, 3)
    assert.equal(state.intelligence.phase, 'live')
    assert.equal(state.intelligence.provisional, true)
    assert.equal(b.controller.getIntelligence(), state.intelligence, 'the panel and chat read the same object')

    // 2. the panel's findings
    const f = state.intelligence.findings
    assert.deepEqual(f.decisions.map((d) => [d.status, d.text]), [['confirmed', 'The team agreed to move the launch to Friday.']])
    assert.equal(f.actionItems[0].owner.name, 'Priya')
    assert.equal(f.actionItems[0].due, 'by Thursday')
    assert.equal(f.openQuestions[0].text, 'Does the budget cover the servers?')
    assert.equal(f.openQuestions[0].evidence[0].text, 'Does the budget cover the extra servers?', 'the quote is the saved line')

    // 3. chat answers from that same state (after asking the server to update)
    const asked = await b.router.handle('What decisions have been made?')
    assert.match(asked.reply, /Live — provisional/)
    assert.match(asked.reply, /agreed to move the launch to Friday\.? — stated in the transcript; at 0:10/)
    const who = await b.router.handle('Who is responsible for each task?')
    assert.match(who.reply, /\*\*Priya\*\*: Priya will run the final testing by Thursday\.? \(by Thursday\)/)
    const open = await b.router.handle('What questions remain unanswered?')
    assert.match(open.reply, /Does the budget cover the servers\?/)
    assert.equal(b.controller.getIntelligence().meetingId, meetingId)
  } finally {
    await s.close()
  }
})

test('chat shows the pending count before the update and the new finding after it', async () => {
  const s = await stack()
  try {
    const b = browser(s.origin)
    await b.controller.start({ code: CODE })
    await settle()
    const { meetingId, ticket } = b.launches[0]
    const mic = await sidecar(s.origin, meetingId, ticket.token)
    await mic.say('We decided to postpone the offsite.')
    await b.clientTimers.fire()
    const before = b.controller.getIntelligence()
    assert.equal(before.analysis.status, 'behind')
    assert.equal(before.analysis.pendingSegments, 1)
    assert.equal(before.findings.decisions[0].status, 'confirmed', 'the words themselves are findings already')
    assert.equal(s.prompts.length, 0, 'the model has not been asked yet')

    const reply = await b.router.handle('show me the notes so far') // asks the server to update now
    assert.equal(s.prompts.length, 1)
    assert.match(reply.reply, /Live — provisional/)
    assert.equal(b.controller.getIntelligence().analysis.pendingSegments, 0)
  } finally {
    await s.close()
  }
})

test('end the meeting and get the verified final summary: stop, integrity, drain, final record, reply', async () => {
  const s = await stack()
  try {
    const b = browser(s.origin)
    await b.controller.start({ code: CODE })
    await settle()
    const { meetingId, ticket } = b.launches[0]
    const mic = await sidecar(s.origin, meetingId, ticket.token)
    await mic.say('The team agreed to move the launch to Friday.')
    await mic.say('Priya will run the final testing by Thursday.')
    await mic.say('Does the budget cover the extra servers?')
    b.recorder.onStop = async () => {
      await mic.finish() // the speech service reports its committed count when it stops
    }

    const confirm = await b.router.handle('End the meeting and give me the final summary')
    assert.match(confirm.reply, /Stop and save the meeting, then give you the final summary\?/)
    assert.equal(b.recorder.stops, 0)

    const done = await b.router.handle('yes')
    assert.equal(b.recorder.stops, 1)
    assert.match(done.reply, /Saved 3 lines\. The transcript is complete and verified\./)
    assert.match(done.reply, /Final — the transcript was verified/)
    assert.match(done.reply, /The team agreed to move the launch to Friday and Priya will run the final testing by Thursday\./)
    // the words themselves state it, so the stated line stands in for the model's reading of the same segment
    assert.match(done.reply, /Priya will run the final testing by Thursday\.? — owner: Priya; due: by Thursday; stated in the transcript/)
    assert.equal(done.tone, 'ok')

    const intel = b.controller.getIntelligence()
    assert.equal(intel.phase, 'final')
    assert.equal(intel.provisional, false)
    assert.equal(intel.transcript.state, 'verified')
    assert.equal(b.controller.getState().phase, 'done')
    assert.equal(b.controller.getState().result.verified, true)
    assert.deepEqual(s.meetingService.getTranscript(meetingId).map((x) => x.text), [
      'The team agreed to move the launch to Friday.',
      'Priya will run the final testing by Thursday.',
      'Does the budget cover the extra servers?'
    ], 'the canonical transcript is exactly what was said')
  } finally {
    await s.close()
  }
})

test('a meeting that could not be verified gets no final summary, and chat says so', async () => {
  const s = await stack()
  try {
    const b = browser(s.origin)
    await b.controller.start({ code: CODE })
    await settle()
    const { meetingId, ticket } = b.launches[0]
    const session = (await http(s.origin, 'POST', `/${meetingId}/sessions`, { token: ticket.token, body: {} })).json
    await http(s.origin, 'POST', `/${meetingId}/transcript/final`, {
      token: ticket.token,
      body: {
        speechSessionId: session.speechSessionId,
        segment: { id: 'seg_0001', start: 1, end: 5, text: 'We decided to cut the scope.', speaker: null, speakerConfidence: null, words: [], confidence: null, language: 'en', uncertain: false }
      }
    })
    b.recorder.onStop = async () => {
      // the recording ends without ever confirming how many lines it produced
      await http(s.origin, 'POST', `/${meetingId}/sessions/${session.speechSessionId}/end`, { token: ticket.token, body: { reason: 'stopped' } })
    }
    await b.router.handle('end the meeting and give me the final summary')
    const done = await b.router.handle('yes')
    assert.match(done.reply, /NOT verified/)
    assert.match(done.reply, /no final summary/)
    assert.match(done.reply, /could not be verified/)
    assert.equal(done.tone, 'warn')
    assert.equal(b.controller.getIntelligence().final.status, 'withheld')
  } finally {
    await s.close()
  }
})

test('two meetings at the same time: each page sees only its own findings', async () => {
  const s = await stack()
  try {
    const a = browser(s.origin)
    const b = browser(s.origin)
    await a.controller.start({ code: CODE, title: 'A' })
    await b.controller.start({ code: CODE, title: 'B' })
    await settle()
    const micA = await sidecar(s.origin, a.launches[0].meetingId, a.launches[0].ticket.token)
    const micB = await sidecar(s.origin, b.launches[0].meetingId, b.launches[0].ticket.token)
    await micA.say('We decided to hire two engineers for Alpha.')
    await micB.say('We decided to close the Bravo office.')
    await s.serverTimers.fire()
    await a.clientTimers.fire()
    await b.clientTimers.fire()
    const fa = JSON.stringify(a.controller.getIntelligence())
    const fb = JSON.stringify(b.controller.getIntelligence())
    assert.match(fa, /Alpha/)
    assert.doesNotMatch(fa, /Bravo/)
    assert.match(fb, /Bravo/)
    assert.doesNotMatch(fb, /Alpha/)
    for (const prompt of s.prompts) assert.ok(!(/Alpha/.test(prompt) && /Bravo/.test(prompt)), 'no prompt mixed the two meetings')
    const replyA = await a.router.handle('what decisions have been made')
    assert.match(replyA.reply, /Alpha/)
    assert.doesNotMatch(replyA.reply, /Bravo/)
  } finally {
    await s.close()
  }
})

test('a page holding another meeting\'s ticket is refused, says so, shows no findings and stops asking', async () => {
  const s = await stack()
  try {
    const intruder = browser(s.origin)
    await intruder.controller.start({ code: CODE })
    await settle()
    const victim = browser(s.origin)
    await victim.controller.start({ code: CODE })
    await settle()
    const micVictim = await sidecar(s.origin, victim.launches[0].meetingId, victim.launches[0].ticket.token)
    await micVictim.say('We decided to close the Bravo office.')

    // The server refuses the intruder's ticket on the victim's meeting...
    const direct = await http(s.origin, 'GET', `/${victim.launches[0].meetingId}/intelligence/live`, { token: intruder.launches[0].ticket.token })
    assert.equal(direct.status, 403)
    assert.equal((await http(s.origin, 'POST', `/${victim.launches[0].meetingId}/intelligence/refresh`, { token: intruder.launches[0].ticket.token, body: {} })).status, 403)

    // ...and a page that was handed that pairing gets nothing and gives up.
    const storage = createMemoryMeetingStorage()
    storage.write({
      meetingId: victim.launches[0].meetingId,
      ticketToken: intruder.launches[0].ticket.token,
      expiresAt: intruder.launches[0].ticket.expiresAt,
      title: 'stolen'
    })
    const page = browser(s.origin, { storage })
    page.controller.restore()
    await settle()
    const state = page.controller.getState()
    assert.equal(page.controller.getIntelligence(), null)
    assert.equal(state.intelligenceError.fatal, true)
    assert.match(state.intelligenceError.message, /no longer accepts/)
    assert.deepEqual(page.clientTimers.waiting(), [], 'it does not keep asking')
    const reply = await page.router.handle('what decisions have been made')
    assert.doesNotMatch(reply.reply, /Bravo/)
  } finally {
    await s.close()
  }
})

test('a model outage is visible in chat and the panel, and nothing in the transcript is touched', async () => {
  const s = await stack()
  try {
    const b = browser(s.origin)
    await b.controller.start({ code: CODE })
    await settle()
    const { meetingId, ticket } = b.launches[0]
    const mic = await sidecar(s.origin, meetingId, ticket.token)
    // break the provider for this meeting
    const runtime = s.live._runtime(meetingId) ?? (s.live.getState(meetingId), s.live._runtime(meetingId))
    runtime.tracker = Object.assign(runtime.tracker, {
      snapshot: async () => {
        throw Object.assign(new Error('provider down'), { statusCode: 502 })
      }
    })
    await mic.say('We decided to postpone the launch.')
    await s.serverTimers.fire()
    await b.clientTimers.fire()
    const state = b.controller.getState().intelligence
    assert.equal(state.analysis.status, 'error')
    const reply = await b.router.handle('what decisions have been made')
    assert.match(reply.reply, /failing/)
    assert.match(reply.reply, /provider down/)
    assert.match(reply.reply, /postpone the launch/, 'what the words state is still there')
    assert.equal(s.meetingService.getTranscript(meetingId).length, 1)
  } finally {
    await s.close()
  }
})
