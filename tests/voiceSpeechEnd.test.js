import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { afterEach, beforeEach, mock } from 'node:test'

/**
 * When does a spoken reply count as finished? The REAL speech output module and the REAL orchestrator, with a
 * browser-like speech queue underneath (one utterance at a time, each taking a while) and the real input module
 * listening to a microphone that hears the assistant while it speaks.
 *
 * It exists because the assistant declared itself done the moment it began speaking: the end-of-speech promise
 * only knew about chunks already handed to the browser, and a reply is handed over a chunk at a time. Listening
 * then restarted over the top of its own voice, which it transcribed as the user.
 */

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@picovoice/')) {
    const stub = 'export const PorcupineWorker = {}; export const WebVoiceProcessor = {}'
    return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true }
  }
  return nextResolve(specifier, context)
}`),
  import.meta.url
)
const { createVoiceInputLocal } = await import('../src/interfaces/voice/voiceInputLocal.js')
const { createVoiceOrchestrator } = await import('../src/interfaces/voice/voiceOrchestrator.js')
const { createVoiceOutputSpeechSynthesis } = await import('../src/interfaces/voice/voiceOutputSpeechSynthesis.js')
const { createStateMachine } = await import('../src/assistant/stateMachine.js')
const { createAssistantController } = await import('../src/assistant/controller.js')

const UTTERANCE_MS = 1800
const ECHO = 0.12 // the assistant's own voice in the microphone while an utterance plays
const USER = 0.3

let nowMs, userLevel, echoLevel, recorders, sttCalls, requests, played, originals, speaking, failUtterance

class FakeAnalyser {
  constructor() {
    this.fftSize = 1024
  }
  getByteTimeDomainData(buffer) {
    const amplitude = Math.round(Math.max(userLevel, echoLevel) * 128)
    for (let i = 0; i < buffer.length; i++) buffer[i] = 128 + (i % 2 ? amplitude : -amplitude)
  }
}
class FakeAudioContext {
  constructor() {
    this.state = 'running'
  }
  async resume() {}
  async close() {}
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} }
  }
  createAnalyser() {
    return new FakeAnalyser()
  }
}
class FakeMediaRecorder {
  static isTypeSupported() {
    return true
  }
  constructor() {
    this.state = 'inactive'
    this.mimeType = 'audio/webm'
    recorders.push({ at: nowMs, whileSpeaking: speaking.length > 0 })
    this._index = recorders.length - 1
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    if (this.state !== 'recording') return
    this.state = 'inactive'
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(2000)]) })
      this.onstop?.()
    })
  }
}

/** A browser's speech queue: one utterance at a time, each UTTERANCE_MS long; cancel() drops everything. */
function installSpeechSynthesis() {
  const queue = []
  let current = null
  let timer = null
  function next() {
    current = queue.shift() ?? null
    if (!current) {
      echoLevel = 0
      return
    }
    if (failUtterance === queue.length + 1 + played.length) {
      // this utterance cannot be spoken: the browser reports an error and moves on to the next one
      const broken = current
      failUtterance = null
      broken.onerror?.({ error: 'synthesis-failed' })
      next()
      return
    }
    echoLevel = ECHO
    speaking.push(current.text)
    played.push({ text: current.text, startedAt: nowMs })
    current.onstart?.({})
    const utterance = current
    timer = setTimeout(() => {
      speaking.pop()
      played[played.length - 1].endedAt = nowMs
      utterance.onend?.({})
      next()
    }, UTTERANCE_MS)
  }
  globalThis.window.speechSynthesis = {
    getVoices: () => [{ name: 'x' }],
    speak(utterance) {
      queue.push(utterance)
      if (!current) next()
    },
    cancel() {
      clearTimeout(timer)
      const dropped = [current, ...queue].filter(Boolean)
      queue.length = 0
      current = null
      speaking.length = 0
      echoLevel = 0
      for (const utterance of dropped) utterance.onerror?.({ error: 'canceled' })
    }
  }
  globalThis.window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text
    }
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
async function advance(ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) {
    nowMs += 25
    mock.timers.tick(25)
    await flush()
  }
}

beforeEach(() => {
  nowMs = 1000
  userLevel = 0
  echoLevel = 0
  recorders = []
  sttCalls = 0
  requests = 0
  played = []
  speaking = []
  failUtterance = null
  originals = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  }
  mock.method(performance, 'now', () => nowMs)
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const stream = { active: true, getTracks: () => [{ stop() {} }] }
  globalThis.window = { AudioContext: FakeAudioContext, MediaRecorder: FakeMediaRecorder }
  installSpeechSynthesis()
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => stream } },
    configurable: true,
    writable: true
  })
  globalThis.fetch = async () => {
    sttCalls += 1
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: 'tell me three facts about cars' }) }
  }
})

afterEach(() => {
  mock.timers.reset()
  mock.restoreAll()
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

function app({ reply }) {
  const listeners = new Map()
  const eventBus = {
    on: (type, fn) => (listeners.set(type, fn), () => listeners.delete(type)),
    emit: (type, payload) => listeners.get(type)?.({ payload })
  }
  const stateMachine = createStateMachine('IDLE', { eventBus })
  const client = {
    getSessionId: () => 's1',
    createSession: async () => ({ sessionId: 's1' }),
    getState: async () => ({ state: 'IDLE' }),
    // the server round trip that precedes speech: not instant
    setState: async () => new Promise((resolve) => setTimeout(resolve, 120)),
    sendMessage: async () => ({ reply: 'fallback' }),
    streamMessage: async (message, { onEvent }) => {
      requests += 1
      for (const sentence of reply) onEvent({ event: 'token', data: { token: sentence + ' ' } })
      onEvent({ event: 'message', data: { reply: reply.join(' ') } })
      return { reply: reply.join(' ') }
    }
  }
  const assistantController = createAssistantController({ stateMachine, client, eventBus })
  const voiceInput = createVoiceInputLocal({})
  const voiceOutput = createVoiceOutputSpeechSynthesis()
  const orchestrator = createVoiceOrchestrator({
    stateMachine,
    assistantController,
    voiceInput,
    voiceOutput,
    deviceManager: {},
    ui: {},
    config: { audioMode: 'local', conversationMode: true },
    eventBus
  })
  return { api: orchestrator.init(), stateMachine }
}

const THREE_SENTENCES = [
  'The first car with a petrol engine was built in 1886.',
  'Most modern cars have four wheels and a steel body.',
  'Electric cars have fewer moving parts than petrol ones.'
]

/** Starts voice mode. The server round trip is a (mocked) timer, so the clock has to run while it is awaited. */
async function begin(a) {
  const started = a.api.startConversation()
  await advance(400)
  return started
}

async function userSpeaks() {
  userLevel = USER
  await advance(200)
  userLevel = 0
}

test('a reply of several sentences is spoken to the end before listening resumes', async () => {
  const a = app({ reply: THREE_SENTENCES })
  assert.deepEqual(await begin(a), { ok: true })
  await userSpeaks()
  await advance(2600) // silence: the utterance ends, is transcribed, the reply streams in and is spoken
  await advance(12000)
  assert.equal(requests, 1)
  assert.equal(played.length, 3, 'every sentence was spoken, not just the first')
  assert.ok(played.every((p) => p.endedAt), 'and each one ran to its end')
  assert.equal(a.stateMachine.getState(), 'LISTENING', 'listening is back at the end')
})

test('the assistant never listens over its own voice: no capture starts while any sentence is playing', async () => {
  const a = app({ reply: THREE_SENTENCES })
  await begin(a)
  await userSpeaks()
  await advance(2600)
  await advance(14000)
  assert.equal(played.length, 3)
  const duringSpeech = recorders.filter((r) => r.whileSpeaking)
  assert.equal(duringSpeech.length, 0, 'nothing was captured while the assistant was talking')
  assert.equal(sttCalls, 1, 'only the user\'s own utterance was ever sent for transcription')
})

test('the turn is not "listening" until the last sentence has ended', async () => {
  const a = app({ reply: THREE_SENTENCES })
  await begin(a)
  await userSpeaks()
  await advance(2600)
  let listeningWhileSpeaking = false
  for (let elapsed = 0; elapsed < 14000; elapsed += 25) {
    await advance(25)
    if (speaking.length > 0 && a.stateMachine.getState() === 'LISTENING') listeningWhileSpeaking = true
  }
  assert.equal(listeningWhileSpeaking, false)
})

test('after the whole reply the user is heard again, and a second turn works', async () => {
  const a = app({ reply: THREE_SENTENCES })
  await begin(a)
  await userSpeaks()
  await advance(2600)
  await advance(12000)
  assert.equal(a.stateMachine.getState(), 'LISTENING')
  await userSpeaks()
  await advance(2600)
  await advance(12000)
  assert.equal(requests, 2, 'the second utterance became a second turn')
  assert.equal(sttCalls, 2)
})

test('a one-sentence reply still works exactly as before', async () => {
  const a = app({ reply: ['It is exactly noon right now.'] })
  await begin(a)
  await userSpeaks()
  await advance(2600)
  await advance(6000)
  assert.equal(played.length, 1)
  assert.equal(a.stateMachine.getState(), 'LISTENING')
})

test('a sentence that cannot be spoken does not stop the rest of the reply, and the turn still ends cleanly', async () => {
  const a = app({ reply: THREE_SENTENCES })
  await begin(a)
  await userSpeaks()
  failUtterance = 3 // the first sentence of the reply fails in the browser (played is empty, queue holds none yet)
  await advance(2600)
  await silenced(() => advance(14000))
  assert.ok(played.length >= 2, 'the sentences after the failed one were spoken')
  assert.equal(recorders.filter((r) => r.whileSpeaking).length, 0, 'and nothing was captured while they played')
  assert.notEqual(a.stateMachine.getState(), 'SPEAKING', 'it did not stay stuck in speaking')
})

test('the user talking over the reply stops it, drops the rest, and what they say next is a new turn', async () => {
  const a = app({ reply: THREE_SENTENCES })
  await begin(a)
  await userSpeaks()
  await advance(2600)
  await advance(2000) // a little way into the second sentence, past the loudness measurement
  assert.ok(played.length >= 1, 'it is speaking')
  const interruptedAt = nowMs
  userLevel = USER // clearly louder than the assistant's own voice
  await advance(1400)
  assert.equal(speaking.length, 0, 'the speech was cut while the user was still talking')
  await advance(6000)
  userLevel = 0
  await advance(300)
  const finishedAfter = played.filter((p) => p.endedAt && p.endedAt > interruptedAt + 1500)
  assert.deepEqual(finishedAfter, [], 'no sentence ran on after the interruption')
  const startedLate = played.filter((p) => p.startedAt > interruptedAt + 1500)
  assert.deepEqual(startedLate, [], 'and none was started afterwards')
  assert.ok(
    recorders.some((r) => !r.whileSpeaking && r.at > interruptedAt),
    'what the user said after cutting it off was captured'
  )
  assert.equal(a.stateMachine.getState(), 'LISTENING')
})

async function silenced(fn) {
  const original = console.error
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.error = original
  }
}
