import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import express from 'express'
import { WebSocket } from 'ws'
import { COOKIE_NAME, MIN_CODE_LENGTH, createAssistantAuth } from './assistantAuth.js'
import { createUpgradeRouter } from '../websocket/upgradeRouter.js'
import { attachSocketServer } from '../websocket/socketServer.js'

const CODE = 'correct horse battery staple'
const quiet = () => {
  const lines = []
  return { lines, warn: (m) => lines.push(m), error() {}, info() {}, log() {} }
}

async function serve({ accessCode = CODE, clock = { now: () => Date.now() }, ttlSeconds = 43200, logger = quiet() } = {}) {
  const auth = createAssistantAuth({ accessCode, ttlSeconds, clock: () => clock.now(), logger })
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.id = 'test-request'
    next()
  })
  app.get('/api/v1/health', (_req, res) => res.json({ ok: true }))
  app.use('/api/v1/assistant/auth', auth.router())
  app.use('/api/v1/assistant', auth.requireAccess, express.Router().get('/ping', (_req, res) => res.json({ pong: true })))
  const server = http.createServer(app)
  const upgrades = createUpgradeRouter(server, { logger: quiet() })
  attachSocketServer(server, { upgrades, authorize: auth.authorizeUpgrade })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/api/v1`
  async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null }
  }
  async function login(code = CODE, extra = {}) {
    const res = await call('/assistant/auth/login', { method: 'POST', body: { code }, ...extra })
    const setCookie = res.headers.get('set-cookie')
    return { ...res, setCookie, cookie: setCookie ? setCookie.split(';')[0] : null }
  }
  return { auth, call, login, port, close: () => new Promise((resolve) => server.close(resolve)), logger }
}

function openSocket(port, cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/assistant/ws`, { headers: cookie ? { Cookie: cookie } : {} })
    ws.on('open', () => {
      ws.close()
      resolve({ opened: true })
    })
    ws.on('unexpected-response', (_req, res) => {
      resolve({ opened: false, status: res.statusCode })
      res.resume()
    })
    ws.on('error', () => {})
  })
}

test('with no access code set nothing changes: the assistant stays open, and the server says so', async () => {
  const s = await serve({ accessCode: '' })
  try {
    assert.equal((await s.call('/assistant/ping')).status, 200)
    assert.deepEqual((await s.call('/assistant/auth/status')).json, { required: false, misconfigured: false, authenticated: true })
    assert.deepEqual((await s.login()).json, { required: false, authenticated: true })
    assert.ok(s.logger.lines.some((line) => /not set.*open to anyone/.test(line)), 'a warning names the open state')
  } finally {
    await s.close()
  }
})

test('with a code set, the protected routes refuse a request without the session cookie', async () => {
  const s = await serve()
  try {
    const refused = await s.call('/assistant/ping')
    assert.equal(refused.status, 401)
    assert.equal(refused.json.code, 'assistant-auth-required')
    assert.equal(refused.headers.get('www-authenticate'), 'Cookie')
    assert.deepEqual((await s.call('/assistant/auth/status')).json, { required: true, misconfigured: false, authenticated: false })
    assert.equal((await s.call('/health')).status, 200, 'the health check stays public')
  } finally {
    await s.close()
  }
})

test('a wrong, missing or non-string code is refused and sets no cookie', async () => {
  const s = await serve()
  try {
    for (const body of [{ code: 'not the code' }, { code: '' }, {}, { code: 12345 }, { code: ['a'] }, { code: null }]) {
      const res = await s.call('/assistant/auth/login', { method: 'POST', body })
      assert.equal(res.status, 401, JSON.stringify(body))
      assert.equal(res.json.code, 'wrong-code')
      assert.equal(res.headers.get('set-cookie'), null)
    }
  } finally {
    await s.close()
  }
})

test('the right code gives a hardened cookie that opens the protected routes, and the code itself is not in it', async () => {
  const s = await serve()
  try {
    const login = await s.login()
    assert.equal(login.status, 200)
    assert.equal(login.json.authenticated, true)
    assert.match(login.setCookie, new RegExp(`^${COOKIE_NAME}=v1\\.\\d+\\.[0-9a-f]{64};`))
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(login.setCookie.includes(flag), flag)
    assert.ok(!login.setCookie.includes('Secure'), 'no Secure flag on plain http (it would never be sent back)')
    assert.ok(!login.cookie.includes(CODE) && !login.cookie.includes('horse'))
    assert.equal((await s.call('/assistant/ping', { cookie: login.cookie })).json.pong, true)
    assert.equal((await s.call('/assistant/auth/status', { cookie: login.cookie })).json.authenticated, true)
  } finally {
    await s.close()
  }
})

test('over HTTPS (behind the proxy) the cookie is Secure', async () => {
  const s = await serve()
  try {
    const login = await s.login(CODE, { headers: { 'X-Forwarded-Proto': 'https' } })
    assert.ok(login.setCookie.includes('Secure'))
  } finally {
    await s.close()
  }
})

