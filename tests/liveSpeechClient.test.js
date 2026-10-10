import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { createLiveSpeechClient, isLiveSpeechSupported } from '../src/interfaces/voice/liveSpeechClient.js'

/**
 * The live client against fake browser APIs: what it offers the WebSocket, what it sends first, and that a
 * stop() while start() is still waiting (permission prompt, socket opening) leaves nothing running.
 */

let originals
let log

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

class FakeWebSocket {
  static OPEN = 1
  static bufferedAmount = 0 // what a stalled network looks like
  static instances = []
  static autoOpen = true
  static replyToStop = true // answer 'stop' with 'stopped', as the speech service does when it is done
  constructor(url, protocols) {
    this.url = url
    this.protocols = protocols
    this.sent = []
    this.closed = false
    this.readyState = 0
    this.listeners = {}
    Object.defineProperty(this, 'bufferedAmount', { get: () => FakeWebSocket.bufferedAmount })
    FakeWebSocket.instances.push(this)
    if (FakeWebSocket.autoOpen) queueMicrotask(() => this.open())
  }
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
  }
  emit(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  send(data) {
    this.sent.push(data)
    if (FakeWebSocket.replyToStop && typeof data === 'string' && JSON.parse(data).type === 'stop') {
      queueMicrotask(() => this.serverSays({ type: 'stopped', transcript: null }))
    }
  }
  serverSays(message) {
    this.emit('message', { data: JSON.stringify(message) })
  }
  serverCloses() {
    this.readyState = 3
    this.emit('close')
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
}

class FakeAudioContext {
  static initialState = undefined // undefined: a context with no state at all (as the older fakes were)
  static resumeBehaviour = 'works' // works | never (the promise stays pending) | stays-suspended
  static level = 0.1 // what the analysers see
  constructor({ sampleRate }) {
    this.sampleRate = sampleRate
    this.closed = false
    this.resumeCalls = 0
    if (FakeAudioContext.initialState) this.state = FakeAudioContext.initialState
    this.audioWorklet = { addModule: async () => {} }
    log.audioContexts.push(this)
  }
  createMediaStreamSource(stream) {
    const node = { stream, connectedTo: [], connect(target) { this.connectedTo.push(target) }, disconnect() {} }
    log.sourceNodes.push(node)
    return node
  }
  createGain() {
    const node = { gain: { value: 1 }, connectedTo: [], connect(target) { this.connectedTo.push(target) }, disconnect() {} }
    log.gainNodes.push(node)
    return node
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      getFloatTimeDomainData(buffer) {
        buffer.fill(FakeAudioContext.level)
      },
      connect() {},
      disconnect() {}
    }
  }
  async close() {
    this.closed = true
  }
  resume() {
    this.resumeCalls += 1
    const behaviour = FakeAudioContext.resumeBehaviour
    if (behaviour === 'never') return new Promise(() => {})
    if (behaviour === 'works') this.state = 'running'
    return Promise.resolve()
  }
}

class FakeAudioWorkletNode {
  constructor() {
    this.port = { onmessage: null, close() {} }
    log.worklets.push(this)
  }
  disconnect() {}
}

function install({ getUserMedia, getDisplayMedia }) {
  log = { audioContexts: [], tracks: [], sourceNodes: [], gainNodes: [], worklets: [] }
  FakeWebSocket.instances = []
  FakeWebSocket.bufferedAmount = 0
  FakeAudioContext.level = 0.1
  FakeWebSocket.autoOpen = true
  FakeWebSocket.replyToStop = true
  FakeAudioContext.initialState = undefined
  FakeAudioContext.resumeBehaviour = 'works'
  globalThis.window = { AudioContext: FakeAudioContext, AudioWorkletNode: FakeAudioWorkletNode, WebSocket: FakeWebSocket }
  globalThis.WebSocket = FakeWebSocket
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia, ...(getDisplayMedia ? { getDisplayMedia } : {}) } },
    configurable: true,
    writable: true
  })
}

