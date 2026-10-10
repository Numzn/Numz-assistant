import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceOrchestrator } from '../src/interfaces/voice/voiceOrchestrator.js'

/**
 * The assistant must never speak into a meeting. Reproduces the 2026-10-09 incident: the assistant heard a
 * phrase, the meeting started while the AI was still answering, and the answer was spoken anyway and
 * recorded into the meeting ("Hmm, I'm not quite following...").
 */

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function rig(config = {}) {
  const callbacks = {}
  const events = []
  const spoken = []
  const counts = { cancel: 0, requests: 0 }
  const listeners = new Map()
  let pendingReply = null

  const voiceInput = {
    isSupported: () => true,
    setOnFinal: (fn) => (callbacks.final = fn),
    setOnPartial: () => {},
    setOnError: () => {},
    start() {},
    stop() {}
  }
  const voiceOutput = {
    isSupported: () => true,
    setOnStart() {},
    setOnEnd() {},
    setOnError() {},
    cancel: () => (counts.cancel += 1),
    beginStream() {},
    enqueueChunk: async (text) => spoken.push(text),
    endStream: async () => {}
  }
  const assistantController = {
    requestReply: () => {
      counts.requests += 1
      pendingReply = deferred()
      return pendingReply.promise
    },
    setListening: async () => {},
    setSpeaking: async () => {},
    setIdle: async () => {},
    setError: async () => {},
    setTranscribing: async () => {}
  }
  const eventBus = {
    on(type, fn) {
      listeners.set(type, fn)
      return () => listeners.delete(type)
    },
    emit(type, payload) {
      events.push([type, payload])
      listeners.get(type)?.({ payload })
    }
  }
  const orchestrator = createVoiceOrchestrator({
    stateMachine: { subscribe: () => () => {}, getState: () => 'IDLE' },
    assistantController,
    voiceInput,
    voiceOutput,
    deviceManager: {},
    ui: {},
    config,
    eventBus
  })
  const api = orchestrator.init()
  return {
    api,
    spoken,
    counts,
    events,
    hear: (text, meta) => callbacks.final(text, meta),
    streamToken: (token) => eventBus.emit('assistant:token', { token }),
    answer: (text) => pendingReply.resolve(text)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('control: with no meeting, the reply is spoken', async () => {
  const r = rig()
  const turn = r.hear('extinguished possibilities')
  await tick()
  r.streamToken("Hmm, I'm not quite following. ")
  r.answer("Hmm, I'm not quite following.")
  await turn
  await tick()
  assert.ok(r.spoken.join(' ').includes('not quite following'), 'the harness really exercises speaking')
})

test('a reply that arrives after the meeting started is never spoken, streamed or final', async () => {
  const r = rig()
  const turn = r.hear('extinguished possibilities') // the assistant is mid-turn...
  await tick()
  await r.api.suspend() // ...when the meeting starts
  r.streamToken("Hmm, I'm not quite following. What do you mean by extinguished possibilities? ")
  r.answer("Hmm, I'm not quite following. What do you mean by extinguished possibilities?")
  await turn
  await tick()
  assert.deepEqual(r.spoken, [], 'nothing is spoken into the meeting')
  assert.ok(r.counts.cancel >= 1, 'speech that was already playing is cut')
})

test('while suspended nothing new is even asked; after resume the assistant answers again', async () => {
  const r = rig()
  await r.api.suspend()
  await r.hear('are you there')
  assert.equal(r.counts.requests, 0, 'no question is sent to the AI during a meeting')

  r.api.resume()
  const turn = r.hear('are you there')
  await tick()
  r.answer('Yes, I am here.')
  await turn
  await tick()
  assert.equal(r.counts.requests, 1)
  assert.ok(r.spoken.join(' ').includes('I am here'))
})

test('a typed message streams the same events but its reply is never spoken aloud', async () => {
  const r = rig()
  // No spoken turn is in flight: this is what a reply to a typed message looks like to the orchestrator.
  r.streamToken('This reply belongs to a typed message. ')
  r.streamToken('It must stay silent.')
  await tick()
  assert.deepEqual(r.spoken, [])
})

// ---- Voice mode: explicit start results, interrupt, and the real input level ------------------------------

function voiceRig({ start = async () => {}, level = 0.4, conversationMode = true, commands = null } = {}) {
  const counts = { cancel: 0, startContinuous: 0, stopContinuous: 0, interrupt: 0, idle: 0, error: 0, listening: 0, processing: 0, requests: 0 }
  const callbacks = {}
  const spoken = []
  const events = []
  const voiceInput = {
    isSupported: () => true,
    setOnFinal: (fn) => (callbacks.final = fn),
    setOnPartial() {},
    setOnError() {},
    start() {},
    stop() {},
    startContinuous: async () => {
      counts.startContinuous += 1
      await start()
    },
    stopContinuous: async () => (counts.stopContinuous += 1),
    setSpeakingPhase() {},
    getInputLevel: () => level
  }
  const voiceOutput = {
    isSupported: () => true,
    setOnStart() {},
    setOnEnd() {},
    setOnError() {},
    cancel: () => (counts.cancel += 1),
    beginStream() {},
    enqueueChunk: async (text) => spoken.push(text),
    endStream: async () => {}
  }
  const assistantController = {
    requestReply: async () => {
      counts.requests += 1
      return 'The assistant answered.'
    },
    setProcessing: async () => (counts.processing += 1),
    setListening: async () => (counts.listening += 1),
    setSpeaking: async () => {},
    setIdle: async () => (counts.idle += 1),
    setError: async () => (counts.error += 1),
    setTranscribing: async () => {},
    interrupt: async () => (counts.interrupt += 1)
  }
  const orchestrator = createVoiceOrchestrator({
    stateMachine: { subscribe: () => () => {}, getState: () => 'IDLE' },
    assistantController,
    voiceInput,
    voiceOutput,
    deviceManager: {},
    ui: {},
    config: { audioMode: 'local', conversationMode },
    commands,
    eventBus: { on: () => () => {}, emit: (type, payload) => events.push({ type, payload }) }
  })
  return { api: orchestrator.init(), counts, voiceInput, spoken, events, hear: (text) => callbacks.final(text) }
}

const named = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra })
const silenced = async (fn) => {
  const original = console.error
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.error = original
  }
}

