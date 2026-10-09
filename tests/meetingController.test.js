import assert from 'node:assert/strict'
import test from 'node:test'
import { MeetingApiError } from '../src/interfaces/meeting/meetingApi.js'
import { createMeetingController, TICKET_PROTOCOL } from '../src/interfaces/meeting/meetingController.js'
import { createMemoryMeetingStorage, createMeetingStorage } from '../src/interfaces/meeting/meetingStorage.js'

const MEETING = '11111111-1111-4111-8111-111111111111'
const NOW = Date.parse('2026-10-09T10:00:00.000Z')
const launched = (overrides = {}) => ({
  meetingId: MEETING,
  status: 'LIVE',
  ticket: { token: 'ticket-token.sig', expiresAt: new Date(NOW + 12 * 3600 * 1000).toISOString() },
  ...overrides
})
const completed = (stored, { verified = true, unverified = 0 } = {}) => ({
  meetingId: MEETING,
  status: 'COMPLETED',
  integrity: {
    complete: true,
    verified,
    unverifiedSessions: unverified,
    missingSegments: 0,
    sessions: [{ storedSegments: stored, state: verified ? 'VERIFIED' : 'UNVERIFIED' }]
  }
})
const conflict = (code, details = null) => new MeetingApiError(code, { status: 409, code, details })
const seg = (n, text = `line ${n}`) => ({ id: `seg_${n}`, start: n, end: n + 1, text })

function fakeApi({ launch = launched(), end = [completed(0)] } = {}) {
  const calls = { launch: [], end: [] }
  const queue = [...end]
  return {
    calls,
    async launch(args) {
      calls.launch.push(args)
      if (launch instanceof Error) throw launch
      return launch
    },
    async end(args) {
      calls.end.push(args)
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next instanceof Error) throw next
      return next
    }
  }
}

/** Stands in for liveSpeechClient: the test pushes server events through `emit`. */
function fakeClients({ startError } = {}) {
  const made = []
  const create = (options) => {
    const handlers = {}
    const live = {
      options,
      stopCalls: 0,
      async start() {
        if (startError) {
          handlers.error?.(startError) // the real client reports the error, then throws it
          throw startError
        }
      },
      async stop() {
        live.stopCalls += 1
      },
      setOnReady: (fn) => (handlers.ready = fn),
      setOnPartial: (fn) => (handlers.partial = fn),
      setOnStabilizing: (fn) => (handlers.stabilizing = fn),
      setOnFinalSegment: (fn) => (handlers.final = fn),
      setOnError: (fn) => (handlers.error = fn),
      setOnStopped: (fn) => (handlers.stopped = fn),
      emit: {
        ready: (persistence = 'meeting') => handlers.ready({ sessionId: 's-1', persistence }),
        partial: (text) => handlers.partial(text),
        stabilizing: (text) => handlers.stabilizing(text),
        final: (segment, persisted) => handlers.final(segment, persisted),
        error: (err) => handlers.error(err)
      }
    }
    made.push(live)
    return live
  }
  create.made = made
  return create
}

function build({ api = fakeApi(), clients = fakeClients(), storage = createMemoryMeetingStorage(), checkSupport } = {}) {
  const sleeps = []
  const controller = createMeetingController({
    api,
    createLiveClient: clients,
    storage,
    checkSupport,
    sleep: async (ms) => sleeps.push(ms),
    retryDelaysMs: [10, 20, 30],
    now: () => NOW
  })
  const phases = []
  controller.subscribe((state) => {
    if (phases.at(-1) !== state.phase) phases.push(state.phase)
  })
  return { controller, api, clients, storage, sleeps, phases }
}

