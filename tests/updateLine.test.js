import assert from 'node:assert/strict'
import test from 'node:test'
import { createUpdateController, installFailure } from '../src/interfaces/desktop/updateLine.js'

const memory = () => {
  const data = new Map()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) }
}
const timers = () => {
  const queue = []
  return { queue, setTimer: (fn, ms) => (queue.push({ fn, ms }), queue.length), clearTimer: () => {} }
}
const newer = (version = '0.3.0') => ({ current: '0.2.0', available: true, version, notes: 'Faster answers.' })
const same = { current: '0.2.0', available: false, version: null, notes: null }

test('in a browser (no desktop app) nothing is asked and nothing is shown', async () => {
  const calls = []
  const c = createUpdateController({ invoke: null, storage: memory() })
  assert.equal(c.available, false)
  c.start()
  await c.check()
  await c.install()
  assert.equal(c.getState().phase, 'idle')
  assert.equal(calls.length, 0)
})

test('a newer version is offered; the same version is not; the line goes away if the version it offered is no longer there', async () => {
  const answers = [newer(), same]
  const c = createUpdateController({ invoke: async (cmd) => (assert.equal(cmd, 'app_update_check'), answers.shift()), storage: memory() })
  await c.check()
  assert.deepEqual([c.getState().phase, c.getState().version, c.getState().current, c.getState().notes], ['available', '0.3.0', '0.2.0', 'Faster answers.'])
  await c.check()
  assert.equal(c.getState().phase, 'idle')
})

test('looking is quiet: no network, a refusal or nonsense shows nothing and changes nothing', async () => {
  for (const reply of [() => Promise.reject({ code: 'unreachable', message: 'offline' }), () => Promise.reject('boom'), async () => null, async () => ({ foo: 1 }), async () => ({ current: '0.2.0', available: true, version: '' })]) {
    const c = createUpdateController({ invoke: reply, storage: memory() })
    await c.check()
    assert.equal(c.getState().phase, 'idle')
  }
})

test('"Not now" puts the line away and that version is not offered again until the next start; a newer one is', async () => {
  const store = memory()
  const replies = [newer('0.3.0'), newer('0.3.0'), newer('0.3.1')]
  const make = () => createUpdateController({ invoke: async () => replies.shift(), storage: store })
  const c = make()
  await c.check()
  c.dismiss()
  assert.equal(c.getState().phase, 'idle')
  await c.check()
  assert.equal(c.getState().phase, 'idle', 'the same version stays put away')
  await c.check()
  assert.deepEqual([c.getState().phase, c.getState().version], ['available', '0.3.1'], 'a newer one is offered')
})

test('"Update now" installs: the line says it is updating and cannot be pressed twice; a failure says why and offers another try', async () => {
  const seen = []
  let release
  let fail = true
  const invoke = async (cmd) => {
    seen.push(cmd)
    if (cmd === 'app_update_check') return newer()
    if (fail) throw { code: 'unverified', message: 'The update was not signed by NUMZ AI, so it was not installed.' }
    return new Promise((resolve) => (release = resolve))
  }
  const c = createUpdateController({ invoke, storage: memory() })
  await c.check()
  await c.install()
  assert.deepEqual([c.getState().phase, c.getState().message], ['failed', 'The update was not signed by NUMZ AI, so it was not installed.'])
  fail = false
  const working = c.install()
  assert.equal(c.getState().phase, 'installing')
  await c.install() // pressed again while it works
  await c.check() // and a look at the same time changes nothing
  assert.deepEqual(seen.filter((x) => x === 'app_update_install').length, 2, 'two installs in all: the failed one and the one in progress, not three')
  assert.equal(c.getState().phase, 'installing')
  release()
  await working
})

test('an install can only be asked for once a version has been found', async () => {
  const seen = []
  const c = createUpdateController({ invoke: async (cmd) => (seen.push(cmd), same), storage: memory() })
  await c.install()
  assert.deepEqual(seen, [])
})

test('the first look comes a little after the page opens, then every few hours, and stopping stops it', async () => {
  const t = timers()
  let looks = 0
  const c = createUpdateController({ invoke: async () => (looks++, same), storage: memory(), setTimer: t.setTimer, clearTimer: t.clearTimer, firstLookMs: 15_000, lookEveryMs: 21_600_000 })
  c.start()
  c.start() // starting twice is one schedule
  assert.deepEqual(t.queue.map((x) => x.ms), [15_000])
  await t.queue[0].fn()
  assert.equal(looks, 1)
  assert.deepEqual(t.queue.map((x) => x.ms), [15_000, 21_600_000])
  c.stop()
  await t.queue[1].fn()
  assert.deepEqual(t.queue.map((x) => x.ms), [15_000, 21_600_000], 'nothing is scheduled after stop')
})

test('a failure is told in the app\'s own sentence, or a plain one', () => {
  assert.equal(installFailure({ code: 'unreachable', message: 'The update could not be reached.' }), 'The update could not be reached.')
  assert.equal(installFailure('x'), 'The update could not be installed. Try again.')
  assert.equal(installFailure(null), 'The update could not be installed. Try again.')
})