test('voice mode starts and says so', async () => {
  const r = voiceRig()
  assert.deepEqual(await r.api.startConversation(), { ok: true })
  assert.equal(r.api.isConversationActive(), true)
  assert.equal(r.counts.startContinuous, 1)
})

test('a blocked microphone is reported as permission-denied, and voice mode is not left half on', async () => {
  const r = voiceRig({ start: async () => { throw named('NotAllowedError') } })
  assert.deepEqual(await silenced(() => r.api.startConversation()), { ok: false, reason: 'permission-denied' })
  assert.equal(r.api.isConversationActive(), false)
})

test('a missing microphone is reported as no-microphone', async () => {
  const r = voiceRig({ start: async () => { throw named('NotFoundError') } })
  assert.deepEqual(await silenced(() => r.api.startConversation()), { ok: false, reason: 'no-microphone' })
  assert.equal(r.api.isConversationActive(), false)
})

test('a browser that needs another tap is reported as needs-gesture', async () => {
  const r = voiceRig({ start: async () => { throw Object.assign(new Error('suspended'), { code: 'audio-context-suspended' }) } })
  assert.deepEqual(await silenced(() => r.api.startConversation()), { ok: false, reason: 'needs-gesture' })
})

test('any other start failure is an error, and the assistant is put into its error state', async () => {
  const r = voiceRig({ start: async () => { throw new Error('boom') } })
  assert.deepEqual(await silenced(() => r.api.startConversation()), { ok: false, reason: 'error' })
  assert.equal(r.counts.error, 1)
  assert.equal(r.api.isConversationActive(), false)
})

