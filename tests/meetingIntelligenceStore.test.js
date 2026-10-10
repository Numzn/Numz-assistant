import assert from 'node:assert/strict'
import test from 'node:test'
import { MeetingApiError } from '../src/interfaces/meeting/meetingApi.js'
import { createIntelligenceStore } from '../src/interfaces/meeting/meetingIntelligenceStore.js'

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

function rig({ hidden = false } = {}) {
  let clock = 1_000_000
  const timers = []
  const calls = { intelligence: [], refresh: [] }
  const changes = []
  let revision = 1
  let respond = null
  const api = {
    async intelligence(args) {
      calls.intelligence.push(args)
      if (respond) return respond(args)
      if (args.since === revision) return { unchanged: true, revision }
      return { revision, final: { status: 'not-started' }, findings: {} }
    },
    async refreshIntelligence(args) {
      calls.refresh.push(args)
      if (respond) return respond(args)
      revision += 1
      return { revision, final: { status: 'not-started' }, findings: {} }
    }
  }
  const state = { hidden }
  const store = createIntelligenceStore({
    api,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false, unref() {} }
      timers.push(t)
      return t
    },
    clearTimer: (t) => t && (t.cleared = true),
    isHidden: () => state.hidden,
    onChange: (s) => changes.push(s)
  })
  return {
    store,
    api,
    calls,
    changes,
    timers,
    state,
    setRespond: (fn) => (respond = fn),
    bump: () => (revision += 1),
    advance: (ms) => (clock += ms),
    waiting: () => timers.filter((t) => !t.cleared && !t.fired).map((t) => t.ms),
    async fire() {
      const live = timers.filter((t) => !t.cleared && !t.fired)
      for (const t of live) {
        t.fired = true
        t.fn()
      }
      await settle()
    }
  }
}

const target = { meetingId: 'm-1', ticketToken: 'tok' }

test('tracking fetches at once with the meeting\'s own ticket and schedules the next look', async () => {
  const r = rig()
  r.store.track(target)
  await settle()
  assert.deepEqual(r.calls.intelligence, [{ meetingId: 'm-1', ticketToken: 'tok', since: null }])
  assert.equal(r.store.get().data.revision, 1)
  assert.deepEqual(r.waiting(), [4000])
})

test('only changes are asked for, and an unchanged answer changes nothing the page renders', async () => {
  const r = rig()
  r.store.track(target)
  await settle()
  const before = r.changes.length
  await r.fire()
  assert.equal(r.calls.intelligence.at(-1).since, 1, 'it asks for what is newer than revision 1')
  assert.equal(r.changes.length, before, 'no re-render for "nothing new"')
  r.bump()
  await r.fire()
  assert.equal(r.store.get().data.revision, 2)
})

test('a hidden tab polls slowly, a failing server is backed off, and success returns to the normal pace', async () => {
  const r = rig({ hidden: true })
  r.store.track(target)
  await settle()
  assert.deepEqual(r.waiting(), [20000])
  r.state.hidden = false
  r.setRespond(() => {
    throw new MeetingApiError('down', { status: 0, code: 'network' })
  })
  await r.fire()
  assert.equal(r.store.get().error.code, 'network')
  assert.match(r.store.get().error.message, /Could not reach/)
  assert.deepEqual(r.waiting(), [8000], 'backed off')
  await r.fire()
  assert.deepEqual(r.waiting(), [16000])
  r.setRespond(null)
  await r.fire()
  assert.equal(r.store.get().error, null)
  assert.deepEqual(r.waiting(), [4000])
})

test('a ticket the server refuses stops the polling and says why', async () => {
  const r = rig()
  r.store.track(target)
  await settle()
  r.setRespond(() => {
    throw new MeetingApiError('no', { status: 403, code: 'forbidden' })
  })
  await r.fire()
  assert.equal(r.store.get().error.fatal, true)
  assert.match(r.store.get().error.message, /no longer accepts/)
  assert.deepEqual(r.waiting(), [], 'nothing more is scheduled')
})

test('one request at a time: a forced refresh joins the one in flight', async () => {
  const r = rig()
  let release
  const gate = new Promise((resolve) => (release = resolve))
  r.setRespond(async () => {
    await gate
    return { revision: 5, final: { status: 'not-started' } }
  })
  r.store.track(target)
  await settle()
  const refreshing = r.store.refresh()
  await settle()
  assert.equal(r.calls.intelligence.length + r.calls.refresh.length, 1)
  release()
  await refreshing
  assert.equal(r.store.get().data.revision, 5)
})

test('after closure it polls until the final record is settled, then stops for good', async () => {
  const r = rig()
  r.store.track(target)
  await settle()
  let status = 'running'
  r.setRespond(() => ({ revision: 9, final: { status } }))
  r.store.markClosed()
  await settle()
  assert.equal(r.store.isFinalSettled(), false)
  assert.deepEqual(r.waiting(), [3000], 'a closed meeting is polled a little faster until it settles')
  status = 'ready'
  r.bump()
  await r.fire()
  assert.equal(r.store.isFinalSettled(), true)
  assert.deepEqual(r.waiting(), [], 'terminal: no more polling')
})

test('a closed meeting whose final was lost (a restart) is asked for once', async () => {
  const r = rig()
  r.store.track(target)
  await settle()
  r.setRespond((args) => ({ revision: 3, final: { status: args.since !== undefined && 'final' in args ? 'ready' : 'pending' } }))
  r.store.markClosed()
  await settle()
  assert.equal(r.calls.refresh.length, 1)
  assert.equal(r.calls.refresh[0].final, false)
})

test('forgetting a meeting drops its data and ignores a response that arrives afterwards', async () => {
  const r = rig()
  let release
  const gate = new Promise((resolve) => (release = resolve))
  r.setRespond(async () => {
    await gate
    return { revision: 2, findings: { decisions: ['from the old meeting'] } }
  })
  r.store.track(target)
  await settle()
  r.store.untrack()
  release()
  await settle()
  assert.equal(r.store.get().data, null)
  assert.deepEqual(r.waiting(), [])
})

test('tracking a different meeting never shows the previous one\'s data', async () => {
  const r = rig()
  r.setRespond(({ meetingId }) => ({ revision: 1, meetingId, final: { status: 'not-started' } }))
  r.store.track({ meetingId: 'A', ticketToken: 'ta' })
  await settle()
  assert.equal(r.store.get().data.meetingId, 'A')
  r.store.track({ meetingId: 'B', ticketToken: 'tb' })
  assert.equal(r.store.get().data, null, 'cleared at once, before B answers')
  await settle()
  assert.equal(r.store.get().data.meetingId, 'B')
})

test('awaitFinal returns when the record is settled and gives up at the time limit with what it has', async () => {
  const r = rig()
  r.store.track(target)
  await settle()
  let n = 0
  r.setRespond(() => ({ revision: ++n, final: { status: n >= 3 ? 'ready' : 'running' } }))
  const settled = await r.store.awaitFinal({ timeoutMs: 60000, sleep: async () => r.advance(3000) })
  assert.equal(settled.final.status, 'ready')

  const slow = rig()
  slow.store.track(target)
  await settle()
  slow.setRespond(() => ({ revision: 1, final: { status: 'running' } }))
  const gaveUp = await slow.store.awaitFinal({ timeoutMs: 9000, sleep: async () => slow.advance(3000) })
  assert.equal(gaveUp.final.status, 'running')
})
