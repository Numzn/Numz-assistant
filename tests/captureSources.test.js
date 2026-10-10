import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_MODES,
  acquireCapture,
  createSourceMonitor,
  isCaptureSupported,
  normalizeCaptureMode
} from '../src/interfaces/voice/captureSources.js'

function fakeTrack(kind = 'audio', { readyState = 'live' } = {}) {
  const listeners = new Map()
  const track = {
    kind,
    readyState,
    stopped: 0,
    stop() {
      this.stopped += 1
      this.readyState = 'ended'
    },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn))
    },
    /** The browser ends the track (device unplugged, "Stop sharing" pressed). */
    end() {
      this.readyState = 'ended'
      for (const fn of listeners.get('ended') ?? []) fn({ type: 'ended' })
    },
    listenerCount: () => [...listeners.values()].reduce((n, l) => n + l.length, 0)
  }
  return track
}
const fakeStream = (...tracks) => ({
  getTracks: () => tracks,
  getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  getVideoTracks: () => tracks.filter((t) => t.kind === 'video')
})
const domError = (name, message = name) => Object.assign(new Error(message), { name })

function devices({ mic, display } = {}) {
  const calls = []
  return {
    calls,
    getUserMedia: async (constraints) => {
      calls.push(['getUserMedia', constraints])
      if (mic instanceof Error) throw mic
      return mic ?? fakeStream(fakeTrack('audio'))
    },
    getDisplayMedia: async (constraints) => {
      calls.push(['getDisplayMedia', constraints])
      if (display instanceof Error) throw display
      return display ?? fakeStream(fakeTrack('video'), fakeTrack('audio'))
    }
  }
}

const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: false }

test('the three modes, and anything else is the microphone', () => {
  assert.deepEqual([...CAPTURE_MODES], ['microphone', 'tab', 'both'])
  assert.equal(normalizeCaptureMode('both'), 'both')
  assert.equal(normalizeCaptureMode('system'), 'microphone')
  assert.equal(normalizeCaptureMode(undefined), 'microphone')
})

test('support is per mode: sharing a tab needs getDisplayMedia, the microphone needs getUserMedia', () => {
  const none = {}
  assert.equal(isCaptureSupported('microphone', none).ok, false)
  assert.equal(isCaptureSupported('microphone', { getUserMedia() {} }).ok, true)
  assert.equal(isCaptureSupported('tab', { getUserMedia() {} }).ok, false)
  assert.match(isCaptureSupported('tab', { getUserMedia() {} }).reason, /share/i)
  assert.equal(isCaptureSupported('tab', { getDisplayMedia() {} }).ok, true)
  assert.equal(isCaptureSupported('both', { getUserMedia() {} }).ok, false)
  assert.equal(isCaptureSupported('both', { getUserMedia() {}, getDisplayMedia() {} }).ok, true)
})

test('microphone mode asks for the microphone only', async () => {
  const d = devices()
  const capture = await acquireCapture({ mode: 'microphone', mediaDevices: d, micConstraints: MIC })
  assert.deepEqual(d.calls.map((c) => c[0]), ['getUserMedia'])
  assert.deepEqual(d.calls[0][1], { audio: MIC, video: false })
  assert.deepEqual(capture.sources.map((s) => [s.id, s.state]), [['microphone', 'active']])
  assert.equal(capture.streams.length, 1)
})

test('tab mode asks the user to pick what to share, keeps only the audio, and turns the processing off', async () => {
  const d = devices()
  const capture = await acquireCapture({ mode: 'tab', mediaDevices: d, micConstraints: MIC })
  assert.deepEqual(d.calls.map((c) => c[0]), ['getDisplayMedia'])
  const asked = d.calls[0][1]
  assert.equal(asked.video, true, 'browsers will not offer audio sharing without a video request')
  assert.equal(asked.audio.echoCancellation, false, 'remote audio is not run through the microphone processing')
  assert.equal(asked.audio.noiseSuppression, false)
  assert.equal(asked.audio.autoGainControl, false)
  assert.deepEqual(capture.sources.map((s) => [s.id, s.state]), [['tab', 'active']])
  const [stream] = capture.streams
  assert.equal(stream.getVideoTracks().every((t) => t.stopped === 1), true, 'the picture is not kept')
  assert.equal(stream.getAudioTracks().every((t) => t.stopped === 0), true)
})