test('the happy path: launch, connect with the ticket, show saved lines, stop, end, verified', async () => {
  const { controller, api, clients, storage, phases } = build({ api: fakeApi({ end: [completed(2)] }) })

  await controller.start({ code: ' the-code ', title: '  Weekly sync ' })
  assert.deepEqual(api.calls.launch, [{ code: 'the-code', title: 'Weekly sync' }], 'code and title are trimmed')
  assert.equal(controller.getState().phase, 'connecting')
  assert.equal(controller.getState().open, true)

  const live = clients.made[0]
  assert.equal(live.options.meetingId, MEETING)
  assert.equal(live.options.meetingTicket, 'ticket-token.sig')
  assert.deepEqual(live.options.wsProtocols, [TICKET_PROTOCOL, 'ticket-token.sig'])
  assert.equal(storage.read().meetingId, MEETING, 'remembered so a reload can still finish it')

  live.emit.ready()
  assert.equal(controller.getState().phase, 'live')
  live.emit.partial('hel')
  assert.equal(controller.getState().partial, 'hel')
  live.emit.final(seg(1, 'hello'), 'INSERTED')
  live.emit.final(seg(2, 'world'), 'ALREADY_EXISTS')
  const live1 = controller.getState()
  assert.equal(live1.partial, '', 'a final line replaces the partial text')
  assert.deepEqual(live1.counts, { saved: 2, waiting: 0, notSaved: 0 })
  assert.deepEqual(live1.lines.map((line) => line.text), ['hello', 'world'])

  await controller.stop()
  assert.equal(live.stopCalls, 1)
  assert.deepEqual(api.calls.end, [{ meetingId: MEETING, ticketToken: 'ticket-token.sig' }])
  const done = controller.getState()
  assert.equal(done.phase, 'done')
  assert.equal(done.open, false)
  assert.equal(done.tone, 'ok')
  assert.deepEqual(done.result, { verified: true, storedSegments: 2, unverifiedSessions: 0, recordings: 1 })
  assert.match(done.message, /Saved 2 lines.*verified/)
  assert.equal(storage.read(), null, 'nothing left to resume')
  assert.deepEqual(phases, ['launching', 'connecting', 'live', 'stopping', 'ending', 'done'])
})

test('lines are counted by what the server did with them', async () => {
  const { controller, clients } = build()
  await controller.start({ code: 'code' })
  const live = clients.made[0]
  live.emit.ready()
  live.emit.final(seg(1), 'INSERTED')
  live.emit.final(seg(2), 'FAILED')
  live.emit.final(seg(3), 'REJECTED')
  live.emit.final(seg(4), 'NOT_PERSISTED')
  live.emit.final(seg(5), undefined)
  assert.deepEqual(controller.getState().counts, { saved: 1, waiting: 1, notSaved: 3 })
  assert.deepEqual(
    controller.getState().lines.map((line) => line.persisted),
    ['INSERTED', 'FAILED', 'REJECTED', 'NOT_PERSISTED', 'UNKNOWN']
  )
})

test('only the newest 500 lines are kept on screen but the counts stay exact', async () => {
  const { controller, clients } = build()
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready()
  for (let n = 0; n < 650; n++) clients.made[0].emit.final(seg(n), 'INSERTED')
  assert.equal(controller.getState().lines.length, 500)
  assert.equal(controller.getState().lines.at(-1).key, 'seg_649')
  assert.equal(controller.getState().counts.saved, 650)
})

test('a failed launch explains why, creates no recording, and remembers nothing', async () => {
  const cases = [
    [new MeetingApiError('x', { status: 401, code: 'launch-code-invalid' }), /not accepted/],
    [new MeetingApiError('x', { status: 401, code: 'launch-code-required' }), /Enter the launch code/],
    [new MeetingApiError('x', { status: 429, code: 'too-many-attempts' }), /Too many wrong codes/],
    [new MeetingApiError('x', { status: 503, code: 'launch-not-configured' }), /not set up on this server/],
    [new MeetingApiError('x', { status: 400, code: 'invalid-title' }), /title is too long/],
    [new MeetingApiError('x', { status: 0, code: 'network' }), /Could not reach the server/]
  ]
  for (const [error, pattern] of cases) {
    const { controller, clients, storage } = build({ api: fakeApi({ launch: error }) })
    await controller.start({ code: 'code', title: 'Keep me' })
    const state = controller.getState()
    assert.equal(state.phase, 'idle')
    assert.equal(state.open, false)
    assert.equal(state.tone, 'error')
    assert.match(state.message, pattern)
    assert.equal(state.title, 'Keep me', 'what the user typed is not lost')
    assert.equal(clients.made.length, 0, 'no recording was started')
    assert.equal(storage.read(), null)
  }
})