test('voice mode cannot start while a meeting has the microphone, and does not touch it', async () => {
  const r = voiceRig()
  await r.api.suspend()
  const opened = r.counts.startContinuous
  assert.deepEqual(await r.api.startConversation(), { ok: false, reason: 'suspended' })
  assert.equal(r.counts.startContinuous, opened)
})

test('without conversation support voice mode says unsupported', async () => {
  const r = voiceRig({ conversationMode: false })
  assert.deepEqual(await r.api.startConversation(), { ok: false, reason: 'unsupported' })
})

test('interrupt in a conversation cuts speech, aborts the stream and goes back to listening', async () => {
  const r = voiceRig()
  await r.api.startConversation()
  const before = { ...r.counts }
  await r.api.interrupt()
  assert.equal(r.counts.cancel, before.cancel + 1, 'speech is cut')
  assert.equal(r.counts.interrupt, before.interrupt + 1, 'the stream is aborted')
  assert.equal(r.counts.startContinuous, before.startContinuous + 1, 'listening resumes')
  assert.equal(r.api.isConversationActive(), true)
})

test('interrupt outside a conversation cuts speech, aborts the stream and returns to idle', async () => {
  const r = voiceRig()
  await r.api.interrupt()
  assert.equal(r.counts.cancel, 1)
  assert.equal(r.counts.interrupt, 1)
  assert.equal(r.counts.idle, 1)
  assert.equal(r.counts.startContinuous, 0, 'it does not start listening')
})

test('interrupt does nothing while a meeting has the microphone', async () => {
  const r = voiceRig()
  await r.api.suspend()
  const before = { ...r.counts }
  await r.api.interrupt()
  assert.deepEqual(r.counts, before)
})

test('the input level is the real microphone level, and 0 when the input cannot report one', async () => {
  const r = voiceRig({ level: 0.37 })
  assert.equal(r.api.getInputLevel(), 0.37)
  delete r.voiceInput.getInputLevel
  assert.equal(r.api.getInputLevel(), 0)
})

// ---- Meeting commands heard by voice ---------------------------------------------------------------------

test('a spoken command is answered out loud and never sent to the assistant', async () => {
  const commands = { handle: async (text) => (text === 'start a meeting' ? { reply: 'I opened the meeting panel.' } : null) }
  const r = voiceRig({ commands })
  await r.hear('start a meeting')
  await tick()
  assert.equal(r.counts.requests, 0, 'the assistant was not asked')
  assert.deepEqual(r.spoken, ['I opened the meeting panel.'])
  assert.deepEqual(
    r.events.filter((event) => event.type === 'command:handled').map((event) => event.payload),
    [{ text: 'start a meeting', reply: 'I opened the meeting panel.' }],
    'the conversation thread is told'
  )
  assert.equal(r.counts.processing, 1, 'speaking goes through the normal states')
})

test('ordinary speech still reaches the assistant when a command handler is present', async () => {
  const r = voiceRig({ commands: { handle: async () => null } })
  await r.hear('what is the weather')
  await tick()
  assert.equal(r.counts.requests, 1)
  assert.equal(r.events.some((event) => event.type === 'command:handled'), false)
})

test('a command handler that fails does not lose the turn: it goes to the assistant', async () => {
  const r = voiceRig({ commands: { handle: async () => { throw new Error('boom') } } })
  await silenced(async () => {
    await r.hear('start a meeting')
    await tick()
  })
  assert.equal(r.counts.requests, 1)
})

test('after a spoken command in a conversation, listening resumes', async () => {
  const r = voiceRig({ commands: { handle: async () => ({ reply: 'Done.' }) } })
  await r.api.startConversation()
  const before = r.counts.startContinuous
  await r.hear('start a meeting')
  await tick()
  assert.equal(r.counts.startContinuous, before + 1)
})

