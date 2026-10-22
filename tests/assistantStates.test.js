import assert from 'node:assert/strict'
import test from 'node:test'
import { ASSISTANT_STATES, isValidAssistantState } from '../server/sessions/sessionService.js'
import { STATE_GROUPS, STATES, createStateMachine } from '../src/assistant/stateMachine.js'

/**
 * The browser's state machine and the server's session service both speak the same twelve states. These pin the
 * list, its order, what each state means to the interface (its group), and which moves the browser allows, so
 * that putting the definition in one place cannot change any of them.
 */

const EXPECTED = [
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

const GROUPS = {
  IDLE: 'READY',
  LISTENING: 'INPUT',
  TRANSCRIBING: 'INPUT',
  PROCESSING: 'RESPONSE',
  THINKING: 'RESPONSE',
  RETRIEVING_MEMORY: 'RESPONSE',
  TOOL_EXECUTION: 'RESPONSE',
  GENERATING: 'RESPONSE',
  SPEAKING: 'RESPONSE',
  INTERRUPTED: 'INTERRUPTED',
  ERROR_RECOVERY: 'ERROR',
  ERROR: 'ERROR'
}

// From each state, the OTHER states the browser lets it move to without force. Staying put is always allowed.
const MOVES = {
  IDLE: ['LISTENING', 'PROCESSING', 'THINKING', 'ERROR'],
  LISTENING: ['TRANSCRIBING', 'PROCESSING', 'THINKING', 'IDLE', 'INTERRUPTED', 'ERROR'],
  TRANSCRIBING: ['LISTENING', 'THINKING', 'PROCESSING', 'IDLE', 'ERROR'],
  PROCESSING: ['THINKING', 'RETRIEVING_MEMORY', 'TOOL_EXECUTION', 'GENERATING', 'SPEAKING', 'INTERRUPTED', 'ERROR'],
  THINKING: ['RETRIEVING_MEMORY', 'TOOL_EXECUTION', 'GENERATING', 'SPEAKING', 'INTERRUPTED', 'ERROR'],
  RETRIEVING_MEMORY: ['THINKING', 'TOOL_EXECUTION', 'GENERATING', 'INTERRUPTED', 'ERROR'],
  TOOL_EXECUTION: ['THINKING', 'GENERATING', 'INTERRUPTED', 'ERROR'],
  GENERATING: ['SPEAKING', 'INTERRUPTED', 'ERROR'],
  SPEAKING: ['LISTENING', 'IDLE', 'INTERRUPTED', 'ERROR'],
  INTERRUPTED: ['IDLE', 'LISTENING', 'ERROR_RECOVERY'],
  ERROR: ['ERROR_RECOVERY', 'IDLE'],
  ERROR_RECOVERY: ['IDLE']
}

test('the server and the browser list the same twelve states, with the same names, in the same order', () => {
  assert.deepEqual(Object.values(ASSISTANT_STATES), EXPECTED)
  assert.deepEqual(Object.values(STATES), EXPECTED)
  assert.deepEqual(Object.keys(ASSISTANT_STATES), EXPECTED, 'every key is its own value')
  assert.deepEqual(ASSISTANT_STATES, STATES)
})

test('the lists cannot be changed at run time', () => {
  for (const list of [ASSISTANT_STATES, STATES]) {
    assert.equal(Object.isFrozen(list), true)
    assert.throws(() => {
      'use strict'
      list.EXTRA = 'EXTRA'
    }, TypeError)
  }
})

test('the server and the browser accept the same states and refuse the same everything else', () => {
  const candidates = [
    ...EXPECTED,
    'idle',
    'BOGUS',
    '',
    ' IDLE',
    'STREAMING',
    '__proto__',
    'constructor',
    'toString',
    null,
    undefined,
    0,
    1,
    true,
    ['IDLE'],
    { IDLE: 'IDLE' }
  ]
  for (const candidate of candidates) {
    const server = isValidAssistantState(candidate)
    let browser = true
    try {
      createStateMachine('IDLE').canTransition(candidate)
    } catch {
      browser = false
    }
    assert.equal(server, browser, `server and browser disagree about ${JSON.stringify(candidate)}`)
    assert.equal(server, EXPECTED.includes(candidate), JSON.stringify(candidate))
  }
})

test('every state still belongs to the interface group it did, and every group is in use', () => {
  const machine = createStateMachine('IDLE')
  for (const state of EXPECTED) assert.equal(machine.getMeta(state)?.group, GROUPS[state], state)
  assert.deepEqual([...new Set(Object.values(GROUPS))].sort(), Object.values(STATE_GROUPS).sort())
})

test('the browser allows exactly the moves it did, from every state to every state', () => {
  for (const from of EXPECTED) {
    const machine = createStateMachine(from)
    for (const to of EXPECTED) {
      const allowed = to === from || MOVES[from].includes(to)
      assert.equal(machine.canTransition(to), allowed, `${from} -> ${to}`)
      if (!allowed) assert.throws(() => createStateMachine(from).setState(to), /Invalid assistant transition/)
    }
  }
})

test('a state change reports the new state, the one before, and their groups', () => {
  const events = []
  const machine = createStateMachine('IDLE', { eventBus: { emit: (type, payload) => events.push({ type, payload }) } })
  machine.setState('THINKING')
  machine.setState('SPEAKING')
  assert.deepEqual(events.map((e) => e.type), ['state:change', 'state:change'])
  assert.deepEqual(
    events.map((e) => [e.payload.previous, e.payload.state, e.payload.previousGroup, e.payload.group]),
    [
      ['IDLE', 'THINKING', 'READY', 'RESPONSE'],
      ['THINKING', 'SPEAKING', 'RESPONSE', 'RESPONSE']
    ]
  )
})
