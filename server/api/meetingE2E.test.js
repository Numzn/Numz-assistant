import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Release gate for meeting persistence. Runs the real server/server.js as a child process
 * (real wiring, real env-based auth, real SQLite file) and a real process restart.
 *
 *   Meeting -> session A -> transcript -> disconnect -> session B -> transcript
 *   -> complete -> retrieve.   Then: a second meeting, restart the process, recover, continue.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ADMIN = 'e2e-admin-token-'.padEnd(40, 'q')
const TICKET_SECRET = 'e2e-ticket-secret-'.padEnd(40, 'r')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

async function startServer(dbFile) {
  const port = await freePort()
  const logs = []
  const child = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      AI_PROVIDER: 'placeholder',
      SPEECH_DATABASE_PATH: dbFile,
      MEETING_API_TOKEN: ADMIN,
      MEETING_TICKET_SECRET: TICKET_SECRET,
      CORS_ORIGIN: 'http://localhost:5173'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  const base = `http://127.0.0.1:${port}/api/v1`
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) break
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return { child, base, logs }
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

async function api(base, method, route, { token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const finalSegment = (id, start, text) => ({
  id,
  start,
  end: start + 1,
  text,
  speaker: null,
  words: [],
  confidence: null,
  language: 'en',
  uncertain: true
})

test('end to end: one meeting survives a disconnect, a reconnect, and a process restart', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meeting-e2e-'))
  const dbFile = path.join(dir, 'speech.sqlite')
  let server
  try {
    server = await startServer(dbFile)
    const { base } = server

    // 1. Create and start the meeting (admin). The response carries a meeting-scoped ticket.
    const created = await api(base, 'POST', '/meetings', { token: ADMIN, body: { metadata: { title: 'e2e' } } })
    assert.equal(created.status, 201)
    const meetingId = created.body.meetingId
    const ticket = created.body.ticket.token
    assert.match(meetingId, UUID_RE)
    assert.equal((await api(base, 'POST', `/meetings/${meetingId}/start`, { token: ADMIN })).status, 200)

    // 2. Session A: the speech transport attaches with the ticket and persists three finals.
    const sessionA = await api(base, 'POST', `/meetings/${meetingId}/sessions`, { token: ticket, body: {} })
    assert.equal(sessionA.status, 201)
    const appendA = (segment) =>
      api(base, 'POST', `/meetings/${meetingId}/transcript/final`, {
        token: ticket,
        body: { speechSessionId: sessionA.body.speechSessionId, segment }
      })
    assert.equal((await appendA(finalSegment('a-0001', 1, 'session A first'))).status, 201)
    assert.equal((await appendA(finalSegment('a-0002', 4, 'session A second'))).status, 201)
    assert.equal((await appendA(finalSegment('a-0003', 7, 'session A third'))).status, 201)

    // Duplicate delivery of an event that already landed (retry after a timeout) is safe.
    const dup = await appendA(finalSegment('a-0001', 1, 'session A first'))
    assert.equal(dup.status, 200)
    assert.equal(dup.body.status, 'ALREADY_EXISTS')

    // 3. Disconnect session A, reconnect as session B on the same meeting.
    const ended = await api(base, 'POST', `/meetings/${meetingId}/sessions/${sessionA.body.speechSessionId}/end`, {
      token: ticket,
      body: { reason: 'disconnected' }
    })
    assert.equal(ended.body.status, 'ENDED')
    assert.equal(ended.body.endReason, 'disconnected')

    const sessionB = await api(base, 'POST', `/meetings/${meetingId}/sessions`, { token: ticket, body: {} })
    assert.equal(sessionB.status, 201)
    const appendB = (segment) =>
      api(base, 'POST', `/meetings/${meetingId}/transcript/final`, {
        token: ticket,
        body: { speechSessionId: sessionB.body.speechSessionId, segment }
      })
    assert.equal((await appendB(finalSegment('b-0001', 1, 'session B first'))).status, 201)
    assert.equal((await appendB(finalSegment('b-0002', 3, 'session B second'))).status, 201)

    // 4. Complete (admin) and retrieve.
    assert.equal((await api(base, 'POST', `/meetings/${meetingId}/end`, { token: ADMIN })).body.status, 'COMPLETED')
    const transcript = await api(base, 'GET', `/meetings/${meetingId}/transcript`, { token: ADMIN })
    const segments = transcript.body.segments
    assert.deepEqual(
      segments.map((s) => s.text),
      ['session A first', 'session A second', 'session A third', 'session B first', 'session B second']
    )
    assert.equal(new Set(segments.map((s) => s.id)).size, segments.length, 'no duplicate segment ids')
    for (let i = 1; i < segments.length; i++) {
      assert.ok(segments[i].start >= segments[i - 1].end - 1e-9, `timeline must not overlap at ${segments[i].id}`)
    }
    assert.ok(segments[3].start >= segments[2].end, 'session B continues the meeting after session A')
    const sessions = await api(base, 'GET', `/meetings/${meetingId}/sessions`, { token: ADMIN })
    assert.equal(sessions.body.speechSessions.length, 3, 'start session + A + B, each recorded once')
    assert.equal(sessions.body.speechSessions.every((s) => s.status === 'ENDED'), true)

    // 5. Second meeting: live, persisted, then the process restarts underneath it.
    const second = await api(base, 'POST', '/meetings', { token: ADMIN, body: {} })
    const secondId = second.body.meetingId
    const secondTicket = second.body.ticket.token
    await api(base, 'POST', `/meetings/${secondId}/start`, { token: ADMIN })
    const live = await api(base, 'POST', `/meetings/${secondId}/sessions`, { token: secondTicket, body: {} })
    const preRestart = finalSegment('pre-0001', 1, 'before the restart')
    assert.equal(
      (
        await api(base, 'POST', `/meetings/${secondId}/transcript/final`, {
          token: secondTicket,
          body: { speechSessionId: live.body.speechSessionId, segment: preRestart }
        })
      ).status,
      201
    )

    await stopServer(server)
    server = await startServer(dbFile)
    assert.match(
      server.logs.join(''),
      /startup recovery: 1 speech session\(s\) ended, 1 meeting\(s\) moved to RECOVERING/,
      'restart is logged with what was recovered'
    )

    const recovered = await api(server.base, 'GET', `/meetings/${secondId}`, { token: ADMIN })
    assert.equal(recovered.body.status, 'RECOVERING', 'interrupted meeting is RECOVERING, not silently LIVE')
    const after = await api(server.base, 'GET', `/meetings/${secondId}/sessions`, { token: ADMIN })
    const endedBefore = after.body.speechSessions.find((s) => s.speechSessionId === live.body.speechSessionId)
    assert.equal(endedBefore.endReason, 'process-restart')

    // 6. The ticket survives the restart (same secret). Replaying the pre-restart event is safe.
    const replay = await api(server.base, 'POST', `/meetings/${secondId}/transcript/final`, {
      token: secondTicket,
      body: { speechSessionId: live.body.speechSessionId, segment: preRestart }
    })
    assert.equal(replay.body.status, 'ALREADY_EXISTS')

    const resumedSession = await api(server.base, 'POST', `/meetings/${secondId}/sessions`, { token: secondTicket, body: {} })
    assert.equal(resumedSession.status, 201)
    const postRestart = await api(server.base, 'POST', `/meetings/${secondId}/transcript/final`, {
      token: secondTicket,
      body: { speechSessionId: resumedSession.body.speechSessionId, segment: finalSegment('post-0001', 1, 'after the restart') }
    })
    assert.equal(postRestart.status, 201)
    assert.equal((await api(server.base, 'POST', `/meetings/${secondId}/resume`, { token: ADMIN })).body.status, 'LIVE')
    assert.equal((await api(server.base, 'POST', `/meetings/${secondId}/end`, { token: ADMIN })).body.status, 'COMPLETED')

    const finalText = (await api(server.base, 'GET', `/meetings/${secondId}/transcript`, { token: ADMIN })).body.segments.map(
      (s) => s.text
    )
    assert.deepEqual(finalText, ['before the restart', 'after the restart'])
  } finally {
    await stopServer(server)
    rmSync(dir, { recursive: true, force: true })
  }
})
