import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'
import { createAssistantAuth } from './assistantAuth.js'
import { createMeetingAuth } from './meetingAuth.js'

/**
 * What the two auth modules put on the wire, pinned byte for byte with a frozen clock.
 *
 * Both modules sign a stateless session cookie (v1.<expires>.<hmac>) and throttle wrong codes. The signing key,
 * the cookie flags and the throttle numbers are what keep every signed-in browser signed in across a deploy and
 * keep the brute-force limits where they are. The tests in assistantAuth.test.js and meetingAuth.test.js prove the
 * behaviour; these prove the exact bytes, so a refactor that quietly changes a key-derivation string, a flag, a
 * Retry-After rule or a window boundary cannot pass. If one of these has to change on purpose, that is a
 * deliberate wire-format change (it signs everyone out) and should say so in its commit.
 */

const quiet = { warn() {}, error() {}, info() {}, log() {} }
const NOW = 1_000_000_000_000 // 2001-09-09T01:46:40Z, so the expiry below is exactly NOW/1000 + ttl

// ---- assistant access code ----------------------------------------------------------------------------------

const ASSISTANT_CODE = 'correct horse battery staple'
const ASSISTANT_TOKEN = 'v1.1000043200.980d08783330197fad205020791d74f53fbe666777883d2437c4abf5d68a2b47'

async function serveAssistant(clock) {
  const auth = createAssistantAuth({ accessCode: ASSISTANT_CODE, ttlSeconds: 43200, clock: () => clock.now, logger: quiet })
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.id = 'wire'
    next()
  })
  app.use('/auth', auth.router())
  app.use('/protected', auth.requireAccess, (_req, res) => res.json({ ok: true }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, { method = 'GET', body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    })
  return { call, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('assistant: the login cookie, the logout cookie and the 401 challenge are byte-for-byte what they were', async () => {
  const s = await serveAssistant({ now: NOW })
  try {
    const login = await s.call('/auth/login', { method: 'POST', body: { code: ASSISTANT_CODE } })
    const plain = `numz_assistant_session=${ASSISTANT_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`
    assert.equal(login.headers.get('set-cookie'), plain)
    assert.equal(login.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await login.json(), { authenticated: true, expiresAt: '2001-09-09T13:46:40.000Z' })

    const secure = await s.call('/auth/login', { method: 'POST', body: { code: ASSISTANT_CODE }, headers: { 'x-forwarded-proto': 'https' } })
    assert.equal(secure.headers.get('set-cookie'), `${plain}; Secure`)

    const out = await s.call('/auth/logout', { method: 'POST' })
    assert.equal(out.headers.get('set-cookie'), 'numz_assistant_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')

    const refused = await s.call('/protected')
    assert.equal(refused.status, 401)
    assert.equal(refused.headers.get('www-authenticate'), 'Cookie', 'a refused request is challenged for a cookie')
    const wrong = await s.call('/auth/login', { method: 'POST', body: { code: 'not the code' } })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.headers.get('www-authenticate'), null, 'a wrong code at the login itself is not a challenge')
  } finally {
    await s.close()
  }
})

test('assistant: the token minted a moment ago is accepted, to the second, exactly until its expiry', async () => {
  const clock = { now: NOW }
  const s = await serveAssistant(clock)
  try {
    const cookie = `numz_assistant_session=${ASSISTANT_TOKEN}`
    clock.now = NOW + 43_199_000
    assert.equal((await s.call('/protected', { headers: { cookie } })).status, 200)
    clock.now = NOW + 43_200_000
    assert.equal((await s.call('/protected', { headers: { cookie } })).status, 401)
  } finally {
    await s.close()
  }
})

test('assistant: ten wrong codes lock for exactly a minute from the CHECK, and the wait is always told as 60 seconds', async () => {
  const clock = { now: NOW }
  const s = await serveAssistant(clock)
  try {
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await s.call('/auth/login', { method: 'POST', body: { code: `wrong ${i}` } })).status, 401)
      clock.now += 1000
    }
    // The first failure was at NOW; the clock is now NOW + 10 s. The window is counted per failure.
    const locked = await s.call('/auth/login', { method: 'POST', body: { code: ASSISTANT_CODE } })
    assert.equal(locked.status, 429)
    assert.equal(locked.headers.get('retry-after'), '60', 'fixed, not computed from the oldest failure')
    assert.equal(locked.headers.get('www-authenticate'), null)

    clock.now = NOW + 59_999
    assert.equal((await s.call('/auth/login', { method: 'POST', body: { code: ASSISTANT_CODE } })).status, 429, 'one millisecond early')
    clock.now = NOW + 60_000
    assert.equal((await s.call('/auth/login', { method: 'POST', body: { code: ASSISTANT_CODE } })).status, 200, 'the first failure has aged out')
  } finally {
    await s.close()
  }
})

