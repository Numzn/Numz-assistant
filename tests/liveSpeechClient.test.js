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
  constructor({ sampleRate }) {
    this.sampleRate = sampleRate
    this.closed = false
    this.audioWorklet = { addModule: async () => {} }
    log.audioContexts.push(this)
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} }
  }
  async close() {
    this.closed = true
  }
}

class FakeAudioWorkletNode {
  constructor() {
    this.port = { onmessage: null, close() {} }
  }
  disconnect() {}
}

function install({ getUserMedia }) {
  log = { audioContexts: [], tracks: [] }
  FakeWebSocket.instances = []
  FakeWebSocket.autoOpen = true
  FakeWebSocket.replyToStop = true
  globalThis.window = { AudioContext: FakeAudioContext, AudioWorkletNode: FakeAudioWorkletNode, WebSocket: FakeWebSocket }
  globalThis.WebSocket = FakeWebSocket
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia } }, configurable: true, writable: true })
}

function grantedStream() {
  const track = { stopped: 0, stop() { this.stopped += 1 } }
  log.tracks.push(track)
  return { getTracks: () => [track] }
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
