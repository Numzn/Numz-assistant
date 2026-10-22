import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as canonical from '../server/sessions/assistantStates.js'
import { ASSISTANT_STATES, isValidAssistantState } from '../server/sessions/sessionService.js'
import { STATE_GROUPS, STATES, createStateMachine } from '../src/assistant/stateMachine.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

// ---- one definition, and what keeps it shareable ---------------------------------------------------------------

test('there is one list: the server and the browser hold the very same object and the very same check', () => {
  assert.equal(ASSISTANT_STATES, canonical.ASSISTANT_STATES)
  assert.equal(STATES, canonical.ASSISTANT_STATES)
  assert.equal(isValidAssistantState, canonical.isValidAssistantState)
})

test('every state in the list has an interface group and somewhere to go, so a state added there cannot be half-added', () => {
  const groups = new Set(Object.values(STATE_GROUPS))
  for (const state of Object.values(canonical.ASSISTANT_STATES)) {
    const group = createStateMachine(state).getMeta()?.group
    assert.ok(groups.has(group), `${state} has no interface group`)
    const exits = Object.values(canonical.ASSISTANT_STATES).filter((to) => to !== state && createStateMachine(state).canTransition(to))
    assert.ok(exits.length > 0, `${state} has no allowed moves`)
  }
})

test('the shared file imports nothing, so it is as valid in the browser bundle as under Node', () => {
  const source = readFileSync(join(ROOT, 'server/sessions/assistantStates.js'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\bimport\b/, 'no import of any kind (static or dynamic)')
  assert.doesNotMatch(code, /\brequire\s*\(/)
  assert.doesNotMatch(code, /\bprocess\b|\bBuffer\b|\bglobalThis\.window\b|\bdocument\b/)
})

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.js$/.test(name) && !/\.test\.js$/.test(name) ? [path] : []
  })
}

const importsOf = (file) => [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])

test('the browser reaches into server/ for this one file and nothing else; the server never reaches into src/', () => {
  const crossing = []
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    for (const target of importsOf(file)) if (/(^|\/)server\//.test(target)) crossing.push(`${relative(ROOT, file)} -> ${target}`)
  }
  assert.deepEqual(crossing, ['src/assistant/stateMachine.js -> ../../server/sessions/assistantStates.js'])

  for (const file of sourceFiles(join(ROOT, 'server'))) {
    for (const target of importsOf(file)) assert.doesNotMatch(target, /(^|\/)src\//, `${relative(ROOT, file)} imports ${target}`)
  }
})

test('the production image still has what sharing relies on: the build stage sees the whole repository, the runtime stage gets server/', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile.production'), 'utf8')
  const [buildStage, runtimeStage] = dockerfile.split(/^FROM /m).slice(1)
  assert.match(buildStage, /^COPY \. \.$/m, 'the build stage copies the whole repository, so Vite can bundle the shared file')
  assert.match(runtimeStage, /^COPY server \.\/server$/m, 'the runtime stage copies server/, so the server finds the shared file')
  const ignored = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n').map((line) => line.trim())
  assert.ok(!ignored.some((line) => /^\/?server\/?$/.test(line)), '.dockerignore must not drop server/')
})
