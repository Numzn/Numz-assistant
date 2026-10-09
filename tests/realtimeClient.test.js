import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { createAssistantRealtimeClient } from '../src/assistant/realtimeClient.js'

/**
 * The server's assistant socket sends every event twice: the new name (AI_TOKEN, AI_RESPONSE_FINISHED) and
 * the old one (token, message). Until 2026-10-09 the page forwarded both, so every token of every reply was
 * shown and spoken twice ("I I'm'm not not quite quite following following").
 */

let original
let serverScript // (send) => void, called when the page sends its chat message

class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  constructor() {
    this.readyState = FakeSocket.CONNECTING
    this.listeners = {}
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN
      this.emit('open', {})
    })
  }
  addEventListener(type, fn, options) {
    ;(this.listeners[type] ??= []).push({ fn, once: options?.once })
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry.fn !== fn)
  }
  emit(type, event) {
    for (const entry of [...(this.listeners[type] ?? [])]) {
      if (entry.once) this.removeEventListener(type, entry.fn)
      entry.fn(event)
    }
  }
  send(data) {
    const msg = JSON.parse(data)
    if (msg.type === 'chat') queueMicrotask(() => serverScript((payload) => this.emit('message', { data: JSON.stringify(payload) })))
  }
  close() {}
}

beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  globalThis.WebSocket = FakeSocket
})
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'WebSocket', original)
  else delete globalThis.WebSocket
})

const TOKENS = ['Hmm', ',', ' I', "'m", ' not', ' quite', ' following', '.']
const REPLY = TOKENS.join('')

async function runTurn() {
  const events = []
  const client = createAssistantRealtimeClient()
  const final = await client.chatStream({ sessionId: 's1', message: 'hello', onEvent: (e) => events.push(e) })
  const tokens = events.filter((e) => e.event === 'token').map((e) => e.data.token)
  return { final, tokens, events }
}

test('what this server sends (every event under both names) is delivered once', async () => {
  serverScript = (send) => {
    send({ type: 'AI_RESPONSE_STARTED', sessionId: 's1' })
    for (const token of TOKENS) {
      send({ type: 'AI_TOKEN', token, sessionId: 's1' }) // new name...
      send({ type: 'token', token, sessionId: 's1' }) // ...and the old one, as the orchestrator emits
    }
    send({ type: 'AI_RESPONSE_FINISHED', reply: REPLY, sessionId: 's1' })
    send({ type: 'message', reply: REPLY, sessionId: 's1' })
    send({ type: 'done', sessionId: 's1' })
  }
  const { final, tokens, events } = await runTurn()
  assert.deepEqual(tokens, TOKENS, 'each token once, in order')
  assert.equal(tokens.join(''), "Hmm, I'm not quite following.", 'not "HmmHmm,, I I\'m\'m not not quite quite"')
  assert.equal(events.filter((e) => e.event === 'message').length, 1, 'the final message once')
  assert.equal(final.reply, REPLY)
})

test('an older server that sends only the old names still streams', async () => {
  serverScript = (send) => {
    for (const token of TOKENS) send({ type: 'token', token, sessionId: 's1' })
    send({ type: 'message', reply: REPLY, sessionId: 's1' })
    send({ type: 'done', sessionId: 's1' })
  }
  const { final, tokens } = await runTurn()
  assert.deepEqual(tokens, TOKENS)
  assert.equal(final.reply, REPLY)
})