// ---- The assistant must not hear itself ------------------------------------------------------------------------
//
// Deterministic lifecycle tests of the orchestrator with a scripted input and output. The acoustics (how loud the
// assistant is in a real microphone, how well a browser cancels it) cannot be tested here: see the manual test in
// the change notes. The input side of the same fix is tested in tests/voiceInputLocal.test.js.

function convRig({ ttsWatchdogMs, interruptSettleMs, ui = {} } = {}) {
  const calls = { start: 0, cancel: 0, interrupt: 0, startContinuous: 0, stopContinuous: 0, stop: 0, error: 0, idle: 0, requests: 0, notePlayback: 0 }
  const speakingPhase = [] // every setSpeakingPhase(active, options)
  const detection = []
  const spoken = []
  const callbacks = {}
  const listeners = new Map()
  let reply = null
  let playback = deferred()
  let playbackRejectsOnCancel = false

  const voiceInput = {
    isSupported: () => true,
    setOnFinal: (fn) => (callbacks.final = fn),
    setOnPartial: (fn) => (callbacks.partial = fn),
    setOnError: (fn) => (callbacks.error = fn),
    setOnBargeIn: (fn) => (callbacks.bargeIn = fn),
    setOnPhase: (fn) => (callbacks.phase = fn),
    start: () => (calls.start += 1),
    stop: () => (calls.stop += 1),
    startContinuous: async () => (calls.startContinuous += 1),
    stopContinuous: async () => (calls.stopContinuous += 1),
    setSpeakingPhase: (active, options) => speakingPhase.push({ active, options }),
    setDetectionEnabled: (enabled) => detection.push(enabled),
    notePlaybackStarted: () => (calls.notePlayback += 1),
    getInputLevel: () => 0
  }
  const voiceOutput = {
    isSupported: () => true,
    setOnStart: (fn) => (callbacks.outputStart = fn),
    setOnEnd() {},
    setOnError() {},
    cancel() {
      calls.cancel += 1
      if (playbackRejectsOnCancel) playback.reject({ error: 'canceled' })
    },
    beginStream() {},
    enqueueChunk: async (text) => spoken.push(text),
    endStream: () => playback.promise
  }
  const assistantController = {
    requestReply: () => {
      calls.requests += 1
      reply = deferred()
      return reply.promise
    },
    setProcessing: async () => {},
    setListening: async () => {},
    setSpeaking: async () => {},
    setIdle: async () => (calls.idle += 1),
    setError: async () => (calls.error += 1),
    setTranscribing: async () => {},
    interrupt: async () => (calls.interrupt += 1)
  }
  const eventBus = {
    on(type, fn) {
      listeners.set(type, fn)
      return () => listeners.delete(type)
    },
    emit(type, payload) {
      listeners.get(type)?.({ payload })
    }
  }
  const orchestrator = createVoiceOrchestrator({
    stateMachine: { subscribe: () => () => {}, getState: () => 'IDLE' },
    assistantController,
    voiceInput,
    voiceOutput,
    deviceManager: {},
    ui,
    config: { audioMode: 'local', conversationMode: true, ttsWatchdogMs, interruptSettleMs },
    eventBus
  })
  const api = orchestrator.init()
  let captureSeq = 100
  return {
    api,
    calls,
    spoken,
    speakingPhase,
    detection,
    callbacks,
    /** A finished capture: a new identity each time unless one is given. */
    hear(text, meta = {}) {
      const full = { captureId: ++captureSeq, startedAt: performance.now(), ...meta }
      callbacks.final(text, full)
      return full
    },
    streamToken: (token) => eventBus.emit('assistant:token', { token }),
    answer: (text) => reply.resolve(text),
    /** The resolver of the request pending right now, kept for later (a request that may return late). */
    takeAnswer: () => reply.resolve,
    finishPlayback: () => playback.resolve(),
    failPlayback: (error) => playback.reject(error),
    rejectPlaybackOnCancel: () => (playbackRejectsOnCancel = true),
    newPlayback: () => (playback = deferred())
  }
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await tick()
}