test('sharing without audio is refused and everything that was granted is released', async () => {
  const video = fakeTrack('video')
  const d = devices({ display: fakeStream(video) })
  await assert.rejects(
    () => acquireCapture({ mode: 'tab', mediaDevices: d, micConstraints: MIC }),
    (err) => err.code === 'display-capture-no-audio' && /Share audio/i.test(err.message)
  )
  assert.equal(video.stopped, 1)
})

test('a cancelled or blocked picker is its own error, not "the microphone is blocked"', async () => {
  const d = devices({ display: domError('NotAllowedError', 'Permission denied') })
  await assert.rejects(
    () => acquireCapture({ mode: 'tab', mediaDevices: d, micConstraints: MIC }),
    (err) => err.code === 'display-capture-failed' && err.name !== 'NotAllowedError' && err.cause?.name === 'NotAllowedError'
  )
})

test('both: the picker is asked first (it needs the click), then the microphone, and both are used', async () => {
  const d = devices()
  const capture = await acquireCapture({ mode: 'both', mediaDevices: d, micConstraints: MIC })
  assert.deepEqual(d.calls.map((c) => c[0]), ['getDisplayMedia', 'getUserMedia'])
  assert.deepEqual(capture.sources.map((s) => [s.id, s.state]), [['microphone', 'active'], ['tab', 'active']])
  assert.equal(capture.streams.length, 2)
})

test('both: if sharing is cancelled the microphone carries on and the tab is reported as not recorded', async () => {
  const d = devices({ display: domError('NotAllowedError') })
  const capture = await acquireCapture({ mode: 'both', mediaDevices: d, micConstraints: MIC })
  const byId = Object.fromEntries(capture.sources.map((s) => [s.id, s]))
  assert.equal(byId.microphone.state, 'active')
  assert.equal(byId.tab.state, 'unavailable')
  assert.match(byId.tab.detail, /cancelled|blocked/i)
  assert.equal(capture.streams.length, 1)
})

test('both: if the microphone is blocked the shared audio carries on and the microphone is reported', async () => {
  const d = devices({ mic: domError('NotAllowedError') })
  const capture = await acquireCapture({ mode: 'both', mediaDevices: d, micConstraints: MIC })
  const byId = Object.fromEntries(capture.sources.map((s) => [s.id, s]))
  assert.equal(byId.microphone.state, 'unavailable')
  assert.equal(byId.tab.state, 'active')
  assert.equal(capture.streams.length, 1)
})

test('both: with nothing usable it fails with the microphone error, and releases what it had', async () => {
  const video = fakeTrack('video')
  const d = devices({ mic: domError('NotFoundError'), display: fakeStream(video) }) // shared, but no audio in it
  await assert.rejects(
    () => acquireCapture({ mode: 'both', mediaDevices: d, micConstraints: MIC }),
    (err) => err.name === 'NotFoundError'
  )
  assert.equal(video.stopped, 1)
})

test('microphone mode keeps the browser error as it is, so the caller can tell blocked from missing', async () => {
  const d = devices({ mic: domError('NotFoundError') })
  await assert.rejects(
    () => acquireCapture({ mode: 'microphone', mediaDevices: d, micConstraints: MIC }),
    (err) => err.name === 'NotFoundError'
  )
})

