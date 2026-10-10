import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { afterEach, beforeEach, mock } from 'node:test'

/**
 * The hands-free microphone loop (voiceInputLocal.js) against fake browser APIs, a fake clock and a microphone
 * level the test controls. It exists for the assistant hearing ITSELF: its own voice leaves the speakers, reaches
 * the microphone, and was being taken for the user, either as an interruption or as a new command.
 *
 * What this proves: the state machine, thresholds and lifecycle ordering. What it cannot prove: how loud a real
 * laptop's speakers are in its own microphone, or how well the browser cancels them. That needs a real browser
 * and microphone (see the manual test in the pull request notes).
 */

// The Picovoice packages are browser-only builds that Node cannot resolve; the wake word is not under test.
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
const { speechAudioConstraints } = await import('../src/interfaces/voice/micUtils.js')

// ---- fake browser -----------------------------------------------------------------------------------------

let nowMs
let level // the RMS the analyser reports, 0..1
let recorders
let sttCalls
let sttHold // when set, the STT request waits for it
let originals
let requestedAudio // the constraints the input asked the browser for, one entry per getUserMedia call

class FakeAnalyser {
  constructor() {
    this.fftSize = 1024
  }
  getByteTimeDomainData(buffer) {
    const amplitude = Math.round(level * 128)
    for (let i = 0; i < buffer.length; i++) buffer[i] = 128 + (i % 2 ? amplitude : -amplitude)
  }
  connect() {}
  disconnect() {}
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
    recorders.push(this)
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

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Moves the fake clock and its timers forward in 25 ms steps, letting promises settle after each step. */
async function advance(ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) {
    nowMs += 25
    mock.timers.tick(25)
    await flush()
  }
}

beforeEach(() => {
  nowMs = 1000
  level = 0
  recorders = []
  sttCalls = []
  requestedAudio = []
  sttHold = null
  originals = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  }
  mock.method(performance, 'now', () => nowMs)
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })

  const track = { stop() {} }
  const stream = { active: true, getTracks: () => [track] }
  globalThis.window = { AudioContext: FakeAudioContext, MediaRecorder: FakeMediaRecorder }
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          requestedAudio.push(constraints?.audio)
          return stream
        }
      }
    },
    configurable: true,
    writable: true
  })
  globalThis.fetch = async (url, init) => {
    sttCalls.push({ url, headers: init?.headers })
    if (sttHold) await sttHold
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: 'hello there' }) }
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

function rig(options = {}) {
  const seen = { finals: [], errors: [], barges: 0, rejected: [], phases: [] }
  const input = createVoiceInputLocal(options)
  input.setOnFinal((text, meta) => seen.finals.push({ text, meta }))
  input.setOnError((err) => seen.errors.push(err))
  input.setOnBargeIn(() => (seen.barges += 1))
  input.setOnRejected((reason) => seen.rejected.push(reason))
  input.setOnPhase((phase) => {
    seen.phases.push(phase)
    // What the voice orchestrator does as soon as an utterance is being transcribed.
    if (phase === 'transcribing') input.setDetectionEnabled(false)
  })
  return { input, seen }
}

/** The assistant starts speaking: the orchestrator marks the phase and the output reports the first sound. */
function assistantStartsSpeaking(input) {
  input.setSpeakingPhase(true)
  input.notePlaybackStarted?.()
}

/** The assistant stops (end of reply or cut) and the orchestrator returns to listening, as afterTurnComplete does. */
async function assistantStops(input, { interrupted = false } = {}) {
  input.setSpeakingPhase(false, { interrupted })
  await input.startContinuous()
}

const ECHO = 0.09 // its own voice in the microphone: well above the old 0.04 interruption threshold
const USER = 0.3

// ---- before and after: normal speech must keep working -------------------------------------------------------