/** One whole turn: the user speaks, the reply streams in and is spoken, and playback ends normally. */
async function completeTurn(r, said = 'what time is it', replyText = 'It is noon. ') {
  const meta = r.hear(said)
  await settle()
  r.streamToken(replyText)
  await settle()
  r.answer(replyText.trim())
  await settle()
  r.finishPlayback()
  await settle()
  r.newPlayback()
  return meta
}

test('one finalized utterance produces at most one assistant turn, however often it is announced', async () => {
  const r = convRig()
  await r.api.startConversation()
  const meta = r.hear('what time is it')
  await settle()
  r.callbacks.final('what time is it', meta) // announced again while the turn is in progress
  await settle()
  assert.equal(r.calls.requests, 1)

  r.streamToken('It is noon. ')
  await settle()
  r.answer('It is noon.')
  await settle()
  r.finishPlayback()
  await settle()
  r.callbacks.final('what time is it', meta) // and again after the turn is over
  await settle()
  assert.equal(r.calls.requests, 1, 'the same capture is never answered twice')
})

test('a person saying the same thing again is a second command: identity decides, never the words', async () => {
  const r = convRig()
  await r.api.startConversation()
  await completeTurn(r, 'what time is it')
  assert.equal(r.calls.requests, 1)
  await completeTurn(r, 'what time is it')
  assert.equal(r.calls.requests, 2)
})

test('a stale partial transcript never becomes a command', async () => {
  const r = convRig()
  await r.api.startConversation()
  r.callbacks.partial('make me a sandwich')
  r.callbacks.partial('make me a sandwich please')
  await settle()
  assert.equal(r.calls.requests, 0)
})

test('a final that began before an interruption is dropped when it arrives; a fresh one is answered', async () => {
  const r = convRig()
  await r.api.startConversation()
  const began = performance.now()
  await tick()
  await r.api.interrupt()
  r.callbacks.final('the assistant\'s own words, captured', { captureId: 900, startedAt: began })
  await settle()
  assert.equal(r.calls.requests, 0, 'it was recorded before the interruption: not a command')
  r.hear('what time is it')
  await settle()
  assert.equal(r.calls.requests, 1, 'speech after the interruption is')
})

test('a fresh command after the assistant has finished speaking is a new turn, and listening came back first', async () => {
  const r = convRig()
  await r.api.startConversation()
  const before = r.calls.startContinuous
  await completeTurn(r, 'what time is it')
  assert.equal(r.calls.startContinuous, before + 1, 'listening resumed after the reply')
  const ended = r.speakingPhase.filter((entry) => entry.active === false).at(-1)
  assert.ok(ended, 'the speaking phase was ended')
  assert.ok(!ended.options?.interrupted, 'a reply that ran to its end is not reported as an interruption')
  r.hear('and tomorrow')
  await settle()
  assert.equal(r.calls.requests, 2)
})

test('the output tells the input when its voice is audible, so the loudness measurement starts there', async () => {
  const r = convRig()
  await r.api.startConversation()
  r.callbacks.outputStart()
  assert.equal(r.calls.notePlayback, 1)
})

test('a genuine interruption: speech is cut, the stream aborted and listening resumes at once', async () => {
  const r = convRig()
  await r.api.startConversation()
  r.hear('tell me a story')
  await settle()
  r.streamToken('Once upon a time there was a very tall dragon. ')
  await settle()
  assert.ok(r.spoken.length >= 1, 'the assistant is speaking')
  const before = { ...r.calls }

  r.callbacks.bargeIn() // the person talks over it
  await settle()
  assert.equal(r.calls.cancel, before.cancel + 1, 'speech is cut')
  assert.equal(r.calls.interrupt, before.interrupt + 1, 'the stream is aborted')
  assert.equal(r.calls.startContinuous, before.startContinuous + 1, 'listening resumes')
  assert.ok(
    r.speakingPhase.some((entry) => entry.active === false && entry.options?.interrupted === true),
    'the input is told this stop was an interruption (a short wait: the person is already talking)'
  )
})

