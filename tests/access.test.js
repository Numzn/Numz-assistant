import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AccessError,
  createAccessApi,
  createAccessController,
  describeLoginError,
  isAssistantRefusal,
  watchForUnauthorized
} from '../src/interfaces/auth/access.js'

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
  assert.deepEqual(controller.getState(), { phase: 'open', error: '', canLock: false })
})

test('a code is needed and the user is not unlocked: the card appears', async () => {
  const { controller } = controllerRig({ status: { required: true, misconfigured: false, authenticated: false } })
  await controller.start()
  assert.equal(controller.getState().phase, 'needed')
})

test('already unlocked: no card, and the Lock button is offered', async () => {
  const { controller } = controllerRig({ status: { required: true, misconfigured: false, authenticated: true } })
  await controller.start()
  assert.deepEqual(controller.getState(), { phase: 'open', error: '', canLock: true })
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
  assert.deepEqual(controller.getState(), { phase: 'open', error: '', canLock: true })
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
  assert.deepEqual(controller.getState(), { phase: 'needed', error: '', canLock: false })
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