// ---- meeting launch session and launch throttle ------------------------------------------------------------

const LAUNCH_CODE = 'launch-code-long-enough'
const LAUNCH_TOKEN = 'v1.1000028800.e897835983b136db36715ac5021c6a47b4aaf61aacfbe2592a1c06f14d7c5c25'

function meetingAuth(overrides = {}) {
  return createMeetingAuth({
    adminToken: 'a'.repeat(40),
    ticketSecret: 'b'.repeat(40),
    launchCode: LAUNCH_CODE,
    launchSessionTtlSeconds: 28800,
    clock: () => NOW,
    logger: quiet,
    ...overrides
  })
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    appended: [],
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value
      return this
    },
    append(name, value) {
      this.appended.push([name.toLowerCase(), value])
      return this
    }
  }
  return res
}

function pass(middleware, req) {
  const res = fakeResponse()
  let passed = false
  middleware({ id: 'wire', params: {}, ...req }, res, () => {
    passed = true
  })
  return { res, passed }
}

test('meeting: the launch session cookie is byte-for-byte what it was, scoped to the meeting API', () => {
  const plain = `numz_launch_session=${LAUNCH_TOKEN}; Path=/api/v1/meetings; HttpOnly; SameSite=Strict; Max-Age=28800`

  const started = fakeResponse()
  const result = meetingAuth().startLaunchSession({ headers: {} }, started)
  assert.deepEqual(started.appended, [['set-cookie', plain]])
  assert.equal(started.headers['cache-control'], 'no-store')
  assert.deepEqual(result, { expiresAt: '2001-09-09T09:46:40.000Z' })

  const secure = fakeResponse()
  meetingAuth().startLaunchSession({ headers: { 'x-forwarded-proto': 'https' } }, secure)
  assert.deepEqual(secure.appended, [['set-cookie', `${plain}; Secure`]])

  const ended = fakeResponse()
  meetingAuth().endLaunchSession({ headers: {} }, ended)
  assert.deepEqual(ended.appended, [['set-cookie', 'numz_launch_session=; Path=/api/v1/meetings; HttpOnly; SameSite=Strict; Max-Age=0']])
})

test('meeting: that token is a launch credential until exactly its expiry, and only for the same launch code and ticket secret', () => {
  const cookie = { cookie: `numz_launch_session=${LAUNCH_TOKEN}` }
  const at = (ms, auth = meetingAuth({ clock: () => ms })) => auth.launchSessionStatus({ headers: cookie })
  assert.equal(at(NOW).authenticated, true)
  assert.equal(at(NOW + 28_799_000).authenticated, true)
  assert.equal(at(NOW + 28_800_000).authenticated, false)

  // The key is derived from BOTH secrets: change either and the old cookie is void.
  assert.equal(at(NOW, meetingAuth({ launchCode: 'a-different-launch-code' })).authenticated, false)
  assert.equal(at(NOW, meetingAuth({ ticketSecret: 'c'.repeat(40) })).authenticated, false)
})