test('the command that follows an interruption is not dropped as "busy": it is held until the old request settles, then answered', async () => {
  const r = convRig({ interruptSettleMs: 5000 })
  await r.api.startConversation()
  r.hear('tell me a story')
  await settle()
  const answerFirst = r.takeAnswer() // the request of the turn about to be interrupted
  r.streamToken('Once upon a time there was a very tall dragon. ')
  await settle()
  r.callbacks.bargeIn()
  await settle()

  r.hear('never mind, what time is it')
  await settle()
  assert.equal(r.calls.requests, 1, 'the new request waits: the server is still sending the old reply')

  const spokenBefore = [...r.spoken]
  answerFirst('and the dragon loved to read very very long books') // the abandoned request returns, late
  await settle()
  assert.equal(r.calls.requests, 2, 'now the new command is sent: it was held, not lost')
  assert.deepEqual(r.spoken, spokenBefore, 'nothing from the abandoned turn is spoken')
  assert.equal(r.calls.error, 0)

  r.streamToken('It is exactly noon right now. ')
  await settle()
  r.answer('It is exactly noon right now.')
  await settle()
  assert.ok(r.spoken.some((text) => text.includes('exactly noon')), 'the new turn is spoken normally')
})

test('the hold after an interruption is bounded: a request that never returns does not block the next command', async () => {
  const r = convRig({ interruptSettleMs: 40 })
  await r.api.startConversation()
  r.hear('tell me a story')
  await settle()
  r.streamToken('Once upon a time there was a very tall dragon. ')
  await settle()
  r.callbacks.bargeIn()
  await settle()
  r.hear('never mind, what time is it')
  await settle()
  assert.equal(r.calls.requests, 1)
  await new Promise((resolve) => setTimeout(resolve, 100))
  await settle()
  assert.equal(r.calls.requests, 2, 'the old request never returned; the command went ahead')
})

test('when nothing is pending an interruption does not delay the next command at all', async () => {
  const r = convRig({ interruptSettleMs: 5000 })
  await r.api.startConversation()
  await completeTurn(r, 'what time is it')
  r.hear('and tomorrow')
  await settle()
  assert.equal(r.calls.requests, 2, 'a finished request is not waited for')
})

test('after a manual interrupt in wake mode the wake word is armed again, as it was before', async () => {
  const handlers = {}
  const wakeButtonEl = {
    addEventListener: (type, fn) => (handlers[type] = fn),
    removeEventListener() {},
    setAttribute() {}
  }
  const r = convRig({ ui: { wakeButtonEl } })
  await handlers.click({ preventDefault() {} }) // wake mode on
  await settle()
  const armed = r.calls.start
  r.hear('numz what time is it')
  await settle()
  assert.equal(r.calls.requests, 1)
  await r.api.interrupt()
  await settle()
  assert.equal(r.calls.start, armed + 1, 'listening for the wake word began again')
})

test('the reply of an interrupted turn is never spoken, even when it arrives late', async () => {
  const r = convRig()
  await r.api.startConversation()
  r.hear('tell me a story')
  await settle()
  const answerFirst = r.takeAnswer()
  await r.api.interrupt()
  answerFirst('A story the person no longer wants to hear.')
  await settle()
  assert.deepEqual(r.spoken, [], 'nothing from the abandoned turn is spoken')
  assert.equal(r.calls.error, 0)
})

test('an interruption heard while nothing of the assistant\'s is playing or pending is ignored', async () => {
  const r = convRig()
  await r.api.startConversation()
  const before = { ...r.calls }
  r.callbacks.bargeIn()
  await settle()
  assert.equal(r.calls.cancel, before.cancel)
  assert.equal(r.calls.interrupt, before.interrupt)
})