test('an empty launch code is caught before anything is sent', async () => {
  const { controller, api } = build()
  await controller.start({ code: '   ' })
  assert.equal(api.calls.launch.length, 0)
  assert.match(controller.getState().message, /Enter the launch code/)
})

test('a browser that cannot record never launches a meeting', async () => {
  const { controller, api, clients } = build({
    checkSupport: () => ({ ok: false, reason: 'The browser blocks the microphone on this page.' })
  })
  await controller.start({ code: 'code' })
  assert.equal(api.calls.launch.length, 0, 'nothing is created on the server for a page that cannot record')
  assert.equal(clients.made.length, 0)
  assert.equal(controller.getState().message, 'The browser blocks the microphone on this page.')
  assert.equal(controller.getState().tone, 'error')
})

test('a second start while a meeting is open is ignored', async () => {
  const { controller, api } = build()
  await controller.start({ code: 'code' })
  await controller.start({ code: 'code' })
  assert.equal(api.calls.launch.length, 1)
})

test('a blocked microphone leaves the meeting open, and Reconnect carries on with the same meeting', async () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
  let attempt = 0
  const made = []
  const clients = (options) => {
    attempt += 1
    const live = fakeClients({ startError: attempt === 1 ? denied : undefined })(options)
    made.push(live)
    return live
  }
  const { controller, api } = build({ clients })

  await controller.start({ code: 'code' })
  let state = controller.getState()
  assert.equal(state.phase, 'problem')
  assert.equal(state.open, true, 'the meeting exists on the server and is not forgotten')
  assert.equal(state.canReconnect, true)
  assert.equal(state.canEnd, true)
  assert.match(state.message, /microphone is blocked/)
  assert.equal(made[0].stopCalls, 1, 'the half-open client was released')

  // The user allows the microphone and presses Reconnect: same meeting, no second launch.
  await controller.reconnect()
  made[1].emit.ready()
  state = controller.getState()
  assert.equal(state.phase, 'live')
  assert.equal(api.calls.launch.length, 1)
  assert.equal(made[1].options.meetingId, MEETING)
})

test('Reconnect starts a new recording for the same meeting and lines keep adding up', async () => {
  const created = []
  const clients = (options) => {
    const live = fakeClients()(options)
    created.push(live)
    return live
  }
  const { controller } = build({ clients })
  await controller.start({ code: 'code' })
  created[0].emit.ready()
  created[0].emit.final(seg(1, 'before the drop'), 'INSERTED')

  created[0].emit.error(new Error('Live speech connection closed unexpectedly'))
  let state = controller.getState()
  assert.equal(state.phase, 'problem')
  assert.match(state.message, /Lost the connection/)
  assert.equal(state.lines.length, 1, 'what was already shown stays')

  await controller.reconnect()
  assert.equal(created.length, 2)
  assert.equal(created[1].options.meetingId, MEETING)
  assert.deepEqual(created[1].options.wsProtocols, [TICKET_PROTOCOL, 'ticket-token.sig'])
  created[1].emit.ready()
  created[1].emit.final(seg(2, 'after'), 'INSERTED')
  state = controller.getState()
  assert.equal(state.phase, 'live')
  assert.deepEqual(state.counts, { saved: 2, waiting: 0, notSaved: 0 })

  created[0].emit.final(seg(99, 'a stale event from the dead connection'), 'INSERTED')
  assert.equal(controller.getState().counts.saved, 2, 'events from the old connection are ignored')
})

