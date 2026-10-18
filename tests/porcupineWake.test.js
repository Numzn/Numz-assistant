import assert from 'node:assert/strict'
import test from 'node:test'
import { createPorcupineWake } from '../src/interfaces/voice/porcupineWake.js'

/** A stand-in for the Picovoice SDK that records every call. */
function fakeSdk() {
  const calls = { create: [], subscribe: [], unsubscribe: [], reset: 0, terminate: 0 }
  let onKeyword = null
  const engine = { terminate: () => (calls.terminate += 1) }
  return {
    calls,
    detectWake: () => onKeyword?.(),
    sdk: {
      PorcupineWorker: {
        create: async (...args) => {
          calls.create.push(args)
          onKeyword = args[2]
          return engine
        }
      },
      WebVoiceProcessor: {
        subscribe: async (e) => calls.subscribe.push(e),
        unsubscribe: async (e) => calls.unsubscribe.push(e),
        reset: async () => (calls.reset += 1)
      }
    },
    engine
  }
}

/** Browsers have a global Worker; Node does not. isSupported() needs one. */
async function withWorkerGlobal(fn) {
  const had = Object.hasOwn(globalThis, 'Worker')
  const saved = globalThis.Worker
  globalThis.Worker = class {}
  try {
    await fn()
  } finally {
    if (had) globalThis.Worker = saved
    else delete globalThis.Worker
  }
}

const CONFIG = { accessKey: 'key', keywordPublicPath: '/porcupine/numz.ppn' }

test('creating the wrapper and asking what it supports never loads the SDK', async () => {
  await withWorkerGlobal(async () => {
    let loads = 0
    const wake = createPorcupineWake({ ...CONFIG, loadSdk: async () => (loads += 1) })
    assert.equal(wake.isConfigured(), true)
    assert.equal(wake.isSupported(), true)
    assert.equal(loads, 0)
  })
})

test('without an access key it is not supported and arming loads nothing at all', async () => {
  await withWorkerGlobal(async () => {
    let loads = 0
    const wake = createPorcupineWake({ keywordPublicPath: '/x.ppn', loadSdk: async () => (loads += 1) })
    assert.equal(wake.isConfigured(), false)
    assert.equal(wake.isSupported(), false)
    assert.equal(await wake.arm(), false)
    assert.equal(loads, 0, 'production has no key, so the 1.1 MB SDK is never fetched there')
  })
})

test('arming loads the SDK once, even for concurrent calls, and subscribes the engine once', async () => {
  await withWorkerGlobal(async () => {
    const { sdk, calls, engine } = fakeSdk()
    let loads = 0
    const wake = createPorcupineWake({
      ...CONFIG,
      keywordLabel: 'numz',
      loadSdk: async () => {
        loads += 1
        return sdk
      }
    })
    const results = await Promise.all([wake.arm(), wake.arm()])
    assert.deepEqual(results, [true, true])
    assert.equal(await wake.arm(), true)
    assert.equal(loads, 1)
    assert.equal(calls.create.length, 1, 'one engine')
    const [key, keywords, , model] = calls.create[0]
    assert.equal(key, 'key')
    assert.deepEqual(keywords, [{ publicPath: '/porcupine/numz.ppn', label: 'numz', sensitivity: 0.55 }])
    assert.deepEqual(model, { publicPath: '/porcupine/porcupine_params_en.pv', customWritePath: 'porcupine_model' })
    assert.deepEqual(calls.subscribe, [engine], 'subscribed once')
  })
})

test('a failed SDK load is reported, not remembered: the next arm tries again', async () => {
  await withWorkerGlobal(async () => {
    const { sdk } = fakeSdk()
    let attempts = 0
    const wake = createPorcupineWake({
      ...CONFIG,
      loadSdk: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('chunk 404')
        return sdk
      }
    })
    await assert.rejects(() => wake.arm(), /chunk 404/)
    assert.equal(await wake.arm(), true)
    assert.equal(attempts, 2)
  })
})

test('stopping, pausing and releasing a wake word that was never armed loads nothing', async () => {
  await withWorkerGlobal(async () => {
    let loads = 0
    const wake = createPorcupineWake({ ...CONFIG, loadSdk: async () => (loads += 1) })
    await wake.disarm()
    await wake.pause()
    await wake.resume()
    await wake.release()
    assert.equal(loads, 0)
  })
})

test('once armed, pause, disarm and release reach the SDK; a detected word calls onWake (debounced, not while paused)', async () => {
  await withWorkerGlobal(async () => {
    const { sdk, calls, engine, detectWake } = fakeSdk()
    const heard = []
    const wake = createPorcupineWake({ ...CONFIG, wakeDebounceMs: 60_000, onWake: (event) => heard.push(event.keyword), loadSdk: async () => sdk })
    await wake.arm()
    detectWake()
    detectWake()
    assert.equal(heard.length, 1, 'the second detection falls inside the debounce window')
    await wake.pause()
    assert.equal(calls.reset, 1)
    await wake.release()
    assert.deepEqual(calls.unsubscribe, [engine])
    assert.equal(calls.terminate, 1)
  })
})

test('a missing keyword file is still a clear error and creates no engine', async () => {
  await withWorkerGlobal(async () => {
    const { sdk, calls } = fakeSdk()
    const wake = createPorcupineWake({ accessKey: 'key', loadSdk: async () => sdk })
    await assert.rejects(() => wake.arm(), /KEYWORD_PUBLIC_PATH/)
    assert.equal(calls.create.length, 0)
  })
})