test('a speech failure puts the assistant in its error state, then idle, and a new conversation can start', async () => {
  const r = convRig()
  await r.api.startConversation()
  r.hear('what time is it')
  await settle()
  r.streamToken('It is noon. ')
  await settle()
  r.answer('It is noon.')
  await settle()
  await silenced(async () => {
    r.failPlayback({ error: 'synthesis-failed' })
    await settle()
  })
  assert.equal(r.calls.error, 1)
  assert.ok(r.calls.idle >= 1, 'it ends idle, not stuck in speaking')
  assert.equal(r.api.isConversationActive(), false)
  assert.equal(r.speakingPhase.at(-1).active, false, 'the input is not left in its speaking phase')

  r.newPlayback()
  assert.deepEqual(await r.api.startConversation(), { ok: true })
  r.hear('what time is it')
  await settle()
  assert.equal(r.calls.requests, 2, 'the turn did not stay busy')
})

test('speech cancelled by the browser is not an error: listening comes back', async () => {
  const r = convRig()
  await r.api.startConversation()
  r.hear('what time is it')
  await settle()
  r.streamToken('It is noon. ')
  await settle()
  r.answer('It is noon.')
  await settle()
  const before = r.calls.startContinuous
  r.failPlayback({ error: 'canceled' })
  await settle()
  assert.equal(r.calls.error, 0)
  assert.equal(r.calls.startContinuous, before + 1, 'listening resumed')
  assert.equal(r.api.isConversationActive(), true)
  r.newPlayback()
  r.hear('and tomorrow')
  await settle()
  assert.equal(r.calls.requests, 2)
})

test('speech that never reports its end does not leave the turn stuck', async () => {
  const r = convRig({ ttsWatchdogMs: 40 })
  await r.api.startConversation()
  r.hear('what time is it')
  await settle()
  r.streamToken('It is noon. ')
  await settle()
  r.answer('It is noon.')
  await settle()
  const before = { ...r.calls }
  await new Promise((resolve) => setTimeout(resolve, 120)) // endStream() never settles
  await settle()
  assert.equal(r.calls.cancel, before.cancel + 1, 'the stuck speech is cut')
  assert.equal(r.calls.startContinuous, before.startContinuous + 1, 'and listening resumes')
  r.newPlayback()
  r.hear('are you there')
  await settle()
  assert.equal(r.calls.requests, 2)
})

test('an empty capture from earlier does not reset the turn that is in progress', async () => {
  const r = convRig()
  await r.api.startConversation()
  r.hear('what time is it')
  await settle()
  r.streamToken('The time right now is exactly noon. ')
  await settle()
  assert.equal(r.spoken.length, 1, 'the first sentence is being spoken')
  const before = { ...r.calls }
  const spokenBefore = r.spoken.length
  await silenced(async () => {
    r.callbacks.error({ error: 'no-speech' }) // an earlier capture came back empty, mid-reply
    await settle()
  })
  assert.equal(r.calls.startContinuous, before.startContinuous, 'listening was not restarted over the reply')
  assert.equal(r.calls.stop, before.stop, 'and the capture now running was not stopped')
  r.streamToken('And in ten minutes it will be a quarter past. ')
  await settle()
  assert.ok(r.spoken.length > spokenBefore, 'the rest of the reply is still spoken')
})

test('between turns an empty capture still returns to listening, as before', async () => {
  const r = convRig()
  await r.api.startConversation()
  const before = r.calls.startContinuous
  await silenced(async () => {
    r.callbacks.error({ error: 'no-speech' })
    await settle()
  })
  assert.equal(r.calls.startContinuous, before + 1)
})