test('a speech service that is not saving this meeting is treated as a problem, not as recording', async () => {
  const { controller, clients } = build()
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready('standalone')
  assert.equal(controller.getState().phase, 'problem')
  assert.match(controller.getState().message, /not saving this meeting/)
})

test('ending waits out a recording that is still closing, then succeeds', async () => {
  const { controller, clients, api, sleeps } = build({
    api: fakeApi({ end: [conflict('speech-session-active'), conflict('transcript-incomplete', { missingSegments: 1 }), completed(3)] })
  })
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready()
  await controller.stop()
  assert.equal(api.calls.end.length, 3)
  assert.deepEqual(sleeps, [10, 20], 'it waited between attempts')
  assert.equal(controller.getState().phase, 'done')
  assert.equal(controller.getState().result.storedSegments, 3)
})

test('when lines stay missing it stops retrying, says how many, and Try again works later', async () => {
  const { controller, clients, api, sleeps } = build({
    api: fakeApi({ end: [conflict('transcript-incomplete', { missingSegments: 2 }), conflict('transcript-incomplete', { missingSegments: 2 }), conflict('transcript-incomplete', { missingSegments: 2 }), conflict('transcript-incomplete', { missingSegments: 2 }), completed(5)] })
  })
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready()
  await controller.stop()

  assert.equal(api.calls.end.length, 4, 'one try plus three retries, then it gives up')
  assert.deepEqual(sleeps, [10, 20, 30])
  let state = controller.getState()
  assert.equal(state.phase, 'problem')
  assert.equal(state.open, true, 'still open, so nothing is lost')
  assert.equal(state.canEnd, true)
  assert.equal(state.canReconnect, false)
  assert.match(state.message, /2 lines are not saved yet/)

  await controller.finish()
  assert.equal(controller.getState().phase, 'done')
})

test('ending reports honestly when the meeting could not be verified', async () => {
  const { controller, clients } = build({ api: fakeApi({ end: [completed(4, { verified: false, unverified: 1 })] }) })
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready()
  await controller.stop()
  const state = controller.getState()
  assert.equal(state.phase, 'done')
  assert.equal(state.tone, 'warn')
  assert.equal(state.result.verified, false)
  assert.match(state.message, /Ended with 4 lines saved, but NOT verified/)
  assert.match(state.message, /1 recording never confirmed/)
})

test('a ticket the server no longer accepts offers to forget the meeting and names it for the operator', async () => {
  const { controller, clients, storage } = build({
    api: fakeApi({ end: [new MeetingApiError('x', { status: 401, code: 'ticket-expired' })] })
  })
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready()
  await controller.stop()
  const state = controller.getState()
  assert.equal(state.phase, 'problem')
  assert.equal(state.canDiscard, true)
  assert.match(state.message, new RegExp(`end meeting ${MEETING}`))
  assert.notEqual(storage.read(), null, 'still remembered until the user decides')

  controller.discard()
  assert.equal(controller.getState().phase, 'idle')
  assert.equal(controller.getState().open, false)
  assert.equal(storage.read(), null)
  assert.match(controller.getState().message, /still open on the server/)
})

test('a network failure while ending is retryable and does not forget the meeting', async () => {
  const { controller, clients } = build({
    api: fakeApi({ end: [new MeetingApiError('offline', { status: 0, code: 'network' }), completed(1)] })
  })
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready()
  await controller.stop()
  assert.equal(controller.getState().phase, 'problem')
  assert.match(controller.getState().message, /Could not reach the server/)
  assert.equal(controller.getState().canDiscard, false)
  await controller.finish()
  assert.equal(controller.getState().phase, 'done')
})

