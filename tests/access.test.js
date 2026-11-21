import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AccessError,
  createAccessApi,
  createAccessController,
  describeLoginError,
  describeNotice,
  installCsrfHeader,
  isAssistantRefusal,
  watchForUnauthorized
} from '../src/interfaces/auth/access.js'
import { BASE, withBase } from '../src/core/apiPaths.js'

function apiRig(responses) {
  const calls = []
  const queue = [...responses]
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body, credentials: init?.credentials })
    const next = queue.shift()
    if (next instanceof Error) throw next
    const { status = 200, body } = next
    return { status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
  }
  return { api: createAccessApi({ fetchFn }), calls }
}

test('status, login and logout call the auth routes, sending cookies, and login sends only the code', async () => {
  const { api, calls } = apiRig([{ body: { required: true, authenticated: false } }, { body: { authenticated: true } }, { status: 204 }])
  assert.deepEqual(await api.status(), { required: true, authenticated: false })
  assert.deepEqual(await api.login('open sesame 123'), { authenticated: true })
  assert.equal(await api.logout(), true)
  assert.deepEqual(
    calls.map((c) => [c.method, c.url]),
    [['GET', '/api/v1/assistant/auth/status'], ['POST', '/api/v1/assistant/auth/login'], ['POST', '/api/v1/assistant/auth/logout']]
  )
  assert.deepEqual(JSON.parse(calls[1].body), { code: 'open sesame 123' })
  assert.ok(calls.every((c) => c.credentials === 'same-origin'))
})

test('failures carry the status and the server code; a network failure is its own thing', async () => {
  const { api } = apiRig([{ status: 401, body: { error: 'That is not the access code', code: 'wrong-code' } }, new Error('offline')])
  await assert.rejects(api.login('x'), (err) => err instanceof AccessError && err.status === 401 && err.code === 'wrong-code')
  await assert.rejects(api.status(), (err) => err.code === 'network' && err.status === 0)
})

test('a refusal is a 401 on an assistant URL, and nothing else', () => {
  assert.equal(isAssistantRefusal('/api/v1/assistant/sessions', 401), true)
  assert.equal(isAssistantRefusal('/api/v1/assistant/chat/stream', 401), true)
  assert.equal(isAssistantRefusal('/api/v1/assistant/conversations?limit=1', 401), true)
  assert.equal(isAssistantRefusal('/api/v1/assistant/auth/login', 401), false, 'a wrong code is handled by the card, not a new card')
  assert.equal(isAssistantRefusal('/api/v1/assistant/auth/status', 401), false)
  assert.equal(isAssistantRefusal('/api/v1/meetings/launch', 401), false, 'the meeting API has its own codes')
  assert.equal(isAssistantRefusal('/api/v1/health', 401), false)
  assert.equal(isAssistantRefusal('/api/v1/assistant/sessions', 200), false)
  assert.equal(isAssistantRefusal('/api/v1/assistant/sessions', 500), false)
  assert.equal(isAssistantRefusal('/api/v1/assistant/sessions', 503), false)
  assert.equal(isAssistantRefusal('not a url at all \u0000', 401), false)
})

function fakeTarget(answer) {
  const target = { calls: [], fetch: async (input, init) => (target.calls.push([input, init]), answer(input)) }
  return target
}

test('the watcher reports a refused assistant request and passes the response through untouched', async () => {
  const response = { status: 401, ok: false, marker: 'same object' }
  const target = fakeTarget(() => response)
  let refusals = 0
  watchForUnauthorized(target, () => (refusals += 1))
  const got = await target.fetch('/api/v1/assistant/chat', { method: 'POST' })
  assert.equal(got, response, 'the very same response')
  assert.equal(refusals, 1)
  assert.deepEqual(target.calls[0], ['/api/v1/assistant/chat', { method: 'POST' }], 'the request is passed on unchanged')
})

test('the watcher stays quiet for everything else', async () => {
  const answers = new Map([
    ['/api/v1/assistant/chat', { status: 200 }],
    ['/api/v1/assistant/auth/login', { status: 401 }],
    ['/api/v1/meetings/launch', { status: 401 }],
    ['/api/v1/assistant/stt', { status: 500 }]
  ])
  const target = fakeTarget((input) => answers.get(input))
  let refusals = 0
  watchForUnauthorized(target, () => (refusals += 1))
  for (const url of answers.keys()) await target.fetch(url)
  assert.equal(refusals, 0)
})

