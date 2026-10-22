import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'
import { errorHandler } from '../http/errorHandler.js'
import { assistantRouter } from '../routes/assistant.js'
import { sessionService } from '../sessions/sessionService.js'
import { STATES as BROWSER_STATES, createStateMachine } from '../../src/assistant/stateMachine.js'

/**
 * The two routes that set the assistant's state, PATCH /state (the shared "legacy" session) and
 * PATCH /sessions/:sessionId/state, driven over real HTTP with the real router and the real error handler.
 *
 * The state names come from the BROWSER's own list on purpose: every state the browser can be in is a state it
 * asks the server to record, so each must be accepted here, and anything the browser's state machine refuses must
 * be refused here too.
 */

const quiet = { warn() {}, error() {}, info() {}, log() {} }

const EXPECTED_STATES = [
  'IDLE',
  'LISTENING',
  'TRANSCRIBING',
  'PROCESSING',
  'THINKING',
  'RETRIEVING_MEMORY',
  'TOOL_EXECUTION',
  'GENERATING',
  'SPEAKING',
  'INTERRUPTED',
  'ERROR_RECOVERY',
  'ERROR'
]

// Strings that are not states. Several are what a lookup by property name (rather than by membership) would let in.
const NOT_STATES = [
  'idle',
  'Idle',
  'BOGUS',
  '',
  ' IDLE',
  'IDLE ',
  'IDLE\n',
  'IDLE,LISTENING',
  'STREAMING', // the animator's render key, not an assistant state
  'ERROR_RECOVERY2',
  'null',
  'undefined',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf'
]

async function serve() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.id = 'state-test'
    next()
  })
  app.use('/api/v1/assistant', assistantRouter)
  app.use(errorHandler({ logger: quiet }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/v1/assistant`
  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : null }
  }
  return { call, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('the browser has exactly the twelve states the server was built around', () => {
  assert.deepEqual(Object.values(BROWSER_STATES), EXPECTED_STATES)
})

test('PATCH /state accepts every state the browser can be in, and GET /state reports it', async () => {
  const s = await serve()
  try {
    for (const state of Object.values(BROWSER_STATES)) {
      const patched = await s.call('/state', { method: 'PATCH', body: { state } })
      assert.equal(patched.status, 200, state)
      assert.equal(patched.json.state, state)
      assert.equal(typeof patched.json.sessionId, 'string')
      assert.deepEqual(Object.keys(patched.json).sort(), ['createdAt', 'sessionId', 'state', 'updatedAt'])
      assert.equal((await s.call('/state')).json.state, state)
    }
  } finally {
    await s.close()
  }
})

test('PATCH /sessions/:sessionId/state accepts every state the browser can be in, on that session only', async () => {
  const s = await serve()
  try {
    const mine = (await s.call('/sessions', { method: 'POST', body: {} })).json.sessionId
    const other = (await s.call('/sessions', { method: 'POST', body: {} })).json.sessionId
    for (const state of Object.values(BROWSER_STATES)) {
      const patched = await s.call(`/sessions/${mine}/state`, { method: 'PATCH', body: { state } })
      assert.equal(patched.status, 200, state)
      assert.equal(patched.json.state, state)
      assert.equal(patched.json.sessionId, mine)
      assert.equal((await s.call(`/sessions/${mine}/state`)).json.state, state)
    }
    assert.equal((await s.call(`/sessions/${other}/state`)).json.state, 'IDLE', 'another session is not moved')
  } finally {
    await s.close()
  }
})

test('both routes refuse a string that is not a state with 400 and the same words, and change nothing', async () => {
  const s = await serve()
  try {
    const session = (await s.call('/sessions', { method: 'POST', body: {} })).json.sessionId
    await s.call('/state', { method: 'PATCH', body: { state: 'LISTENING' } })
    await s.call(`/sessions/${session}/state`, { method: 'PATCH', body: { state: 'THINKING' } })
    for (const state of NOT_STATES) {
      for (const path of ['/state', `/sessions/${session}/state`]) {
        const res = await s.call(path, { method: 'PATCH', body: { state } })
        assert.equal(res.status, 400, `${path} ${JSON.stringify(state)}`)
        assert.equal(res.json.error, `Invalid state: ${state}`)
        assert.equal(res.json.requestId, 'state-test')
      }
    }
    assert.equal((await s.call('/state')).json.state, 'LISTENING', 'the shared session did not move')
    assert.equal((await s.call(`/sessions/${session}/state`)).json.state, 'THINKING', 'nor did the other')
  } finally {
    await s.close()
  }
})

test('both routes refuse a missing or non-string state with 400 and the same words', async () => {
  const s = await serve()
  try {
    const session = (await s.call('/sessions', { method: 'POST', body: {} })).json.sessionId
    for (const body of [{}, { state: null }, { state: 0 }, { state: 1 }, { state: true }, { state: ['IDLE'] }, { state: { state: 'IDLE' } }, { other: 'IDLE' }]) {
      for (const path of ['/state', `/sessions/${session}/state`]) {
        const res = await s.call(path, { method: 'PATCH', body })
        assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`)
        assert.equal(res.json.error, 'Body must include string "state"')
      }
    }
  } finally {
    await s.close()
  }
})

test('a valid state for a session that does not exist is a 404; an invalid one is a 400 before the session is looked up', async () => {
  const s = await serve()
  try {
    const missing = '00000000-0000-4000-8000-000000000000'
    const valid = await s.call(`/sessions/${missing}/state`, { method: 'PATCH', body: { state: 'IDLE' } })
    assert.equal(valid.status, 404)
    assert.equal(valid.json.error, 'Session not found')
    assert.equal(valid.json.code, 'not-found')
    const invalid = await s.call(`/sessions/${missing}/state`, { method: 'PATCH', body: { state: 'BOGUS' } })
    assert.equal(invalid.status, 400)
  } finally {
    await s.close()
  }
})

test('every browser state is a state the server will store, and the strings the server refuses are the ones the browser throws on', () => {
  for (const state of Object.values(BROWSER_STATES)) {
    const session = sessionService.createSession()
    assert.equal(sessionService.setState(session.id, state).state, state)
  }
  for (const state of NOT_STATES) {
    const session = sessionService.createSession()
    assert.throws(() => sessionService.setState(session.id, state), (err) => err.statusCode === 400, `server: ${JSON.stringify(state)}`)
    assert.throws(() => createStateMachine('IDLE').setState(state, { force: true }), /Invalid assistant state/, `browser: ${JSON.stringify(state)}`)
    assert.throws(() => createStateMachine('IDLE').canTransition(state), /Invalid assistant state/)
  }
})
