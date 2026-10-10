import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantController } from '../src/assistant/controller.js'
import { createEventBus } from '../src/core/events/eventBus.js'
import { createStateMachine, STATES } from '../src/assistant/stateMachine.js'

/**
 * submitText: a typed message through the SAME request path as a spoken one. The real state machine and the
 * real controller run; only the network client is faked.
 */

function abortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

function rig({ stream, send } = {}) {
  const stateMachine = createStateMachine(STATES.IDLE)
  const eventBus = createEventBus()
  const visited = []
  const synced = []
  stateMachine.subscribe((next) => visited.push(next))
  const events = []
  eventBus.on('*', (event) => events.push(event.type))
  const client = {
    getSessionId: () => 'session-1',
    setState: async (state) => synced.push(state),
    streamMessage: stream,
    sendMessage: send
  }
  const controller = createAssistantController({ stateMachine, client, eventBus })
  return { controller, stateMachine, visited, synced, events, eventBus }
}

const streaming = (tokens, reply) => async (_text, { onEvent }) => {
  for (const token of tokens) onEvent({ event: 'token', data: { token } })
  onEvent({ event: 'message', data: { reply } })
  return { reply }
}

test('a typed message goes through the streaming request path and returns the reply', async () => {
  const r = rig({ stream: streaming(['Hel', 'lo'], 'Hello') })
  const tokens = []
  r.eventBus.on('assistant:token', (event) => tokens.push(event.payload.token))

  const reply = await r.controller.submitText('  hi there  ')

  assert.equal(reply, 'Hello')
  assert.deepEqual(tokens, ['Hel', 'lo'])
  assert.deepEqual(
    r.events.filter((type) => ['turn:start', 'ai:request', 'assistant:token', 'ai:response'].includes(type)),
    ['turn:start', 'ai:request', 'assistant:token', 'assistant:token', 'ai:response']
  )
})

test('the turn never enters SPEAKING (nothing is read aloud) and ends IDLE, on the server too', async () => {
  const r = rig({ stream: streaming(['ok'], 'ok') })
  await r.controller.submitText('hello')
  assert.ok(!r.visited.includes(STATES.SPEAKING), `states: ${r.visited.join(' > ')}`)
  assert.equal(r.stateMachine.getState(), STATES.IDLE)
  assert.equal(r.synced.at(-1), STATES.IDLE, 'the server is told the assistant is idle again')
})

test('empty or blank text sends nothing', async () => {
  let requests = 0
  const r = rig({ stream: async () => (requests += 1), send: async () => (requests += 1) })
  assert.equal(await r.controller.submitText('   '), null)
  assert.equal(await r.controller.submitText(undefined), null)
  assert.equal(requests, 0)
})

test('when streaming fails before any output, the JSON request is used', async () => {
  const r = rig({
    stream: async () => {
      throw new Error('no stream')
    },
    send: async (text) => ({ reply: `echo ${text}` })
  })
  assert.equal(await r.controller.submitText('hello'), 'echo hello')
  assert.equal(r.stateMachine.getState(), STATES.IDLE)
})

test('a failed request reports a recoverable error, returns null and leaves the assistant IDLE (not stuck in ERROR)', async () => {
  const r = rig({
    stream: async () => {
      throw new Error('boom')
    },
    send: async () => {
      throw new Error('server down')
    }
  })
  const reply = await r.controller.submitText('hello')
  assert.equal(reply, null)
  assert.ok(r.events.includes('error:recoverable'))
  assert.ok(r.visited.includes(STATES.ERROR), 'the error was real')
  assert.equal(r.stateMachine.getState(), STATES.IDLE, 'but it does not strand the next turn or voice mode')
})

test('an error or interruption left by an earlier turn does not stop the next message', async () => {
  const r = rig({ stream: streaming(['fine'], 'fine') })
  r.stateMachine.setState(STATES.ERROR)
  assert.equal(await r.controller.submitText('try again'), 'fine')
  r.stateMachine.setState(STATES.INTERRUPTED, { force: true })
  assert.equal(await r.controller.submitText('and again'), 'fine')
})

test('interrupting a reply that is still streaming stops it cleanly', async () => {
  let started
  const startedPromise = new Promise((resolve) => (started = resolve))
  const r = rig({
    stream: (_text, { signal, onEvent }) =>
      new Promise((_resolve, reject) => {
        onEvent({ event: 'token', data: { token: 'partial ' } })
        started()
        signal.addEventListener('abort', () => reject(abortError()))
      })
  })
  const turn = r.controller.submitText('long question')
  await startedPromise
  await r.controller.interrupt()
  const reply = await turn

  assert.equal(reply, null)
  assert.ok(r.events.includes('turn:interrupt'))
  assert.ok(!r.events.includes('ai:response'), 'a stopped reply is not reported as a finished one')
  assert.equal(r.stateMachine.getState(), STATES.IDLE)
})

test('a spoken turn still ends the old way (requestReply is untouched)', async () => {
  const r = rig({ stream: streaming(['hey'], 'hey') })
  const reply = await r.controller.requestReply('hello')
  assert.equal(reply, 'hey')
  assert.notEqual(r.stateMachine.getState(), STATES.IDLE, 'the caller (the voice flow) still decides what comes next')
  assert.ok(!r.visited.includes(STATES.IDLE), 'requestReply itself never returns to idle')
})