test('a track that is already ended when it arrives is unavailable, not active', async () => {
  const dead = fakeTrack('audio', { readyState: 'ended' })
  const d = devices({ mic: fakeStream(dead) })
  await assert.rejects(
    () => acquireCapture({ mode: 'microphone', mediaDevices: d, micConstraints: MIC }),
    (err) => err.code === 'capture-unavailable'
  )
})

test('a track that ends later is reported with its source id, and release stops everything once', async () => {
  const micTrack = fakeTrack('audio')
  const tabAudio = fakeTrack('audio')
  const tabVideo = fakeTrack('video')
  const d = devices({ mic: fakeStream(micTrack), display: fakeStream(tabVideo, tabAudio) })
  const ended = []
  const capture = await acquireCapture({ mode: 'both', mediaDevices: d, micConstraints: MIC, onSourceEnded: (id) => ended.push(id) })

  tabAudio.end()
  assert.deepEqual(ended, ['tab'])

  capture.release()
  capture.release() // deterministic cleanup: a second call changes nothing
  assert.equal(micTrack.stopped, 1)
  assert.equal(micTrack.listenerCount(), 0, 'no listener is left on a released track')
  micTrack.end()
  assert.deepEqual(ended, ['tab'], 'nothing is reported after release')
})

// ---- the monitor ------------------------------------------------------------------------------------------

function monitor(options = {}) {
  const changes = []
  let t = 0
  const m = createSourceMonitor({
    sources: [
      { id: 'microphone', label: 'Microphone', state: 'active' },
      { id: 'tab', label: 'Tab audio', state: 'active' }
    ],
    noSignalAfterMs: 8000,
    quietAfterMs: 20000,
    now: () => t,
    onChange: (snapshot) => changes.push(snapshot.map((s) => `${s.id}:${s.state}`).join(',')),
    ...options
  })
  return { m, changes, at: (ms) => (t = ms) }
}

test('a source that never carried any sound is flagged, and cleared the moment sound arrives', () => {
  const { m, changes, at } = monitor()
  at(5000)
  m.reportLevel('microphone', 0)
  assert.equal(m.snapshot()[0].state, 'active', 'too early to say')
  at(9000)
  m.reportLevel('microphone', 0)
  assert.equal(m.snapshot()[0].state, 'no-signal')
  at(9500)
  m.reportLevel('microphone', 0.05)
  assert.equal(m.snapshot()[0].state, 'active')
  assert.deepEqual(changes, ['microphone:no-signal,tab:active', 'microphone:active,tab:active'])
})

test('a source that went quiet after having sound is "quiet", not "no signal"', () => {
  const { m, at } = monitor()
  at(1000)
  m.reportLevel('tab', 0.2)
  at(30000)
  m.reportLevel('tab', 0)
  assert.equal(m.snapshot()[1].state, 'quiet')
})

test('ended is final, is reported once, and later sound does not revive it', () => {
  const { m, changes } = monitor()
  m.markEnded('tab')
  m.markEnded('tab')
  m.reportLevel('tab', 0.5)
  assert.equal(m.snapshot()[1].state, 'ended')
  assert.equal(changes.length, 1)
})

test('anyLive is false only when every source has ended or never existed', () => {
  const { m } = monitor()
  assert.equal(m.anyLive(), true)
  m.markEnded('microphone')
  assert.equal(m.anyLive(), true)
  m.markEnded('tab')
  assert.equal(m.anyLive(), false)
})

test('unavailable sources are listed but never count as live and are not changed by levels', () => {
  const { m } = monitor({
    sources: [
      { id: 'microphone', label: 'Microphone', state: 'active' },
      { id: 'tab', label: 'Tab audio', state: 'unavailable', detail: 'Sharing was cancelled.' }
    ]
  })
  m.reportLevel('tab', 0.4)
  assert.equal(m.snapshot()[1].state, 'unavailable')
  assert.equal(m.snapshot()[1].detail, 'Sharing was cancelled.')
  m.markEnded('microphone')
  assert.equal(m.anyLive(), false)
})