test('control: ordinary user speech is captured, transcribed and delivered once, with an identity', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  level = USER
  await advance(200)
  assert.equal(recorders.length, 1, 'speech starts a capture')
  level = 0
  await advance(2600)
  assert.equal(sttCalls.length, 1, 'one request to the speech service')
  assert.equal(seen.finals.length, 1)
  assert.equal(seen.finals[0].text, 'hello there')
  assert.equal(typeof seen.finals[0].meta?.captureId, 'number', 'the capture can be told apart from any other')
  assert.equal(typeof seen.finals[0].meta?.startedAt, 'number', 'and knows when it began')
})

test('each capture has its own, increasing identity', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  for (let n = 0; n < 2; n++) {
    level = USER
    await advance(200)
    level = 0
    await advance(2600)
    await input.startContinuous() // what the orchestrator does when the turn is over
    await advance(1300)
  }
  assert.equal(seen.finals.length, 2)
  assert.ok(seen.finals[1].meta.captureId > seen.finals[0].meta.captureId)
})

// ---- the failure: playback taken for an interruption ----------------------------------------------------------

test('the assistant\'s own voice, far above the old fixed threshold, is not an interruption', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  assistantStartsSpeaking(input)
  level = ECHO
  await advance(4000)
  assert.equal(seen.barges, 0)
})

test('a person speaking clearly over the assistant still interrupts it, exactly once', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  assistantStartsSpeaking(input)
  level = ECHO
  await advance(1500)
  assert.equal(seen.barges, 0, 'nothing is heard as a person while only the assistant is speaking')
  level = USER
  await advance(1500)
  assert.equal(seen.barges, 1, 'one interruption, not one per tick')
})

test('a gradual rise in its own loudness is followed, not mistaken for a person', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  assistantStartsSpeaking(input)
  for (let step = 0; step <= 60; step++) {
    level = 0.05 + (0.07 * step) / 60 // 0.05 -> 0.12 over 6 s
    await advance(100)
  }
  assert.equal(seen.barges, 0)
})

test('limitation: a voice that is there from the first moment is taken to be the assistant\'s own', async () => {
  // Energy alone cannot tell two voices apart. A user who talks over the very first words is not heard as
  // an interruption (they can press interrupt); the alternative is the assistant cutting itself off.
  const { input, seen } = rig()
  await input.startContinuous()
  assistantStartsSpeaking(input)
  level = USER
  await advance(3000)
  assert.equal(seen.barges, 0)
})

// ---- the failure: the tail of its own speech taken for the user ---------------------------------------------

test('when the assistant stops, the sound still in the room is not taken for the user', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  assistantStartsSpeaking(input)
  level = ECHO
  await advance(1500)
  await assistantStops(input)
  level = ECHO // speaker, room and output buffer: its last words are still arriving
  await advance(300)
  assert.equal(recorders.length, 0, 'no capture was started on its own voice')
  assert.equal(sttCalls.length, 0)
  assert.deepEqual(seen.finals, [])
})

test('after that pause the user is heard again, and gets exactly one turn', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  assistantStartsSpeaking(input)
  level = ECHO
  await advance(1500)
  await assistantStops(input)
  level = 0
  await advance(1000)
  level = USER
  await advance(200)
  assert.equal(recorders.length, 1, 'the user\'s speech starts a capture')
  level = 0
  await advance(2600)
  assert.equal(seen.finals.length, 1)
})

test('an interruption leaves only a short pause: the user\'s words that follow are captured', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  assistantStartsSpeaking(input)
  level = ECHO
  await advance(1500)
  level = USER
  await advance(900)
  assert.equal(seen.barges, 1)
  await assistantStops(input, { interrupted: true }) // the orchestrator cut the speech
  await advance(400)
  assert.equal(recorders.length, 1, 'the user is still talking and is captured, not lost behind a long pause')
})

// ---- the failure: audio recorded while the assistant spoke -----------------------------------------------------

