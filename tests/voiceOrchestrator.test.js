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
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

function rig() {
  const callbacks = {}
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
    config: {},
    eventBus
  })
  const api = orchestrator.init()
  return {
    api,
    spoken,
    counts,
    hear: (text) => callbacks.final(text),
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