test('finishing twice at once sends one request', async () => {
  const { controller, clients, api } = build({ api: fakeApi({ end: [completed(1)] }) })
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready()
  await controller.stop()
  await Promise.all([controller.finish(), controller.finish()])
  assert.equal(api.calls.end.length, 1)
})

test('a meeting left open by an earlier page load can be finished', async () => {
  const storage = createMemoryMeetingStorage()
  storage.write({ meetingId: MEETING, ticketToken: 'old-token.sig', expiresAt: new Date(NOW + 3600_000).toISOString(), title: 'Before the reload', startedAt: new Date(NOW - 600_000).toISOString() })
  const { controller, api } = build({ storage, api: fakeApi({ end: [completed(7)] }) })

  controller.restore()
  let state = controller.getState()
  assert.equal(state.phase, 'unfinished')
  assert.equal(state.open, true)
  assert.equal(state.title, 'Before the reload')
  assert.equal(state.canEnd, true)

  await controller.start({ code: 'code' })
  assert.equal(api.calls.launch.length, 0, 'cannot start another meeting over an unfinished one')

  await controller.finish()
  assert.deepEqual(api.calls.end, [{ meetingId: MEETING, ticketToken: 'old-token.sig' }])
  assert.equal(controller.getState().phase, 'done')
  assert.equal(storage.read(), null)
})

test('a remembered meeting whose ticket has expired is dropped with a note for the operator', () => {
  const storage = createMemoryMeetingStorage()
  storage.write({ meetingId: MEETING, ticketToken: 'old.sig', expiresAt: new Date(NOW - 1000).toISOString() })
  const { controller } = build({ storage })
  controller.restore()
  assert.equal(controller.getState().phase, 'idle')
  assert.match(controller.getState().message, new RegExp(MEETING))
  assert.equal(storage.read(), null)
})

test('an unfinished meeting can be forgotten by the user', () => {
  const storage = createMemoryMeetingStorage()
  storage.write({ meetingId: MEETING, ticketToken: 't.sig', expiresAt: new Date(NOW + 1000).toISOString() })
  const { controller } = build({ storage })
  controller.restore()
  controller.discard()
  assert.equal(controller.getState().phase, 'idle')
  assert.equal(storage.read(), null)
})

test('a meeting that never recorded anything says so instead of claiming it is verified', async () => {
  const empty = { meetingId: MEETING, status: 'COMPLETED', integrity: { complete: true, verified: true, unverifiedSessions: 0, missingSegments: 0, sessions: [] } }
  const { controller, clients } = build({ api: fakeApi({ end: [empty] }) })
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready()
  await controller.stop()
  const state = controller.getState()
  assert.equal(state.phase, 'done')
  assert.equal(state.message, 'Meeting ended. Nothing was recorded.')
  assert.equal(state.tone, 'info')
  assert.equal(state.result.recordings, 0)
})

test('after a finished meeting the form comes back with reset', async () => {
  const { controller, clients } = build()
  await controller.start({ code: 'code' })
  clients.made[0].emit.ready()
  await controller.stop()
  assert.equal(controller.getState().phase, 'done')
  controller.reset()
  assert.equal(controller.getState().phase, 'idle')
  assert.deepEqual(controller.getState().lines, [])
})

test('storage that throws never breaks the meeting', () => {
  const broken = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
    removeItem() {
      throw new Error('blocked')
    }
  }
  const storage = createMeetingStorage(broken)
  assert.equal(storage.read(), null)
  assert.doesNotThrow(() => storage.write({ meetingId: MEETING, ticketToken: 't' }))
  assert.doesNotThrow(() => storage.clear())

  const garbage = createMeetingStorage({ getItem: () => '{not json', setItem() {}, removeItem() {} })
  assert.equal(garbage.read(), null)
  const wrongShape = createMeetingStorage({ getItem: () => JSON.stringify({ meetingId: 5 }), setItem() {}, removeItem() {} })
  assert.equal(wrongShape.read(), null)
})