test('the watcher understands a Request object, and a failing callback never breaks the request', async () => {
  const target = fakeTarget(() => ({ status: 401 }))
  watchForUnauthorized(target, () => {
    throw new Error('callback bug')
  })
  const response = await target.fetch({ url: '/api/v1/assistant/sessions' })
  assert.equal(response.status, 401)
})

test('the watcher can be removed', async () => {
  const target = fakeTarget(() => ({ status: 401 }))
  const original = target.fetch
  let refusals = 0
  const stop = watchForUnauthorized(target, () => (refusals += 1))
  stop()
  assert.equal(target.fetch, original)
  await target.fetch('/api/v1/assistant/sessions')
  assert.equal(refusals, 0)
})

test('login errors say what is wrong', () => {
  assert.match(describeLoginError({ status: 401 }), /not the access code/)
  assert.match(describeLoginError({ status: 429 }), /wait a minute/i)
  assert.match(describeLoginError({ status: 503 }), /not set up correctly/)
  assert.match(describeLoginError(new AccessError('x')), /Could not reach the server/)
})

// ---- the controller -----------------------------------------------------------------------------------------

function controllerRig(answers) {
  const calls = { login: [], logout: 0, unlocked: 0 }
  const api = {
    status: async () => {
      const next = answers.status
      if (next instanceof Error) throw next
      return next
    },
    login: async (code) => {
      calls.login.push(code)
      const next = answers.login
      if (next instanceof Error) throw next
      return next
    },
    logout: async () => {
      calls.logout += 1
    }
  }
  return { controller: createAccessController({ api, onUnlocked: () => (calls.unlocked += 1) }), calls }
}

test('no code needed: the card never appears', async () => {
  const { controller } = controllerRig({ status: { required: false, misconfigured: false, authenticated: true } })
  await controller.start()
  assert.deepEqual(controller.getState(), { phase: 'open', error: '', canLock: false, mode: 'code', user: null, notice: '', loginUrl: '' })
})

test('a code is needed and the user is not unlocked: the card appears', async () => {
  const { controller } = controllerRig({ status: { required: true, misconfigured: false, authenticated: false } })
  await controller.start()
  assert.equal(controller.getState().phase, 'needed')
})

test('already unlocked: no card, and the Lock button is offered', async () => {
  const { controller } = controllerRig({ status: { required: true, misconfigured: false, authenticated: true } })
  await controller.start()
  assert.deepEqual(controller.getState(), { phase: 'open', error: '', canLock: true, mode: 'code', user: null, notice: '', loginUrl: '' })
})

test('a server that is set up wrongly is shown as locked, with no way to type a code', async () => {
  const { controller, calls } = controllerRig({ status: { required: true, misconfigured: true, authenticated: false } })
  await controller.start()
  assert.equal(controller.getState().phase, 'misconfigured')
  assert.equal(await controller.submit('anything at all'), false)
  assert.deepEqual(calls.login, [], 'nothing is sent')
})

test('if the server cannot be asked, the app is left alone (its own requests will say what is wrong)', async () => {
  const { controller } = controllerRig({ status: new AccessError('offline') })
  await controller.start()
  assert.equal(controller.getState().phase, 'open')
})

test('the right code unlocks and reloads; the code is trimmed and sent once', async () => {
  const { controller, calls } = controllerRig({ status: { required: true, authenticated: false }, login: { authenticated: true } })
  await controller.start()
  assert.equal(await controller.submit('  my access code  '), true)
  assert.deepEqual(calls.login, ['my access code'])
  assert.equal(calls.unlocked, 1)
  assert.deepEqual(controller.getState(), { phase: 'open', error: '', canLock: true, mode: 'code', user: null, notice: '', loginUrl: '' })
})

test('a wrong code keeps the card open with a message, and does not reload', async () => {
  const { controller, calls } = controllerRig({ status: { required: true, authenticated: false }, login: new AccessError('x', { status: 401 }) })
  await controller.start()
  assert.equal(await controller.submit('nope'), false)
  assert.equal(controller.getState().phase, 'needed')
  assert.match(controller.getState().error, /not the access code/)
  assert.equal(calls.unlocked, 0)
})

test('too many tries and a mis-set server are reported as such', async () => {
  const tooMany = controllerRig({ status: { required: true, authenticated: false }, login: new AccessError('x', { status: 429 }) })
  await tooMany.controller.start()
  await tooMany.controller.submit('nope')
  assert.match(tooMany.controller.getState().error, /wait a minute/i)
  const broken = controllerRig({ status: { required: true, authenticated: false }, login: new AccessError('x', { status: 503 }) })
  await broken.controller.start()
  await broken.controller.submit('whatever')
  assert.equal(broken.controller.getState().phase, 'misconfigured')
})

