import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { WebSocket } from 'ws'
import { Browser, rigAvailable, startStack } from '../../tests/helpers/aiRig.js'

/**
 * The whole thing, for real: the actual NUMZ AI server, the actual numzlab-auth with its sign-in broker, a pretend Google that approves
 * whoever the test says, and fakes only for the paid text model and the speech service. A person's browser is a cookie jar that follows
 * redirects. Skipped when numzlab-auth's test rig is not on this machine (NUMZLAB_AUTH_DIR).
 */

const skip = rigAvailable() ? false : 'numzlab-auth rig not found (set NUMZLAB_AUTH_DIR)'
let stack
let base
let origin

before(async () => {
  if (skip) return
  stack = await startStack({
    env: { AI_QUOTA_OVERRIDES: JSON.stringify({ viewer: { chatPerDay: 6, perMinute: 100, concurrent: 4 } }) }
  })
  base = stack.app.base
  origin = stack.app.origin
}, { timeout: 60_000 })
after(async () => {
  await stack?.close()
})

const nl = (route, body) => stack.numzlab.control(route, body)
let counter = 0

/** An approved person (invited at NUMZLAB), signed in to NUMZ AI in their own browser. */
async function person(role, { email = `p${++counter}-${role}@example.com`, signIn = true } = {}) {
  await nl('invite', { email, role })
  await nl('google', { email, sub: `sub-${email}`, name: email.split('@')[0] })
  const b = new Browser()
  const out = signIn ? await b.signIn(base) : null
  const api = (path, opts = {}) => b.request(`${base}${path}`, { origin, ...opts })
  const status = async () => (await api('/api/v1/assistant/auth/status')).json
  const csrf = async () => (await status()).csrf
  const post = async (path, body, opts = {}) => api(path, { method: 'POST', body, csrf: await csrf(), ...opts })
  const del = async (path) => api(path, { method: 'DELETE', csrf: await csrf() })
  return { email, b, out, api, status, post, del }
}

const ws = (path, { cookie = '', origin: o = origin } = {}) =>
  new Promise((resolve) => {
    const url = `${base.replace('http', 'ws')}${path}`
    const socket = new WebSocket(url, { headers: { ...(cookie ? { cookie } : {}), ...(o ? { origin: o } : {}) } })
    const events = []
    socket.on('message', (data) => events.push(JSON.parse(data.toString())))
    socket.on('open', () => resolve({ socket, events, opened: true }))
    socket.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ opened: false, status: res.statusCode, body }))
    })
    socket.on('error', () => {})
  })
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

test('signing in goes through NUMZLAB and Google and ends with NUMZ AI\'s own session, and no NUMZLAB session', { skip }, async () => {
  const ada = await person('admin', { email: 'ada@example.com' })
  assert.equal(ada.out.landed, `${base}/`)
  const status = await ada.status()
  assert.equal(status.authenticated, true)
  assert.equal(status.user.email, 'ada@example.com')
  assert.equal(status.user.role, 'admin')
  assert.ok(status.user.capabilities.includes('ai.admin'))
  const mine = ada.b.cookies(`${base}/x`).map(([k]) => k)
  assert.deepEqual(mine, ['numzai_session'], 'one cookie, ours, on the app\'s path only')
  assert.ok(!ada.b.jar.get(new URL(stack.numzlab.origin).host)?.has('nl_session'), 'no NUMZLAB session was created by signing in here')
  assert.equal(ada.b.jar.get(new URL(base).host).get('numzai_session').path, '/ai')
})