test('meeting: a final captured before the meeting started is dropped after it, and the assistant answers again later', async () => {
  const r = convRig()
  await r.api.startConversation()
  const began = performance.now()
  await tick()
  await r.api.suspend()
  r.callbacks.final('something said before the meeting', { captureId: 700, startedAt: began })
  await settle()
  assert.equal(r.calls.requests, 0, 'nothing is asked of the assistant during a meeting')
  r.api.resume()
  await r.api.startConversation()
  r.callbacks.final('something said before the meeting', { captureId: 701, startedAt: began })
  await settle()
  assert.equal(r.calls.requests, 0, 'and it stays dropped afterwards')
  r.hear('are you there')
  await settle()
  assert.equal(r.calls.requests, 1)
})

// ---- the assistant hearing itself: the transcript-level guard ----------------------------------------------------

async function spokenReply(r, question, reply) {
  const turn = r.hear(question)
  await tick()
  r.streamToken(`${reply} `)
  r.answer(reply)
  await turn
  await tick()
}

test('its own words coming back right after a reply are not sent to the assistant', async () => {
  const r = rig()
  await spokenReply(r, 'what time is it', 'The time is exactly noon and you have a meeting at one thirty.')
  assert.equal(r.counts.requests, 1)
  assert.ok(r.spoken.join(' ').includes('exactly noon'), 'the harness spoke it')

  await r.hear('the time is exactly noon and you have a meeting', { captureId: 7, startedAt: performance.now() })
  await tick()
  assert.equal(r.counts.requests, 1, 'the echo was not taken for a question')
  assert.ok(r.events.some(([type]) => type === 'voice:echo-suppressed'))
})

test('unrelated speech right after a reply is answered as usual', async () => {
  const r = rig()
  await spokenReply(r, 'what time is it', 'The time is exactly noon and you have a meeting at one thirty.')
  const turn = r.hear('set a timer for ten minutes', { captureId: 8, startedAt: performance.now() })
  await tick()
  r.answer('Timer set.')
  await turn
  assert.equal(r.counts.requests, 2)
  assert.equal(r.events.filter(([type]) => type === 'voice:echo-suppressed').length, 0)
})

test('speech that overlaps the reply and adds words of its own is answered', async () => {
  const r = rig()
  await spokenReply(r, 'what time is it', 'The time is exactly noon and you have a meeting at one thirty.')
  const turn = r.hear('exactly noon what about tomorrow morning instead', { captureId: 9, startedAt: performance.now() })
  await tick()
  r.answer('Tomorrow is free.')
  await turn
  assert.equal(r.counts.requests, 2)
})

test('the same words said later, as a new capture, are the user\'s', async () => {
  const r = rig()
  await spokenReply(r, 'what time is it', 'The time is exactly noon and you have a meeting at one thirty.')
  const turn = r.hear('the time is exactly noon and you have a meeting', {
    captureId: 10,
    startedAt: performance.now() + 20_000
  })
  await tick()
  r.answer('Yes.')
  await turn
  assert.equal(r.counts.requests, 2)
})

test('the guard can be switched off', async () => {
  const r = rig({ selfEchoGuard: false })
  await spokenReply(r, 'what time is it', 'The time is exactly noon and you have a meeting at one thirty.')
  const turn = r.hear('the time is exactly noon and you have a meeting', { captureId: 11, startedAt: performance.now() })
  await tick()
  r.answer('Yes.')
  await turn
  assert.equal(r.counts.requests, 2)
})

test('a reply that was cut off is still remembered, so its tail is not answered either', async () => {
  const r = rig()
  const turn = r.hear('explain photosynthesis')
  await tick()
  r.streamToken('Photosynthesis is the process plants use to turn sunlight into sugar. ')
  await tick()
  await r.api.interrupt?.()
  r.answer('Photosynthesis is the process plants use to turn sunlight into sugar.')
  await turn
  await tick()
  const requestsBefore = r.counts.requests
  await r.hear('the process plants use to turn sunlight', { captureId: 12, startedAt: performance.now() })
  await tick()
  assert.equal(r.counts.requests, requestsBefore)
})