test('an empty code is not sent', async () => {
  const { controller, calls } = controllerRig({ status: { required: true, authenticated: false } })
  await controller.start()
  assert.equal(await controller.submit('   '), false)
  assert.deepEqual(calls.login, [])
  assert.match(controller.getState().error, /Type the access code/)
})

test('a refusal seen mid-session shows the card once, and does not disturb a login in progress', async () => {
  const { controller } = controllerRig({ status: { required: true, authenticated: true } })
  await controller.start()
  assert.equal(controller.getState().phase, 'open')
  controller.require()
  assert.deepEqual(controller.getState(), { phase: 'needed', error: '', canLock: false, mode: 'code', user: null, notice: '', loginUrl: '' })
  const states = []
  controller.subscribe((s) => states.push(s.phase))
  controller.require()
  assert.deepEqual(states, [], 'repeated refusals change nothing')
})

test('lock signs out and reloads', async () => {
  const { controller, calls } = controllerRig({ status: { required: true, authenticated: true } })
  await controller.lock()
  assert.equal(calls.logout, 1)
  assert.equal(calls.unlocked, 1)
})


// ---- signing in with Google (mode 'broker') ------------------------------------------------------------------------

const BROKER_OUT = { mode: 'broker', required: true, misconfigured: false, authenticated: false, reason: 'session-required', loginUrl: '/ai/auth/login' }
const BROKER_IN = { mode: 'broker', required: true, misconfigured: false, authenticated: true, loginUrl: '/ai/auth/login', csrf: 'tok-1', user: { id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'admin', capabilities: ['chat'] } }

function brokerRig(statuses, { search = '' } = {}) {
  const calls = { logout: 0, unlocked: 0, login: 0, tidied: 0 }
  const queue = [...statuses]
  const api = {
    status: async () => (queue.length > 1 ? queue.shift() : queue[0]),
    login: async () => {
      calls.login += 1
    },
    logout: async () => {
      calls.logout += 1
    }
  }
  const controller = createAccessController({ api, onUnlocked: () => (calls.unlocked += 1), search: () => search, tidy: () => (calls.tidied += 1) })
  return { controller, calls }
}

test('the app lives at its base path when built for one, and at the root otherwise', () => {
  assert.equal(BASE, '', 'the tests run without a base path')
  assert.equal(withBase('/api/v1/x'), '/api/v1/x')
})

test('signed out: the card asks to continue with Google, says why, and offers the way in', async () => {
  const { controller } = brokerRig([BROKER_OUT])
  await controller.start()
  assert.deepEqual(controller.getState(), { phase: 'needed', error: '', canLock: false, mode: 'broker', user: null, notice: '', loginUrl: '/ai/auth/login' })
})

test('signed in: no card, the person is known, and sign-out is offered', async () => {
  const { controller } = brokerRig([BROKER_IN])
  await controller.start()
  const state = controller.getState()
  assert.equal(state.phase, 'open')
  assert.equal(state.canLock, true)
  assert.equal(state.user.email, 'ada@example.com')
})

test('coming back from a failed or refused sign-in says so, once, and tidies the address', async () => {
  for (const [search, expected] of [['?auth=denied', /not approved/], ['?auth=failed', /did not finish/], ['?auth=unavailable', /could not reach the sign-in service/], ['?x=1&auth=denied', /not approved/]]) {
    const { controller, calls } = brokerRig([BROKER_OUT], { search })
    await controller.start()
    assert.match(controller.getState().notice, expected, search)
    assert.equal(calls.tidied, 1)
  }
  const { controller } = brokerRig([BROKER_OUT], { search: '?auth=<script>' })
  await controller.start()
  assert.equal(controller.getState().notice, '', 'an unknown code shows nothing (and never echoes what the address said)')
})

test('a session that ended is explained: ended, removed, or the sign-in service unavailable', async () => {
  for (const [reason, expected] of [['session-expired', /session ended/], ['access-revoked', /access to NUMZ AI has ended/], ['identity-unavailable', /cannot confirm/], ['session-required', /^$/]]) {
    const { controller } = brokerRig([{ ...BROKER_OUT, reason }])
    await controller.start()
    assert.match(controller.getState().notice, expected, reason)
  }
  assert.equal(describeNotice('nonsense'), '')
})

