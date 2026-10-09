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