test('NUMZLAB\'s dashboard session and NUMZ AI\'s session are independent: logging out of either leaves the other', { skip }, async () => {
  const bea = await person('operator', { email: 'bea@example.com' })
  // the same person also signs in to the NUMZLAB dashboard (its own sign-in) in the same browser
  const dash = await bea.b.request(`${stack.numzlab.origin}/auth/google/start`, { follow: 15 })
  assert.ok(dash.status < 500)
  const me = (await bea.b.request(`${stack.numzlab.origin}/auth/me`)).json
  assert.equal(me.authenticated, true, 'signed in to the dashboard too')
  assert.equal((await bea.status()).authenticated, true)

  // dashboard sign-out: NUMZ AI is untouched
  const out = await bea.b.request(`${stack.numzlab.origin}/auth/logout`, { method: 'POST', csrf: me.csrf, origin: stack.numzlab.origin })
  assert.equal(out.status, 200)
  assert.equal((await bea.b.request(`${stack.numzlab.origin}/auth/me`)).json.authenticated, false)
  assert.equal((await bea.status()).authenticated, true, 'still signed in to NUMZ AI')
  assert.equal((await bea.post('/api/v1/assistant/chat', { message: 'still here' })).status, 200)

  // NUMZ AI sign-out: and a new dashboard session is unaffected by it
  const again = await bea.b.request(`${stack.numzlab.origin}/auth/google/start`, { follow: 15 })
  assert.ok(again.status < 500)
  assert.equal((await bea.b.request(`${stack.numzlab.origin}/auth/me`)).json.authenticated, true)
  assert.equal((await bea.post('/api/v1/assistant/auth/logout')).status, 204)
  assert.equal((await bea.status()).authenticated, false)
  assert.equal((await bea.b.request(`${stack.numzlab.origin}/auth/me`)).json.authenticated, true, 'the dashboard session is not ended by signing out here')

  // and a dashboard-only visitor (no NUMZ AI session) gets nothing from NUMZ AI
  assert.equal((await bea.api('/api/v1/assistant/conversations')).json.code, 'session-required')
})

test('an account NUMZLAB has not approved is turned away with a generic answer and leaves no trace', { skip }, async () => {
  await nl('google', { email: 'stranger@example.com', sub: 'sub-stranger', name: 'Stranger' })
  const b = new Browser()
  const out = await b.signIn(base)
  assert.equal(out.landed, `${base}/?auth=denied`)
  assert.equal(b.cookies(`${base}/x`).length, 0)
  assert.equal((await b.request(`${base}/api/v1/assistant/auth/status`)).json.authenticated, false)
  // removed and suspended accounts are told exactly the same
  await nl('invite', { email: 'gone@example.com', role: 'viewer' })
  await nl('google', { email: 'gone@example.com', sub: 'sub-gone', name: 'Gone' })
  assert.equal((await new Browser().signIn(base)).landed, `${base}/`, 'approved: in')
  await nl('suspend', { email: 'gone@example.com' })
  assert.equal((await new Browser().signIn(base)).landed, `${base}/?auth=denied`)
  await nl('remove', { email: 'gone@example.com' })
  assert.equal((await new Browser().signIn(base)).landed, `${base}/?auth=denied`)
})

test('private workspaces: nobody, an administrator included, can read, change or delete another person\'s conversations', { skip }, async () => {
  const ada = await person('admin')
  const bob = await person('viewer')
  const a = (await ada.post('/api/v1/assistant/chat', { message: 'the ada project plan' })).json
  const b = (await bob.post('/api/v1/assistant/chat', { message: 'bob private diary' })).json
  assert.equal(a.reply, 'echo: the ada project plan')
  assert.notEqual(a.sessionId, b.sessionId)

  assert.deepEqual((await ada.api('/api/v1/assistant/conversations')).json.conversations.map((c) => c.id), [a.sessionId])
  assert.deepEqual((await bob.api('/api/v1/assistant/conversations')).json.conversations.map((c) => c.id), [b.sessionId])
  // the administrator is not special here
  assert.equal((await ada.api(`/api/v1/assistant/conversations/${b.sessionId}`)).status, 404)
  assert.equal((await ada.del(`/api/v1/assistant/conversations/${b.sessionId}`)).status, 404)
  assert.equal((await bob.api(`/api/v1/assistant/conversations/${a.sessionId}`)).status, 404)
  // naming someone else's session writes into nobody's
  const tried = (await bob.post(`/api/v1/assistant/sessions/${a.sessionId}/chat`, { message: 'bob into ada' })).json
  assert.notEqual(tried.sessionId, a.sessionId)
  assert.equal((await ada.api(`/api/v1/assistant/conversations/${a.sessionId}`)).json.messages.length, 2)
  // an administrator's view of the whole thing is counts only
  const usage = (await ada.api('/api/v1/admin/usage')).json
  assert.ok(usage.people.length >= 2)
  assert.ok(!JSON.stringify(usage).includes('diary') && !JSON.stringify(usage).includes('project plan'))
  assert.ok(usage.people.every((p) => p.calls >= 1 && typeof p.tokensIn === 'number'))
  // and nothing in the admin surface reaches content
  for (const path of [`/api/v1/admin/conversations`, `/api/v1/admin/conversations/${b.sessionId}`, `/api/v1/admin/users/x/conversations`]) {
    assert.equal((await ada.api(path)).status, 404, path)
  }
  // a viewer cannot administer at all
  for (const path of ['/api/v1/admin/users', '/api/v1/admin/usage', '/api/v1/admin/health']) assert.equal((await bob.api(path)).status, 403, path)
  assert.equal((await bob.post('/api/v1/admin/pause', {})).status, 403)
  assert.equal((await bob.post(`/api/v1/admin/users/${(await ada.api('/api/v1/admin/users')).json.users[0].id}/revoke`, {})).status, 403)
})