/** An audio track as a browser makes one: live until stopped or ended, and it tells its listeners when it ends. */
function audioTrack() {
  const listeners = []
  return {
    kind: 'audio',
    readyState: 'live',
    stopped: 0,
    stop() {
      this.stopped += 1
      this.readyState = 'ended'
    },
    addEventListener(type, fn) {
      if (type === 'ended') listeners.push(fn)
    },
    removeEventListener(type, fn) {
      const index = listeners.indexOf(fn)
      if (index !== -1) listeners.splice(index, 1)
    },
    end() {
      this.readyState = 'ended'
      for (const fn of [...listeners]) fn({ type: 'ended' })
    }
  }
}

function grantedStream() {
  const track = audioTrack()
  log.tracks.push(track)
  return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] }
}

/** What getDisplayMedia hands back: a picture track (to be dropped) and, if the person ticked it, audio. */
function sharedStream({ withAudio = true } = {}) {
  const video = { kind: 'video', readyState: 'live', stopped: 0, stop() { this.stopped += 1; this.readyState = 'ended' } }
  const audio = withAudio ? audioTrack() : null
  log.tracks.push(...(audio ? [audio] : []))
  const tracks = audio ? [video, audio] : [video]
  return {
    video,
    audio,
    getTracks: () => tracks,
    getAudioTracks: () => (audio ? [audio] : []),
    getVideoTracks: () => [video]
  }
}

beforeEach(() => {
  originals = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    WebSocket: Object.getOwnPropertyDescriptor(globalThis, 'WebSocket'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  }
})

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('with a meeting, the socket is opened with the ticket subprotocols and the first message is a start for that meeting', async () => {
  install({ getUserMedia: async () => grantedStream() })
  const client = createLiveSpeechClient({
    wsUrl: 'wss://example.test/api/v1/live-speech',
    meetingId: 'm-1',
    meetingTicket: 'tok.sig',
    wsProtocols: ['numz.meeting-ticket.v1', 'tok.sig']
  })
  await client.start()
  const [socket] = FakeWebSocket.instances
  assert.equal(socket.url, 'wss://example.test/api/v1/live-speech')
  assert.deepEqual(socket.protocols, ['numz.meeting-ticket.v1', 'tok.sig'])
  const first = JSON.parse(socket.sent[0])
  assert.equal(first.type, 'start')
  assert.equal(first.meetingId, 'm-1')
  assert.equal(first.meetingTicket, 'tok.sig')
  assert.equal(first.format, 'f32le')
  assert.equal(first.sampleRate, 16000)
  await client.stop()
})

test('the start message does not ask the server to save the audio unless it was told to', async () => {
  install({ getUserMedia: async () => grantedStream() })
  const plain = createLiveSpeechClient({ wsUrl: 'ws://localhost:8765/live-speech' })
  await plain.start()
  assert.equal(JSON.parse(FakeWebSocket.instances[0].sent[0]).saveRecording, false)
  await plain.stop()

  const asked = createLiveSpeechClient({ wsUrl: 'ws://localhost:8765/live-speech', saveRecording: true })
  await asked.start()
  assert.equal(JSON.parse(FakeWebSocket.instances[1].sent[0]).saveRecording, true)
  await asked.stop()
})

test('without protocols the socket is opened exactly as before', async () => {
  install({ getUserMedia: async () => grantedStream() })
  const client = createLiveSpeechClient({ wsUrl: 'ws://localhost:8765/live-speech' })
  await client.start()
  assert.equal(FakeWebSocket.instances[0].protocols, undefined)
  const first = JSON.parse(FakeWebSocket.instances[0].sent[0])
  assert.equal(Object.hasOwn(first, 'meetingId'), false, 'a standalone start names no meeting')
  await client.stop()
})

test('stop() while the permission prompt is open: when it is answered, the microphone is released and nothing connects', async () => {
  const prompt = deferred()
  install({ getUserMedia: () => prompt.promise })
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech' })

  const starting = client.start()
  await client.stop() // pressed "Stop" while the browser was still asking
  prompt.resolve(grantedStream()) // the person finally allows it
  await starting

  assert.equal(log.tracks[0].stopped, 1, 'the microphone that was just granted is released')
  assert.equal(FakeWebSocket.instances.length, 0, 'no connection is opened for a cancelled start')
  assert.equal(log.audioContexts.length, 0)
})

