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