test('a refusal in the middle of using the app asks for sign-in at once and then learns why', async () => {
  const { controller } = brokerRig([BROKER_IN, { ...BROKER_OUT, reason: 'session-expired' }])
  await controller.start()
  assert.equal(controller.getState().phase, 'open')
  controller.require()
  assert.equal(controller.getState().phase, 'needed', 'immediately')
  assert.equal(controller.getState().user, null)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.match(controller.getState().notice, /session ended/)
  controller.require() // a second refusal changes nothing
  assert.equal(controller.getState().phase, 'needed')
})

test('there is no code to type in this mode, and signing out signs out this device and reloads', async () => {
  const { controller, calls } = brokerRig([BROKER_OUT])
  await controller.start()
  assert.equal(await controller.submit('anything'), false)
  assert.equal(calls.login, 0)
  const signedIn = brokerRig([BROKER_IN])
  await signedIn.controller.start()
  await signedIn.controller.lock()
  assert.deepEqual([signedIn.calls.logout, signedIn.calls.unlocked], [1, 1])
})

test('the page keeps the session\'s CSRF token from the status answer and sends it with sign-out', async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers })
    return url.endsWith('/status') ? { status: 200, ok: true, text: async () => JSON.stringify(BROKER_IN) } : { status: 204, ok: true, text: async () => '' }
  }
  const api = createAccessApi({ fetchFn })
  assert.equal(api.csrfToken(), '')
  await api.status()
  assert.equal(api.csrfToken(), 'tok-1')
  await api.logout()
  assert.equal(calls[1].headers['X-CSRF-Token'], 'tok-1')
})

function fetchRig() {
  const seen = []
  const target = { fetch: async (input, init) => (seen.push({ input, init }), { status: 200 }) }
  return { target, seen }
}
const headerOf = (init) => new Headers(init?.headers).get('x-csrf-token')

test('the CSRF token goes on changes to the app\'s own API and on nothing else', async () => {
  const { target, seen } = fetchRig()
  const undo = installCsrfHeader(target, () => 'tok-9')
  await target.fetch('/api/v1/assistant/chat', { method: 'POST', body: '{}' })
  await target.fetch('/api/v1/assistant/conversations/abc', { method: 'DELETE' })
  await target.fetch('/api/v1/assistant/state', { method: 'patch', headers: { 'Content-Type': 'application/json' } })
  assert.deepEqual(seen.map((s) => headerOf(s.init)), ['tok-9', 'tok-9', 'tok-9'])
  assert.equal(new Headers(seen[2].init.headers).get('content-type'), 'application/json', 'what the caller set is kept')
  seen.length = 0
  await target.fetch('/api/v1/assistant/conversations')
  await target.fetch('/api/v1/assistant/conversations', { method: 'GET' })
  await target.fetch('/style.css', { method: 'POST' })
  await target.fetch('https://evil.example/api/v1/assistant/chat', { method: 'POST' })
  await target.fetch('//evil.example/api/v1/assistant/chat', { method: 'POST' })
  assert.deepEqual(seen.map((s) => headerOf(s.init)), [null, null, null, null, null], 'reads, other files and other sites never get the token')
  undo()
  await target.fetch('/api/v1/assistant/chat', { method: 'POST' })
  assert.equal(headerOf(seen.at(-1).init), null)
})

test('a change asked for before the token is known waits for it, then goes; if it never comes the request still goes (and the server says no)', async () => {
  const { target, seen } = fetchRig()
  let token = ''
  let release
  const ready = new Promise((resolve) => (release = resolve))
  installCsrfHeader(target, () => token, () => ready)
  const pending = target.fetch('/api/v1/assistant/sessions', { method: 'POST' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(seen.length, 0, 'held back')
  token = 'tok-late'
  release()
  await pending
  assert.equal(headerOf(seen[0].init), 'tok-late')
  // no sign-in mode with tokens at all (the shared code): nothing to wait for, nothing added
  const plain = fetchRig()
  installCsrfHeader(plain.target, () => '')
  await plain.target.fetch('/api/v1/assistant/chat', { method: 'POST' })
  assert.equal(headerOf(plain.seen[0].init), null)
})

test('a Request object is understood too', async () => {
  const { target, seen } = fetchRig()
  installCsrfHeader(target, () => 'tok-r')
  await target.fetch(new Request('http://placeholder.invalid/api/v1/assistant/chat', { method: 'POST', body: '{}' }))
  assert.equal(headerOf(seen[0].init), 'tok-r')
})