test('stop() while the socket is still opening: everything is released once it opens', async () => {
  install({ getUserMedia: async () => grantedStream() })
  FakeWebSocket.autoOpen = false
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech' })

  const starting = client.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const [socket] = FakeWebSocket.instances
  assert.ok(socket, 'the socket was created and is waiting to open')
  await client.stop()
  socket.open()
  await starting

  assert.equal(socket.closed, true)
  assert.equal(log.tracks[0].stopped >= 1, true, 'the microphone is released')
  assert.equal(log.audioContexts[0].closed, true)
  assert.equal(socket.sent.length, 0, 'no start message goes out for a cancelled start')
})

test('support check: needs getUserMedia, AudioContext, AudioWorkletNode and WebSocket', () => {
  install({ getUserMedia: async () => grantedStream() })
  assert.equal(isLiveSpeechSupported(), true)
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })
  assert.equal(isLiveSpeechSupported(), false, 'no microphone API (an insecure page)')
})

test('stop() waits for the speech service to say it is finished before hanging up', async () => {
  install({ getUserMedia: async () => grantedStream() })
  FakeWebSocket.replyToStop = false
  let stoppedSummary = null
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech' })
  client.setOnStopped((transcript) => (stoppedSummary = transcript ?? 'received'))
  await client.start()
  const [socket] = FakeWebSocket.instances

  let finished = false
  const stopping = client.stop().then(() => (finished = true))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(JSON.parse(socket.sent.at(-1)).type, 'stop')
  assert.equal(log.tracks[0].stopped, 1, 'the microphone is released first: no audio follows the stop')
  assert.equal(finished, false, 'still waiting: the service has not finished its last lines')
  assert.equal(socket.closed, false, 'the connection stays open while it works')

  socket.serverSays({ type: 'stopped', transcript: { segments: [] } })
  await stopping
  assert.equal(finished, true)
  assert.equal(socket.closed, true)
  assert.ok(stoppedSummary, 'the summary is delivered, not dropped')
})

test('stop() also finishes when the server closes the connection', async () => {
  install({ getUserMedia: async () => grantedStream() })
  FakeWebSocket.replyToStop = false
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech' })
  await client.start()
  const stopping = client.stop()
  await new Promise((resolve) => setTimeout(resolve, 10))
  FakeWebSocket.instances[0].serverCloses()
  await stopping
})

test('stop() gives up after its timeout if the service never answers', async () => {
  install({ getUserMedia: async () => grantedStream() })
  FakeWebSocket.replyToStop = false
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', stopTimeoutMs: 40 })
  await client.start()
  const started = Date.now()
  await client.stop()
  assert.ok(Date.now() - started >= 35, 'it waited for the timeout')
  assert.equal(FakeWebSocket.instances[0].closed, true)
})

test('meetings can ask for automatic gain control; by default the shared constraints apply', async () => {
  const asked = []
  install({ getUserMedia: async (constraints) => (asked.push(constraints.audio), grantedStream()) })
  const meeting = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', autoGainControl: true, language: 'en-US' })
  await meeting.start()
  assert.equal(asked[0].autoGainControl, true)
  assert.equal(JSON.parse(FakeWebSocket.instances[0].sent[0]).language, 'en-US', 'the language is sent with start')
  await meeting.stop()

  const plain = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech' })
  await plain.start()
  assert.equal(asked[1].autoGainControl, false)
  await plain.stop()
})

test('a server error frame reaches the caller with its code, so the caller can tell a survivable problem from a fatal one', async () => {
  install({ getUserMedia: async () => grantedStream() })
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech' })
  const seen = []
  client.setOnError((err) => seen.push(err))
  await client.start()
  const [socket] = FakeWebSocket.instances
  socket.serverSays({ type: 'error', code: 'persistence-failure', message: 'not saved yet', segmentId: 'seg_9' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].code, 'persistence-failure')
  assert.equal(seen[0].segmentId, 'seg_9')
  assert.match(seen[0].message, /\[persistence-failure\]/)
  await client.stop()
})

test('an audio context the browser left suspended is resumed before any audio is relied on', async () => {
  install({ getUserMedia: async () => grantedStream() })
  FakeAudioContext.initialState = 'suspended'
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech' })
  await client.start()
  assert.equal(log.audioContexts[0].resumeCalls, 1)
  assert.equal(log.audioContexts[0].state, 'running')
  assert.equal(FakeWebSocket.instances.length, 1)
  await client.stop()
})