test('a capture that overlaps the assistant\'s speech is discarded, never transcribed', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  level = USER
  await advance(200) // a capture is running...
  assert.equal(recorders.length, 1)
  assistantStartsSpeaking(input) // ...when the assistant begins to speak
  level = ECHO
  await advance(15000)
  assert.equal(recorders[0].state, 'inactive', 'the recording was stopped')
  assert.equal(sttCalls.length, 0, 'what it holds is the assistant\'s own voice: nothing is sent for transcription')
  assert.deepEqual(seen.finals, [])
  assert.deepEqual(seen.errors, [], 'and it is not reported as an error either: that would restart the turn')
  assert.deepEqual(seen.rejected, [{ reason: 'overlapped-playback' }])
})

test('while the assistant is working, new sound cannot start a capture that would later hear it speak', async () => {
  const { input, seen } = rig()
  await input.startContinuous()
  sttHold = new Promise(() => {}) // the transcription request stays in flight: the assistant is working
  level = USER
  await advance(200)
  level = 0
  await advance(2600) // the utterance ends and is being transcribed
  assert.equal(recorders.length, 1)
  assert.equal(sttCalls.length, 1)
  level = USER // a cough, a chair, a second sentence
  await advance(3000)
  assert.equal(recorders.length, 1, 'no second capture starts during the turn')
  assert.deepEqual(seen.finals, [])
})

test('listening returns when the turn is over', async () => {
  const { input } = rig()
  await input.startContinuous()
  level = USER
  await advance(200)
  level = 0
  await advance(2600)
  level = USER
  await advance(2000)
  assert.equal(recorders.length, 1)
  await input.startContinuous() // the orchestrator: afterTurnComplete
  await advance(1500)
  assert.equal(recorders.length, 2, 'the next utterance is captured')
})

// ---- what the microphone level reports ------------------------------------------------------------------------

test('the input level never reports the assistant\'s own voice, while it speaks or just after', async () => {
  const { input } = rig()
  await input.startContinuous()
  level = ECHO
  await advance(100)
  assert.ok(input.getInputLevel() > 0, 'the real level is reported when it is not the assistant')
  assistantStartsSpeaking(input)
  await advance(500)
  assert.equal(input.getInputLevel(), 0, 'while it speaks')
  await assistantStops(input)
  await advance(200)
  assert.equal(input.getInputLevel(), 0, 'and while its tail is still in the room')
  await advance(1500)
  assert.ok(input.getInputLevel() > 0, 'then the microphone is reported again')
})

test('stopping and restarting listening clears a pending hold, so a new session starts listening at once', async () => {
  const { input } = rig()
  await input.startContinuous()
  input.setDetectionEnabled(false)
  await input.stopContinuous()
  await input.startContinuous()
  level = USER
  await advance(200)
  assert.equal(recorders.length, 1)
})

// ---- the microphone constraints are shared with the meeting recorder: they must not move ------------------------

test('the shared microphone constraints are unchanged: echo cancellation and noise suppression on, gain off', () => {
  assert.deepEqual(speechAudioConstraints(), {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false
  })
})

test('a meeting still asks for levelling and one channel on top of them, and a chosen device is exact', () => {
  assert.deepEqual(speechAudioConstraints({ deviceId: 'mic-1', channelCount: 1, autoGainControl: true }), {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    deviceId: { exact: 'mic-1' }
  })
})

// ---- a quiet microphone: the browser is asked to level it only when told to ------------------------------------

test('by default the input asks for the same microphone processing as before: gain control off', async () => {
  const { input } = rig()
  await input.startContinuous()
  assert.equal(requestedAudio.length, 1)
  assert.deepEqual(requestedAudio[0], { echoCancellation: true, noiseSuppression: true, autoGainControl: false })
})

test('with autoGainControl on, only that one constraint changes', async () => {
  const { input } = rig({ autoGainControl: true })
  await input.startContinuous()
  assert.deepEqual(requestedAudio[0], { echoCancellation: true, noiseSuppression: true, autoGainControl: true })
})

test('a chosen microphone is still requested exactly, with gain control as configured', async () => {
  const { input } = rig({ autoGainControl: true, getDeviceId: () => 'mic-7' })
  await input.startContinuous()
  assert.deepEqual(requestedAudio[0], {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    deviceId: { exact: 'mic-7' }
  })
})