test('streaming and sockets work for the person who owns them, with token counts recorded against them', { skip }, async () => {
  const cal = await person('operator')
  const cookie = cal.b.header(`${base}/x`)
  const live = await ws('/api/v1/assistant/ws', { cookie })
  assert.equal(live.opened, true)
  live.socket.send(JSON.stringify({ type: 'chat', sessionId: 'any-id', message: 'hello over the socket' }))
  const done = await until(() => live.events.find((e) => e.type === 'AI_RESPONSE_FINISHED'))
  assert.equal(done.reply, 'echo: hello over the socket')
  const sessionId = done.sessionId
  live.socket.close()
  assert.ok((await cal.api(`/api/v1/assistant/conversations/${sessionId}`)).json.messages.length === 2)

  // server-sent events
  const stream = await cal.post('/api/v1/assistant/chat/stream', { message: 'hello by stream' })
  assert.equal(stream.status, 200)
  assert.match(stream.text, /event: AI_TOKEN/)
  assert.match(stream.text, /echo: hello by stream/)
  assert.ok(stack.provider.state.streamOptionsSeen >= 1, 'token counts were asked of the provider')
  const rows = (await (await person('admin')).api('/api/v1/admin/usage')).json.people
  const mine = rows.find((r) => r.tokensOut > 0 && r.stream !== undefined) ?? rows[0]
  assert.ok(rows.some((r) => r.tokensIn > 0 && r.tokensOut > 0), 'the provider\'s counts, not a guess')
  assert.ok(mine)
})