test('an audio context that is already running is left alone', async () => {
  install({ getUserMedia: async () => grantedStream() })
  FakeAudioContext.initialState = 'running'
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech' })
  await client.start()
  assert.equal(log.audioContexts[0].resumeCalls, 0)
  await client.stop()
})

test('audio the browser will not start without a user gesture fails loudly instead of recording silence', async () => {
  install({ getUserMedia: async () => grantedStream() })
  FakeAudioContext.initialState = 'suspended'
  FakeAudioContext.resumeBehaviour = 'never'
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', resumeTimeoutMs: 20 })
  const reported = []
  client.setOnError((err) => reported.push(err))
  await assert.rejects(() => client.start(), (err) => err.code === 'audio-context-suspended')
  assert.equal(reported.length, 1)
  assert.equal(reported[0].code, 'audio-context-suspended')
  assert.equal(log.tracks[0].stopped, 1, 'the microphone is released')
  assert.equal(log.audioContexts[0].closed, true)
  assert.equal(FakeWebSocket.instances.length, 0, 'no connection to the speech service is made for audio that cannot flow')
})

test('a context that resumes but stays suspended is refused the same way', async () => {
  install({ getUserMedia: async () => grantedStream() })
  FakeAudioContext.initialState = 'suspended'
  FakeAudioContext.resumeBehaviour = 'stays-suspended'
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', resumeTimeoutMs: 20 })
  client.setOnError(() => {})
  await assert.rejects(() => client.start(), (err) => err.code === 'audio-context-suspended')
})

// ---- capture sources ------------------------------------------------------------------------------------

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test('tab mode records the shared tab\'s audio only, drops the picture, and never touches the microphone', async () => {
  const shared = (() => {
    install({ getUserMedia: async () => { throw new Error('the microphone must not be asked for') }, getDisplayMedia: async () => shared.stream })
    return { stream: sharedStream() }
  })()
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', captureMode: 'tab' })
  const seen = []
  client.setOnSources((list) => seen.push(list))
  await client.start()
  assert.equal(shared.stream.video.stopped, 1)
  assert.deepEqual(seen[0].map((s) => [s.id, s.state]), [['tab', 'active']])
  assert.equal(log.sourceNodes.length, 1)
  assert.equal(log.gainNodes.length, 0, 'one source needs no mixer')
  await client.stop()
  assert.equal(shared.stream.audio.stopped, 1, 'the shared audio is released on stop')
})

test('both: the two sources are mixed into the one recording stream, with headroom', async () => {
  const state = { shared: null }
  install({
    getUserMedia: async () => grantedStream(),
    getDisplayMedia: async () => (state.shared = sharedStream())
  })
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', captureMode: 'both' })
  const seen = []
  client.setOnSources((list) => seen.push(list))
  await client.start()
  assert.deepEqual(seen[0].map((s) => [s.id, s.state]), [['microphone', 'active'], ['tab', 'active']])
  assert.equal(log.sourceNodes.length, 2)
  assert.equal(log.gainNodes.length, 1)
  assert.ok(log.gainNodes[0].gain.value < 1 && log.gainNodes[0].gain.value > 0.5, 'two sources are summed with headroom')
  assert.equal(log.gainNodes[0].connectedTo[0], log.worklets[0], 'the mix goes to the recorder')
  assert.ok(log.sourceNodes.every((node) => node.connectedTo.includes(log.gainNodes[0])))
  await client.stop()
  assert.ok(log.tracks.every((track) => track.stopped >= 1), 'every track of every source is released')
})

test('both: a refused share does not stop the recording, and the refusal is reported', async () => {
  install({
    getUserMedia: async () => grantedStream(),
    getDisplayMedia: async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    }
  })
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', captureMode: 'both' })
  const seen = []
  client.setOnSources((list) => seen.push(list))
  await client.start()
  const byId = Object.fromEntries(seen[0].map((s) => [s.id, s]))
  assert.equal(byId.microphone.state, 'active')
  assert.equal(byId.tab.state, 'unavailable')
  assert.ok(byId.tab.detail)
  assert.equal(FakeWebSocket.instances.length, 1)
  await client.stop()
})

