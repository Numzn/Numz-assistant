import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'

/**
 * Start-from-the-browser, against the real server/server.js as a child process: the launch endpoint,
 * the live-speech relay in front of a fake speech service, ending with the ticket, and proof that the
 * assistant's own WebSocket still works next to the relay on the same HTTP server.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ADMIN = 'e2e-admin-token-'.padEnd(40, 'q')
const TICKET_SECRET = 'e2e-ticket-secret-'.padEnd(40, 'r')
const LAUNCH = 'e2e-launch-code-1234'
const PROTOCOL = 'numz.meeting-ticket.v1'

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function startServer({ dbFile, speechPort, launchCode = LAUNCH }) {
  const port = await freePort()
  const logs = []
  const child = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NUMZ_SKIP_ENV_FILES: '1',
      PORT: String(port),
      NODE_ENV: 'development',
      AI_PROVIDER: 'placeholder',
      SPEECH_DATABASE_PATH: dbFile,
      MEETING_API_TOKEN: ADMIN,
      MEETING_TICKET_SECRET: TICKET_SECRET,
      MEETING_LAUNCH_CODE: launchCode,
      AUDIO_SERVICE_URL: `http://127.0.0.1:${speechPort}`,
      CORS_ORIGIN: 'http://localhost:5173'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  const origin = `127.0.0.1:${port}`
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) break
    try {
      const res = await fetch(`http://${origin}/api/v1/health`)
      if (res.ok) return { child, origin, base: `http://${origin}/api/v1`, logs }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  child.kill('SIGKILL')
  throw new Error(`server did not start:\n${logs.join('')}`)
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return
  const exited = new Promise((resolve) => server.child.once('exit', resolve))
  server.child.kill('SIGTERM')
  await exited
}

async function api(base, method, route, { token, code, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (code) headers['X-Meeting-Launch-Code'] = code
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** Opens a WebSocket and resolves with either the open socket or the HTTP status that refused it. */
function open(url, protocols) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols)
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      resolve({ rejected: res.statusCode })
    })
    ws.on('error', () => {})
    ws.on('open', () => resolve({ ws }))
  })
}

const nextMessage = (ws) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a WebSocket message')), 5000)
    ws.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()))
    })
  })

test('launch from the browser: code, ticket, live relay, end with the ticket, and the assistant socket untouched', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meeting-launch-e2e-'))
  const received = []
  const speech = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/live-speech' })
  await once(speech, 'listening')
  speech.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      received.push(JSON.parse(data.toString()))
      socket.send(JSON.stringify({ type: 'ready', sessionId: 'fake-session', persistence: 'meeting' }))
    })
  })
  let server
  try {
    server = await startServer({ dbFile: path.join(dir, 'speech.sqlite'), speechPort: speech.address().port })
    assert.match(server.logs.join(''), /\[meetings\] browser launch: enabled/)

    const health = await api(server.base, 'GET', '/health')
    assert.deepEqual(health.body.meetings.launch, { enabled: true })

    // Launch needs the code; the response carries the meeting's own ticket.
    assert.equal((await api(server.base, 'POST', '/meetings/launch', { body: {} })).status, 401)
    const launched = await api(server.base, 'POST', '/meetings/launch', { code: LAUNCH, body: { title: 'E2E' } })
    assert.equal(launched.status, 201)
    const { meetingId, ticket } = launched.body

    // The relay: no ticket is refused, a ticket gets through to the (fake) speech service.
    const wsBase = `ws://${server.origin}`
    assert.equal((await open(`${wsBase}/api/v1/live-speech`)).rejected, 401)
    assert.equal((await open(`${wsBase}/api/v1/live-speech`, [PROTOCOL, ADMIN])).rejected, 401, 'the admin token is not accepted here')
    const live = await open(`${wsBase}/api/v1/live-speech`, [PROTOCOL, ticket.token])
    assert.ok(live.ws, 'a valid ticket opens the relay')
    live.ws.send(JSON.stringify({ type: 'start', sampleRate: 16000, meetingId, meetingTicket: ticket.token }))
    assert.deepEqual(await nextMessage(live.ws), { type: 'ready', sessionId: 'fake-session', persistence: 'meeting' })
    assert.equal(received[0].meetingId, meetingId)
    live.ws.close()

    // The assistant's own socket still answers on the same server, and unknown paths are refused.
    const assistant = await open(`${wsBase}/api/v1/assistant/ws`)
    assert.ok(assistant.ws, 'the assistant WebSocket still upgrades')
    assistant.ws.send('this is not json')
    assert.equal((await nextMessage(assistant.ws)).type, 'AI_RESPONSE_ERROR')
    assistant.ws.close()
    assert.equal((await open(`${wsBase}/api/v1/nowhere`)).rejected, 404)

    // The browser then ends its own meeting with the ticket; with no sessions there is nothing to verify.
    const ended = await api(server.base, 'POST', `/meetings/${meetingId}/end`, { token: ticket.token, body: {} })
    assert.equal(ended.status, 200)
    assert.equal(ended.body.status, 'COMPLETED')
  } finally {
    await stopServer(server)
    speech.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without a launch code the server says so, refuses to launch, and persistence still works', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meeting-launch-off-'))
  let server
  try {
    server = await startServer({ dbFile: path.join(dir, 'speech.sqlite'), speechPort: 9, launchCode: '' })
    assert.match(server.logs.join(''), /\[meetings\] browser launch: DISABLED/)
    const health = await api(server.base, 'GET', '/health')
    assert.deepEqual(health.body.meetings.launch, { enabled: false })
    assert.equal(health.body.meetings.ready, true, 'the admin and ticket path is unaffected')
    const refused = await api(server.base, 'POST', '/meetings/launch', { code: LAUNCH, body: {} })
    assert.equal(refused.status, 503)
    assert.equal(refused.body.code, 'launch-not-configured')
    const created = await api(server.base, 'POST', '/meetings', { token: ADMIN, body: {} })
    assert.equal(created.status, 201, 'the operator path still works')
  } finally {
    await stopServer(server)
    rmSync(dir, { recursive: true, force: true })
  }
})