test('the code is accepted with stray spaces around it', async () => {
  const s = await serve()
  try {
    assert.equal((await s.login(`  ${CODE}\n`)).status, 200)
  } finally {
    await s.close()
  }
})

test('a tampered cookie is refused (changed signature, changed expiry, garbage)', async () => {
  const s = await serve()
  try {
    const { cookie } = await s.login()
    const [name, value] = cookie.split('=')
    const [version, expires, signature] = value.split('.')
    const flipped = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0')
    for (const bad of [
      `${name}=${version}.${expires}.${flipped}`,
      `${name}=${version}.${Number(expires) + 999999}.${signature}`,
      `${name}=${version}.${expires}`,
      `${name}=v2.${expires}.${signature}`,
      `${name}=${version}.1e9.${signature}`,
      `${name}=garbage`,
      `${name}=`,
      'other=value'
    ]) {
      assert.equal((await s.call('/assistant/ping', { cookie: bad })).status, 401, bad)
    }
  } finally {
    await s.close()
  }
})

test('a cookie expires', async () => {
  const clock = { now: () => 1_000_000_000_000 }
  const s = await serve({ clock, ttlSeconds: 600 })
  try {
    const { cookie } = await s.login()
    assert.equal((await s.call('/assistant/ping', { cookie })).status, 200)
    clock.now = () => 1_000_000_000_000 + 599_000
    assert.equal((await s.call('/assistant/ping', { cookie })).status, 200, 'still valid a second before')
    clock.now = () => 1_000_000_000_000 + 600_000
    assert.equal((await s.call('/assistant/ping', { cookie })).status, 401, 'refused at the expiry')
  } finally {
    await s.close()
  }
})

test('changing the access code signs everyone out', async () => {
  const old = await serve({ accessCode: 'the first access code' })
  const { cookie } = await old.login('the first access code')
  await old.close()
  const rotated = await serve({ accessCode: 'a different access code' })
  try {
    assert.equal((await rotated.call('/assistant/ping', { cookie })).status, 401)
  } finally {
    await rotated.close()
  }
})

test('logout clears the cookie', async () => {
  const s = await serve()
  try {
    const { cookie } = await s.login()
    const out = await s.call('/assistant/auth/logout', { method: 'POST', cookie })
    assert.equal(out.status, 204)
    assert.match(out.headers.get('set-cookie'), new RegExp(`^${COOKIE_NAME}=;.*Max-Age=0`))
  } finally {
    await s.close()
  }
})

test('wrong codes are throttled across callers, then allowed again after a minute', async () => {
  const clock = { now: () => 5_000_000 }
  const s = await serve({ clock })
  try {
    for (let i = 0; i < 10; i += 1) assert.equal((await s.login('wrong code ' + i)).status, 401)
    const locked = await s.login(CODE)
    assert.equal(locked.status, 429, 'even the right code waits')
    assert.equal(locked.json.code, 'too-many-attempts')
    assert.equal(locked.headers.get('retry-after'), '60')
    clock.now = () => 5_000_000 + 60_000
    assert.equal((await s.login(CODE)).status, 200)
  } finally {
    await s.close()
  }
})

test('a code that is set but too short LOCKS the assistant (it never falls back to open)', async () => {
  const s = await serve({ accessCode: 'short' })
  try {
    assert.ok('short'.length < MIN_CODE_LENGTH)
    const ping = await s.call('/assistant/ping')
    assert.equal(ping.status, 503)
    assert.equal(ping.json.code, 'assistant-auth-misconfigured')
    assert.equal((await s.login('short')).status, 503, 'even typing the short code does not unlock it')
    assert.deepEqual((await s.call('/assistant/auth/status')).json, { required: true, misconfigured: true, authenticated: false })
    assert.ok(s.logger.lines.some((line) => /at least 12 characters.*LOCKED/.test(line)))
  } finally {
    await s.close()
  }
})

test('the WebSocket follows the same rule: no cookie, no socket', async () => {
  const s = await serve()
  try {
    assert.deepEqual(await openSocket(s.port), { opened: false, status: 401 })
    assert.deepEqual(await openSocket(s.port, `${COOKIE_NAME}=v1.1.${'0'.repeat(64)}`), { opened: false, status: 401 })
    const { cookie } = await s.login()
    assert.deepEqual(await openSocket(s.port, cookie), { opened: true })
    assert.deepEqual(await openSocket(s.port, `theme=dark; ${cookie}; other=1`), { opened: true }, 'among other cookies')
  } finally {
    await s.close()
  }
})

test('the WebSocket is refused with 503 when the code is misconfigured, and open when auth is off', async () => {
  const locked = await serve({ accessCode: 'short' })
  try {
    assert.deepEqual(await openSocket(locked.port), { opened: false, status: 503 })
  } finally {
    await locked.close()
  }
  const open = await serve({ accessCode: '' })
  try {
    assert.deepEqual(await openSocket(open.port), { opened: true })
  } finally {
    await open.close()
  }
})