test('a socket needs a session and our own origin, and is cut off when the person\'s access ends', { skip }, async () => {
  assert.equal((await ws('/api/v1/assistant/ws')).status, 401, 'no cookie')
  const dee = await person('viewer')
  const cookie = dee.b.header(`${base}/x`)
  const foreign = await ws('/api/v1/assistant/ws', { cookie, origin: 'https://evil.example' })
  assert.equal(foreign.status, 403, 'a page on another site cannot use the cookie')
  assert.equal((await ws('/api/v1/assistant/ws', { cookie, origin: '' })).status, 403, 'no origin at all is not a browser page of ours')
  assert.equal((await ws('/api/v1/assistant/ws', { cookie: 'numzai_session=forged' })).status, 401)

  const live = await ws('/api/v1/assistant/ws', { cookie })
  assert.equal(live.opened, true)
  const closed = new Promise((resolve) => live.socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  await nl('suspend', { email: dee.email })
  const result = await Promise.race([closed, new Promise((r) => setTimeout(() => r(null), 8000))])
  assert.deepEqual(result, { code: 4401, reason: 'access-revoked' }, 'closed by the sweep, with nobody typing anything')
  assert.equal((await dee.api('/api/v1/assistant/conversations')).json.code, 'access-revoked')
  // oversized and flooding frames
  const eve = await person('viewer')
  const big = await ws('/api/v1/assistant/ws', { cookie: eve.b.header(`${base}/x`) })
  const closedBig = new Promise((resolve) => big.socket.on('close', (code) => resolve(code)))
  big.socket.send('x'.repeat(70 * 1024))
  assert.equal(await Promise.race([closedBig, new Promise((r) => setTimeout(() => r('open'), 3000))]), 1009, 'a frame over 64 KiB is refused')
})

test('suspension ends access everywhere within the re-check time, and reinstating gives the same person back their conversations', { skip }, async () => {
  const fay = await person('viewer')
  const first = (await fay.post('/api/v1/assistant/chat', { message: 'remember the blue folder' })).json
  const second = await new Browser() // the same person on a second device
  await second.signIn(base)
  assert.equal((await second.request(`${base}/api/v1/assistant/auth/status`)).json.authenticated, true)
  await nl('suspend', { email: fay.email })
  await new Promise((r) => setTimeout(r, 1300))
  assert.equal((await fay.api('/api/v1/assistant/conversations')).status, 401)
  assert.equal((await second.request(`${base}/api/v1/assistant/conversations`, { origin })).status, 401)
  assert.equal((await fay.post('/api/v1/assistant/chat', { message: 'let me in' })).status, 401)
  await nl('activate', { email: fay.email })
  const back = new Browser()
  await nl('google', { email: fay.email, sub: `sub-${fay.email}`, name: 'fay' })
  assert.equal((await back.signIn(base)).landed, `${base}/`)
  const mine = (await back.request(`${base}/api/v1/assistant/conversations`, { origin })).json
  assert.deepEqual(mine.conversations.map((c) => c.id), [first.sessionId], 'the same person: the same conversations')
})

test('a role change at NUMZLAB applies without signing in again', { skip }, async () => {
  const gus = await person('viewer')
  assert.equal((await gus.api('/api/v1/admin/users')).status, 403)
  await nl('role', { email: gus.email, role: 'admin' })
  await new Promise((r) => setTimeout(r, 1300))
  assert.equal((await gus.api('/api/v1/admin/users')).status, 200)
  await nl('role', { email: gus.email, role: 'viewer' })
  await new Promise((r) => setTimeout(r, 1300))
  assert.equal((await gus.api('/api/v1/admin/users')).status, 403)
})

test('state-changing requests need the token and our origin; there is no CORS to be reflected', { skip }, async () => {
  const hal = await person('viewer')
  const csrf = await hal.status().then((s) => s.csrf)
  const chat = (opts) => hal.b.request(`${base}/api/v1/assistant/chat`, { method: 'POST', body: { message: 'hi' }, ...opts })
  assert.equal((await chat({ origin })).json.code, 'csrf-refused')
  assert.equal((await chat({ origin, csrf: 'wrong' })).json.code, 'csrf-refused')
  assert.equal((await chat({ origin: 'https://evil.example', csrf })).json.code, 'origin-refused')
  assert.equal((await chat({ csrf })).json.code, 'origin-refused', 'no origin, no fetch metadata')
  assert.equal((await chat({ origin, csrf })).status, 200)
  // a cross-site page asking with credentials gets no permission headers at all
  const preflight = await fetch(`${base}/api/v1/assistant/chat`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-csrf-token,content-type' } })
  assert.equal(preflight.headers.get('access-control-allow-origin'), null)
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null)
  const simple = await fetch(`${base}/api/v1/assistant/auth/status`, { headers: { origin: 'https://evil.example' } })
  assert.equal(simple.headers.get('access-control-allow-origin'), null)
  // the session cookie itself
  const cookie = hal.b.jar.get(new URL(base).host).get('numzai_session')
  assert.match(cookie.line, /HttpOnly/)
  assert.match(cookie.line, /SameSite=Lax/)
  assert.match(cookie.line, /Path=\/ai(;|$)/)
})

test('a forged identity header changes nothing: who you are is the session and only the session', { skip }, async () => {
  const ivy = await person('viewer')
  const forged = await ivy.api('/api/v1/assistant/auth/status', { headers: { 'x-auth-user': 'ada@example.com', 'x-auth-role': 'admin', 'x-auth-id': 'a1b2c3d4e5f6', 'x-forwarded-user': 'ada', authorization: 'Bearer ' + 'm'.repeat(40) } })
  assert.equal(forged.json.user.role, 'viewer')
  assert.match(forged.json.user.email, /^p\d+-viewer@/)
  assert.equal((await ivy.api('/api/v1/admin/users', { headers: { 'x-auth-role': 'admin' } })).status, 403)
  const nobody = await new Browser().request(`${base}/api/v1/admin/users`, { headers: { 'x-auth-role': 'admin', 'x-auth-user': 'ada@example.com' } })
  assert.equal(nobody.status, 401)
})

test('speech: the server asks the speech service with its key; a browser cannot choose the paid engine; the service refuses everyone else', { skip }, async () => {
  const jo = await person('viewer')
  const audio = Buffer.from('not really audio but enough bytes')
  const stt = (headers = {}) => jo.b.request(`${base}/api/v1/assistant/stt`, { method: 'POST', body: audio, headers: { 'content-type': 'application/octet-stream', ...headers }, origin, csrf: undefined })
  // needs the token like any change
  assert.equal((await stt()).json.code, 'csrf-refused')
  const csrf = await jo.status().then((s) => s.csrf)
  const served = stack.audio.state.served
  const good = await jo.b.request(`${base}/api/v1/assistant/stt`, { method: 'POST', body: audio, headers: { 'content-type': 'application/octet-stream', 'x-stt-backend': 'cloud' }, origin, csrf })
  assert.equal(good.status, 200)
  assert.equal(good.json.text, 'hello from the microphone')
  assert.ok(stack.audio.state.served >= served + 1, 'it went to the local service even though the browser asked for the cloud one (only that service says this)')
  assert.equal(stack.audio.state.refused, 0, 'with the right key')
  // the speech service itself refuses a caller without the key
  assert.equal((await fetch(`${stack.audio.url}/transcribe`, { method: 'POST', body: audio })).status, 401)
  assert.equal((await fetch(`${stack.audio.url}/health`)).status, 401)
  // a recording over the limit is refused before it is read
  const huge = await jo.b.request(`${base}/api/v1/assistant/stt`, { method: 'POST', body: Buffer.alloc(7 * 1024 * 1024), headers: { 'content-type': 'application/octet-stream' }, origin, csrf })
  assert.equal(huge.status, 413)
  // the diagnostic is for administrators
  assert.equal((await jo.api('/api/v1/assistant/audio-health')).status, 403)
  const admin = await person('admin')
  const health = await admin.api('/api/v1/assistant/audio-health')
  assert.equal(health.status, 200)
})

test('each person has their own allowance, refusals come with when to come back, and the administrator can stop everything', { skip }, async () => {
  const kim = await person('viewer')
  const lee = await person('viewer')
  for (let i = 0; i < 6; i++) assert.equal((await kim.post('/api/v1/assistant/chat', { message: `q${i}` })).status, 200)
  const over = await kim.post('/api/v1/assistant/chat', { message: 'q7' })
  assert.equal(over.status, 429)
  assert.equal(over.json.code, 'daily-limit')
  assert.ok(Number(over.headers.get('retry-after')) > 0)
  assert.equal((await lee.post('/api/v1/assistant/chat', { message: 'lee is fine' })).status, 200)
  assert.deepEqual((await kim.api('/api/v1/assistant/usage')).json.used.chat, 6)

  const root = await person('admin')
  assert.equal((await root.post('/api/v1/admin/pause', {})).status, 200)
  const stopped = await lee.post('/api/v1/assistant/chat', { message: 'anyone there' })
  assert.equal(stopped.status, 503)
  assert.equal(stopped.json.code, 'ai-paused')
  assert.equal((await root.post('/api/v1/admin/pause', { feature: 'dishes' })).status, 400)
  assert.equal((await root.post('/api/v1/admin/resume', {})).status, 200)
  assert.equal((await lee.post('/api/v1/assistant/chat', { message: 'back again' })).status, 200)
  // an administrator can end someone's sessions (not read them)
  const target = (await root.api('/api/v1/admin/users')).json.users.find((u) => u.email === lee.email)
  assert.equal((await root.post(`/api/v1/admin/users/${target.id}/revoke`, {})).status, 200)
  assert.equal((await lee.api('/api/v1/assistant/usage')).status, 401)
})

test('the public surface says only that the server is up; details, diagnostics and meetings need a person', { skip }, async () => {
  const anon = new Browser()
  const health = (await anon.request(`${base}/api/v1/health`)).json
  assert.deepEqual(Object.keys(health).sort(), ['assistant', 'ok', 'service'])
  assert.ok(!JSON.stringify(health).includes('fake-model') && !JSON.stringify(health).includes('127.0.0.1'))
  assert.equal((await anon.request(`${base}/api/v1/health/detail`)).status, 401)
  assert.equal((await anon.request(`${base}/api/v1/health/deepseek`)).status, 401)

  const mo = await person('viewer')
  const detail = await mo.api('/api/v1/health/detail')
  assert.equal(detail.status, 200)
  assert.equal(detail.json.aiModel, 'fake-model')
  assert.equal((await mo.api('/api/v1/health/deepseek')).status, 403, 'a paid probe: administrators only')
  const root = await person('admin')
  const probe = await root.api('/api/v1/health/deepseek')
  assert.ok([200, 502, 503].includes(probe.status))
  assert.equal(probe.status === 403, false)
})

test('meetings: starting one from the browser needs a person; the admin token and tickets work exactly as before', { skip }, async () => {
  const anon = new Browser()
  assert.equal((await anon.request(`${base}/api/v1/meetings/launch/session`)).json.code, 'session-required')
  assert.equal((await anon.request(`${base}/api/v1/meetings/launch`, { method: 'POST', body: {}, headers: { 'x-meeting-launch-code': 'launch-code-123456' } })).status, 401, 'the launch code alone is not enough any more')
  // the admin token (used by the host's tools) and its tickets are not browser credentials: unchanged
  const admin = { authorization: `Bearer ${'m'.repeat(40)}` }
  const created = await anon.request(`${base}/api/v1/meetings`, { method: 'POST', body: { title: 'x' }, headers: admin })
  assert.equal(created.status, 201)
  assert.ok(created.json.ticket)
  const fetched = await anon.request(`${base}/api/v1/meetings/${created.json.meetingId}`, { headers: admin })
  assert.equal(fetched.status, 200)
  assert.equal((await anon.request(`${base}/api/v1/meetings/${created.json.meetingId}`)).status, 401)
  // a signed-in person starts one with NO code: being signed in is the credential (the rig still has MEETING_LAUNCH_CODE set; it is ignored)
  const ned = await person('viewer')
  const nedId = (await ned.status()).user.id
  const available = await ned.api('/api/v1/meetings/launch/session')
  assert.deepEqual(available.json, { available: true, authenticated: true, signedIn: true }, 'the page is told it never has to ask for a code')
  const launched = await ned.post('/api/v1/meetings/launch', { title: 'No code needed' })
  assert.equal(launched.status, 201, launched.text)
  assert.ok(launched.json.ticket?.token, 'the meeting comes with its own ticket')
  assert.equal(ned.b.jar.get(new URL(base).host)?.get('numz_launch_session'), undefined, 'no launch cookie exists any more')
  // the meeting says who started it (an id only), and the admin's view of it carries no name or email
  const stored = await anon.request(`${base}/api/v1/meetings/${launched.json.meetingId}`, { headers: admin })
  assert.equal(stored.json.metadata.launchedBy, nedId)
  assert.equal(JSON.stringify(stored.json).includes('example.com'), false)
  // a launch code in the request changes nothing (not needed, not accepted as a way in)
  const withCode = await ned.post('/api/v1/meetings/launch', {}, { headers: { 'x-meeting-launch-code': 'wrong-code-wrong-code' } })
  assert.equal(withCode.status, 201, 'a wrong code is simply ignored when the person is signed in')
  // typing a code into a "launch session" is not a thing any more
  const typed = await ned.post('/api/v1/meetings/launch/session', {}, { headers: { 'x-meeting-launch-code': 'launch-code-123456' } })
  assert.equal(typed.status, 404)
  assert.equal(typed.json.code, 'launch-code-not-used')
  // signing out ends the ability at once: the launch needs the live session, not a leftover cookie
  await ned.post('/api/v1/assistant/auth/logout', {})
  assert.equal((await ned.api('/api/v1/meetings/launch/session')).status, 401)
  assert.equal((await ned.post('/api/v1/meetings/launch', {})).status, 401)
})

test('under /ai the app answers at its base path, redirects the bare path, and the root keeps working for the host\'s own checks', { skip }, async () => {
  const anon = new Browser()
  const bare = await anon.request(`${origin}/ai`)
  assert.equal(bare.status, 308)
  assert.equal(bare.headers.get('location'), '/ai/')
  assert.equal((await anon.request(`${origin}/ai/api/v1/health`)).json.ok, true)
  assert.equal((await anon.request(`${origin}/api/v1/health`)).json.ok, true, 'the container health check uses the root')
  // the sign-in pages are not shadowed by the single-page app
  const login = await anon.request(`${base}/auth/login`)
  assert.equal(login.status, 302)
  assert.match(login.headers.get('location'), /\/auth\/broker\/authorize\?/)
  assert.equal((await anon.request(`${base}/auth/nothing-here`)).status, 404)
})

test('every route that does anything is closed to a visitor with no session (the inventory)', { skip }, async () => {
  const anon = new Browser()
  const closed = [
    ['GET', '/api/v1/assistant/conversations'], ['GET', '/api/v1/assistant/conversations/11111111-1111-4111-8111-111111111111'],
    ['DELETE', '/api/v1/assistant/conversations?confirm=all'], ['DELETE', '/api/v1/assistant/conversations/11111111-1111-4111-8111-111111111111'],
    ['POST', '/api/v1/assistant/sessions'], ['GET', '/api/v1/assistant/state'], ['PATCH', '/api/v1/assistant/state'],
    ['GET', '/api/v1/assistant/sessions/x/state'], ['PATCH', '/api/v1/assistant/sessions/x/state'],
    ['POST', '/api/v1/assistant/chat'], ['POST', '/api/v1/assistant/sessions/x/chat'], ['POST', '/api/v1/assistant/chat/stream'], ['POST', '/api/v1/assistant/sessions/x/chat/stream'],
    ['POST', '/api/v1/assistant/stt'], ['GET', '/api/v1/assistant/audio-health'], ['GET', '/api/v1/assistant/usage'],
    ['POST', '/api/v1/assistant/camera/sessions'], ['POST', '/api/v1/assistant/camera/sessions/x/read'], ['POST', '/api/v1/assistant/camera/sessions/x/answer'], ['DELETE', '/api/v1/assistant/camera/sessions/x'],
    ['GET', '/api/v1/admin/users'], ['GET', '/api/v1/admin/usage'], ['POST', '/api/v1/admin/pause'], ['POST', '/api/v1/admin/resume'], ['GET', '/api/v1/admin/health'], ['GET', '/api/v1/admin/probe'],
    ['GET', '/api/v1/health/detail'], ['GET', '/api/v1/health/deepseek'],
    ['GET', '/api/v1/meetings/launch/session'], ['POST', '/api/v1/meetings/launch/session'], ['DELETE', '/api/v1/meetings/launch/session'], ['POST', '/api/v1/meetings/launch'],
    ['GET', '/api/v1/assistant/auth/sessions'], ['DELETE', '/api/v1/assistant/auth/sessions/aaaaaaaaaaaa']
  ]
  for (const [method, path] of closed) {
    const res = await anon.request(`${base}${path}`, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {}, origin, headers: method === 'POST' && path.includes('/read') ? { 'content-type': 'image/jpeg' } : {} })
    assert.equal(res.status, 401, `${method} ${path} -> ${res.status} ${res.text.slice(0, 80)}`)
  }
  // and the same through the bare path: no second front door
  assert.equal((await anon.request(`${origin}/api/v1/assistant/conversations`)).status, 401)
  // public by design: the page, the up-check, the sign-in start and status
  for (const path of ['/api/v1/health', '/api/v1/assistant/auth/status']) assert.equal((await anon.request(`${base}${path}`)).status, 200, path)
  // the old code login does not exist
  assert.equal((await anon.request(`${base}/api/v1/assistant/auth/login`, { method: 'POST', body: { code: 'x' }, origin })).status, 404)
  // sockets
  assert.equal((await ws('/api/v1/assistant/ws')).status, 401)
  assert.equal((await ws('/api/v1/live-speech')).status, 401)
  assert.equal((await ws('/api/v1/nothing')).status, 404)
})

test('the server\'s own log holds no cookie, code, secret, prompt or reply', { skip }, async () => {
  const log = stack.app.log()
  for (const needle of ['numzai_session=', stack.numzlab.secret, 'test-provider-key', 'echo: ', 'remember the blue folder', 'bob private diary', 'ada project plan', 'the blue folder']) {
    assert.ok(!log.includes(needle), `log contains ${needle}`)
  }
})