test('the two modules never accept each other\'s session: the keys are separate', () => {
  const assistantToken = ASSISTANT_TOKEN.replace('1000043200', '1000028800')
  const asLaunchCookie = meetingAuth().launchSessionStatus({ headers: { cookie: `numz_launch_session=${assistantToken}` } })
  assert.equal(asLaunchCookie.authenticated, false, 'an assistant-shaped token is not a launch session')

  const assistant = createAssistantAuth({ accessCode: ASSISTANT_CODE, clock: () => NOW, logger: quiet })
  assert.equal(assistant.check({ headers: { cookie: `numz_assistant_session=${LAUNCH_TOKEN}` } }).ok, false, 'a launch token is not an assistant session')
})

test('meeting: the wait after ten wrong launch codes is counted from the oldest failure, and the window edge is exact', () => {
  let now = NOW
  const gate = meetingAuth({ clock: () => now }).requireLaunchCode()
  const attempt = (code) => pass(gate, { headers: { 'x-meeting-launch-code': code } })

  for (let i = 0; i < 10; i += 1) {
    assert.equal(attempt('wrong').res.statusCode, 401)
    now += 1000
  }
  const locked = attempt(LAUNCH_CODE)
  assert.equal(locked.res.statusCode, 429)
  assert.equal(locked.res.headers['retry-after'], '50', 'oldest failure was 10 s ago: 60 - 10')
  assert.equal(locked.res.body.code, 'too-many-attempts')

  now = NOW + 59_999
  const early = attempt(LAUNCH_CODE)
  assert.equal(early.res.statusCode, 429)
  assert.equal(early.res.headers['retry-after'], '1', 'never less than one second')

  now = NOW + 60_000
  assert.equal(attempt(LAUNCH_CODE).passed, true, 'the oldest failure has aged out')
})

test('meeting: a missing or wrong bearer is challenged with Bearer; a forbidden ticket and a launch refusal are not', () => {
  const auth = meetingAuth()
  const missing = pass(auth.requireAdmin(), { headers: {} })
  assert.equal(missing.res.statusCode, 401)
  assert.equal(missing.res.headers['www-authenticate'], 'Bearer')
  assert.deepEqual(missing.res.body, { error: 'Valid credentials are required', code: 'auth-required', requestId: 'wire' })

  const wrong = pass(auth.requireAdmin(), { headers: { authorization: 'Bearer nope' } })
  assert.equal(wrong.res.headers['www-authenticate'], 'Bearer')

  const ticket = auth.issueTicket('00000000-0000-4000-8000-000000000001').token
  const forbidden = pass(auth.requireAdmin(), { headers: { authorization: `Bearer ${ticket}` } })
  assert.equal(forbidden.res.statusCode, 403)
  assert.equal(forbidden.res.headers['www-authenticate'], undefined)

  const noCode = pass(auth.requireLaunchCode(), { headers: {} })
  assert.equal(noCode.res.statusCode, 401)
  assert.equal(noCode.res.headers['www-authenticate'], undefined)
})

// ---- malformed cookies ---------------------------------------------------------------------------------------

test('a cookie with a forged signature made of multi-byte characters is refused by both modules, never thrown on', () => {
  // The right length (64 characters) and a live expiry, but 128 bytes. Node hands a client's bytes 0x80-0xFF to
  // the app as characters, so this can arrive from outside; it used to end as a 500 instead of a 401.
  const forged = '\u00e9'.repeat(64)
  const assistant = createAssistantAuth({ accessCode: ASSISTANT_CODE, clock: () => NOW, logger: quiet })
  const result = assistant.check({ headers: { cookie: `numz_assistant_session=v1.1000000600.${forged}` } })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)

  const status = meetingAuth().launchSessionStatus({ headers: { cookie: `numz_launch_session=v1.1000000600.${forged}` } })
  assert.deepEqual(status, { available: true, authenticated: false })
  const gate = pass(meetingAuth().requireLaunchAccess(), { headers: { cookie: `numz_launch_session=v1.1000000600.${forged}` } })
  assert.equal(gate.passed, false)
  assert.equal(gate.res.statusCode, 401, 'falls through to the launch-code check: no code, so 401')
})
