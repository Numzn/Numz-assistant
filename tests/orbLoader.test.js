import assert from 'node:assert/strict'
import test from 'node:test'
import { createOrbLoader, prefetchWhenIdle } from '../src/orb/orbLoader.js'

function fakeOrbModule() {
  const log = { imports: 0, created: [], frames: [] }
  return {
    log,
    importOrb: async () => {
      log.imports += 1
      return {
        createOrb: (options) => {
          log.created.push(options)
          return { frame: (elapsed, delta) => log.frames.push([elapsed, delta]) }
        }
      }
    }
  }
}

test('prefetch downloads the orb code and creates nothing: no WebGL context until voice mode', async () => {
  const { log, importOrb } = fakeOrbModule()
  const loader = createOrbLoader({ options: { canvas: 'c' }, importOrb })
  assert.equal(await loader.prefetch(), true)
  assert.equal(await loader.prefetch(), true)
  assert.equal(log.imports, 1, 'one download however often it is asked')
  assert.equal(log.created.length, 0)
  assert.equal(loader.isLoaded(), false)
})

test('load creates the orb once, even when called together, and reuses the prefetched code', async () => {
  const { log, importOrb } = fakeOrbModule()
  const loader = createOrbLoader({ options: { canvas: 'c' }, importOrb })
  await loader.prefetch()
  const [a, b] = await Promise.all([loader.load(), loader.load()])
  assert.equal(a, b)
  assert.equal(await loader.load(), a)
  assert.equal(log.imports, 1)
  assert.deepEqual(log.created, [{ canvas: 'c' }])
  assert.equal(loader.isLoaded(), true)
})

test('options given as a function are read when the orb is created, not when the loader is', async () => {
  const { log, importOrb } = fakeOrbModule()
  let level = 0
  const loader = createOrbLoader({ options: () => ({ level }), importOrb })
  level = 7
  await loader.load()
  assert.deepEqual(log.created, [{ level: 7 }])
})

test('frame does nothing until the orb exists and then draws through it', async () => {
  const { log, importOrb } = fakeOrbModule()
  const loader = createOrbLoader({ options: {}, importOrb })
  loader.frame(1, 0.016)
  assert.deepEqual(log.frames, [], 'safe to call every animation frame from the start')
  await loader.load()
  loader.frame(2, 0.016)
  assert.deepEqual(log.frames, [[2, 0.016]])
})

test('a download that fails is reported by load, ignored by prefetch, and tried again next time', async () => {
  let attempts = 0
  const { importOrb: working } = fakeOrbModule()
  const importOrb = async () => {
    attempts += 1
    if (attempts <= 2) throw new Error('chunk 404')
    return working()
  }
  const loader = createOrbLoader({ options: {}, importOrb })
  assert.equal(await loader.prefetch(), false, 'prefetch never throws')
  await assert.rejects(() => loader.load(), /chunk 404/)
  assert.equal(loader.isLoaded(), false)
  const orb = await loader.load()
  assert.ok(orb)
  assert.equal(attempts, 3)
})

test('an orb that cannot be created (no WebGL) rejects load, leaves frame harmless and can be retried', async () => {
  let fail = true
  const loader = createOrbLoader({
    options: {},
    importOrb: async () => ({
      createOrb: () => {
        if (fail) throw new Error('WebGL not available')
        return { frame() {} }
      }
    })
  })
  await assert.rejects(() => loader.load(), /WebGL/)
  assert.doesNotThrow(() => loader.frame(1, 0.016))
  fail = false
  assert.ok(await loader.load())
})

test('idle prefetch waits, and is skipped on data saver and on 2G', () => {
  const scheduled = []
  const schedule = (callback, delay) => scheduled.push([callback, delay])
  let prefetched = 0
  const prefetch = () => (prefetched += 1)

  assert.equal(prefetchWhenIdle(prefetch, { connection: { effectiveType: '4g' }, schedule, delayMs: 1500 }), true)
  assert.equal(prefetched, 0, 'nothing happens before the page has settled')
  assert.equal(scheduled[0][1], 1500)
  scheduled[0][0]()
  assert.equal(prefetched, 1)

  for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
    assert.equal(prefetchWhenIdle(prefetch, { connection, schedule }), false, JSON.stringify(connection))
  }
  assert.equal(scheduled.length, 1, 'those were never scheduled')
  assert.equal(prefetchWhenIdle(prefetch, { connection: undefined, schedule }), true, 'unknown connection: go ahead')
})