test('one source ending is reported and the recording carries on; the last one ending is an error', async () => {
  let shared
  let mic
  install({
    getUserMedia: async () => {
      const stream = grantedStream()
      mic = stream.getAudioTracks()[0]
      return stream
    },
    getDisplayMedia: async () => (shared = sharedStream())
  })
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', captureMode: 'both' })
  const lists = []
  const errors = []
  client.setOnSources((list) => lists.push(list))
  client.setOnError((err) => errors.push(err))
  await client.start()

  shared.audio.end() // "Stop sharing"
  assert.equal(lists.at(-1).find((s) => s.id === 'tab').state, 'ended')
  assert.equal(errors.length, 0, 'the microphone is still recording')

  mic.end() // and then the microphone is unplugged
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'capture-ended')
  await client.stop()
})

test('a microphone that is silent from the start is flagged instead of looking like a quiet meeting', async () => {
  install({ getUserMedia: async () => grantedStream() })
  FakeAudioContext.level = 0
  const client = createLiveSpeechClient({
    wsUrl: 'ws://x/live-speech',
    monitorIntervalMs: 5,
    sourceTiming: { noSignalAfterMs: 20, quietAfterMs: 1000 }
  })
  const lists = []
  client.setOnSources((list) => lists.push(list))
  await client.start()
  await settle(60)
  assert.equal(lists.at(-1)[0].state, 'no-signal')
  FakeAudioContext.level = 0.2
  await settle(30)
  assert.equal(lists.at(-1)[0].state, 'active', 'and cleared as soon as sound arrives')
  await client.stop()
})

test('the level meter stops with the recording: nothing is left running after stop', async () => {
  install({ getUserMedia: async () => grantedStream() })
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', monitorIntervalMs: 5 })
  const lists = []
  client.setOnSources((list) => lists.push(list))
  await client.start()
  await client.stop()
  const countAtStop = lists.length
  FakeAudioContext.level = 0
  await settle(60)
  assert.equal(lists.length, countAtStop)
})

test('audio is sent while the connection keeps up, dropped and counted once its backlog passes the bound', async () => {
  install({ getUserMedia: async () => grantedStream() })
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', maxBufferedBytes: 1000 })
  const dropped = []
  client.setOnDropped((info) => dropped.push(info))
  await client.start()
  const [socket] = FakeWebSocket.instances
  const [worklet] = log.worklets
  const frame = new ArrayBuffer(6400)
  const framesSent = () => socket.sent.filter((m) => typeof m !== 'string').length

  worklet.port.onmessage({ data: frame })
  assert.equal(framesSent(), 1)

  FakeWebSocket.bufferedAmount = 5000 // the network has stalled
  worklet.port.onmessage({ data: frame })
  worklet.port.onmessage({ data: frame })
  assert.equal(framesSent(), 1, 'nothing more is queued behind a stalled connection')
  assert.equal(dropped.length, 1, 'the first dropped frame is reported at once, not every one after it')
  assert.equal(dropped[0].frames, 1)
  assert.ok(Math.abs(dropped[0].seconds - 0.1) < 1e-9)
  for (let i = 0; i < 98; i++) worklet.port.onmessage({ data: frame })
  assert.equal(dropped.length, 2, 'and again after every ten seconds of dropped audio')
  assert.equal(dropped[1].frames, 100)
  assert.ok(Math.abs(dropped[1].seconds - 10) < 1e-6)

  FakeWebSocket.bufferedAmount = 0
  worklet.port.onmessage({ data: frame })
  assert.equal(framesSent(), 2, 'and it carries on when the backlog clears')
  await client.stop()
})

test('a mode this browser cannot offer fails before anything is granted', async () => {
  install({ getUserMedia: async () => grantedStream() }) // no getDisplayMedia
  const client = createLiveSpeechClient({ wsUrl: 'ws://x/live-speech', captureMode: 'tab' })
  client.setOnError(() => {})
  await assert.rejects(() => client.start(), (err) => err.code === 'capture-unsupported')
  assert.equal(log.tracks.length, 0)
  assert.equal(FakeWebSocket.instances.length, 0)
})
