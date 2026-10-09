import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { createMeetingAuth } from '../auth/meetingAuth.js'
import { createUpgradeRouter } from './upgradeRouter.js'
import { TICKET_PROTOCOL, attachLiveSpeechRelay, liveSpeechUpstreamUrl } from './liveSpeechRelay.js'

const ADMIN = 'admin-token-'.padEnd(40, 'x')
const SECRET = 'ticket-secret-'.padEnd(40, 'y')
const MEETING = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-0000000000aa'
const quiet = { error() {}, warn() {}, info() {}, log() {} }

/**
 * A real HTTP server with the real upgrade router and relay in front of a fake speech service
 * (a WebSocket server that answers `start` with `ready` and `stop` with `stopped`).
 */
async function startRig({ relayOptions = {}, upstreamUrl, clock } = {}) {
  const upstreamReceived = []
  const upstreamSockets = []
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/live-speech' })
  await once(upstream, 'listening')
  upstream.on('connection', (socket) => {
    upstreamSockets.push(socket)
    socket.on('message', (data, isBinary) => {
      upstreamReceived.push({ data: isBinary ? data : data.toString(), isBinary })
      if (isBinary) return socket.send(Buffer.from([1, 2, 3]), { binary: true })
      const message = JSON.parse(data.toString())
      if (message.type === 'start') socket.send(JSON.stringify({ type: 'ready', sessionId: 's-1' }))
      if (message.type === 'stop') {
        socket.send(JSON.stringify({ type: 'stopped' }))
        socket.close(1000, 'done')
      }
    })
  })

  const http = createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  const upgrades = createUpgradeRouter(http, { logger: quiet })
  const auth = createMeetingAuth({ adminToken: ADMIN, ticketSecret: SECRET, clock, logger: quiet })
  attachLiveSpeechRelay({
    upgrades,
    auth,
    upstreamUrl: upstreamUrl ?? `ws://127.0.0.1:${upstream.address().port}/live-speech`,
    logger: quiet,
    ...relayOptions
  })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const base = `ws://127.0.0.1:${http.address().port}`

  const clients = []
  return {
    auth,
    base,
    upstreamReceived,
    upstreamSockets,
    ticket: (meetingId = MEETING) => auth.issueTicket(meetingId).token,
    connect(path, protocols) {
      return new Promise((resolve) => {
        const ws = new WebSocket(`${base}${path}`, protocols)
        clients.push(ws)
        ws.on('unexpected-response', (_req, res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => {
            let json = null
            try {
              json = JSON.parse(body)
            } catch {
              /* not JSON */
            }
            resolve({ rejected: res.statusCode, body: json })
          })
        })
        ws.on('error', () => {})
        ws.on('open', () => resolve({ client: track(ws) }))
      })
    },
    async close() {
      for (const ws of clients) ws.terminate()
      for (const socket of upstreamSockets) socket.terminate()
      upstream.close()
      http.closeAllConnections()
      await new Promise((resolve) => http.close(resolve))
    }
  }
}

/** Collects what a client receives so a test can await the next message or the close. */
function track(ws) {
  const inbox = []
  const waiters = []
  ws.on('message', (data, isBinary) => {
    const item = { data: isBinary ? data : data.toString(), isBinary }
    const waiter = waiters.shift()
    if (waiter) waiter(item)
    else inbox.push(item)
  })
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  return {
    ws,
    closed,
    send: (payload, options) => ws.send(typeof payload === 'string' ? payload : payload, options),
    next: () =>
      new Promise((resolve, reject) => {
        const item = inbox.shift()
        if (item) return resolve(item)
        const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 3000)
        waiters.push((value) => {
          clearTimeout(timer)
          resolve(value)
        })
      })
  }
}

const start = (token, meetingId = MEETING) => JSON.stringify({ type: 'start', sampleRate: 16000, meetingId, meetingTicket: token })
const PATH = '/api/v1/live-speech'

test('upstream URL: http becomes ws, https becomes wss, and the path is always /live-speech', () => {
  assert.equal(liveSpeechUpstreamUrl('http://127.0.0.1:8765'), 'ws://127.0.0.1:8765/live-speech')
  assert.equal(liveSpeechUpstreamUrl('http://host.docker.internal:8765/'), 'ws://host.docker.internal:8765/live-speech')
  assert.equal(liveSpeechUpstreamUrl('https://speech.example:9000/old?x=1#y'), 'wss://speech.example:9000/live-speech')
  assert.equal(liveSpeechUpstreamUrl(), 'ws://127.0.0.1:8765/live-speech')
})

test('nobody gets in without a valid meeting ticket offered as a subprotocol', async () => {
  const rig = await startRig()
  try {
    const good = rig.ticket()
    const cases = [
      ['no protocols', undefined, 'auth-required'],
      ['only the marker', [TICKET_PROTOCOL], 'auth-required'],
      ['only a token', [good], 'auth-required'],
      ['marker in the wrong place', [good, TICKET_PROTOCOL], 'auth-required'],
      ['three protocols', [TICKET_PROTOCOL, good, 'extra'], 'auth-required'],
      ['garbage token', [TICKET_PROTOCOL, 'not-a-ticket'], 'auth-required'],
      ['admin token', [TICKET_PROTOCOL, ADMIN], 'auth-required'],
      ['ticket from another secret', [TICKET_PROTOCOL, createMeetingAuth({ adminToken: ADMIN, ticketSecret: 'z'.repeat(40), logger: quiet }).issueTicket(MEETING).token], 'auth-required']
    ]
    for (const [name, protocols, code] of cases) {
      const result = await rig.connect(PATH, protocols)
      assert.equal(result.rejected, 401, name)
      assert.equal(result.body.code, code, name)
    }
    assert.equal(rig.upstreamSockets.length, 0, 'nothing reached the speech service')
  } finally {
    await rig.close()
  }
})

test('an expired ticket is told so', async () => {
  let now = Date.parse('2026-10-09T10:00:00.000Z')
  const rig = await startRig({ clock: () => now })
  try {
    const token = rig.ticket()
    now += 13 * 3600 * 1000
    const result = await rig.connect(PATH, [TICKET_PROTOCOL, token])
    assert.equal(result.rejected, 401)
    assert.equal(result.body.code, 'ticket-expired')
  } finally {
    await rig.close()
  }
})

test('a valid ticket connects, the marker is the only protocol answered, and the token is never echoed', async () => {
  const rig = await startRig()
  try {
    const token = rig.ticket()
    const { client } = await rig.connect(PATH, [TICKET_PROTOCOL, token])
    assert.equal(client.ws.protocol, TICKET_PROTOCOL)
    assert.equal(client.ws.protocol.includes(token), false)
  } finally {
    await rig.close()
  }
})

test('text and binary pass through unchanged in both directions, including the replies', async () => {
  const rig = await startRig()
  try {
    const token = rig.ticket()
    const { client } = await rig.connect(PATH, [TICKET_PROTOCOL, token])

    client.send(start(token))
    const ready = await client.next()
    assert.equal(ready.isBinary, false)
    assert.deepEqual(JSON.parse(ready.data), { type: 'ready', sessionId: 's-1' })

    const frame = Buffer.alloc(6400, 7)
    client.send(frame, { binary: true })
    const ack = await client.next()
    assert.equal(ack.isBinary, true)
    assert.deepEqual([...ack.data], [1, 2, 3])

    assert.equal(rig.upstreamReceived.length, 2)
    assert.equal(rig.upstreamReceived[0].isBinary, false)
    assert.equal(JSON.parse(rig.upstreamReceived[0].data).meetingId, MEETING)
    assert.equal(rig.upstreamReceived[1].isBinary, true)
    assert.equal(rig.upstreamReceived[1].data.length, 6400)
  } finally {
    await rig.close()
  }
})

test('a stop flows through, the speech service finishes, and the client sees the summary then a clean close', async () => {
  const rig = await startRig()
  try {
    const token = rig.ticket()
    const { client } = await rig.connect(PATH, [TICKET_PROTOCOL, token])
    client.send(start(token))
    await client.next()
    client.send(JSON.stringify({ type: 'stop' }))
    assert.equal(JSON.parse((await client.next()).data).type, 'stopped')
    const closed = await client.closed
    assert.equal(closed.code, 1000)
  } finally {
    await rig.close()
  }
})

test('the first message must be a start for the ticket\'s own meeting, with that same ticket; nothing else reaches the speech service', async () => {
  const rig = await startRig()
  try {
    const token = rig.ticket()
    const otherToken = rig.ticket(OTHER)
    const cases = [
      ['binary first', () => Buffer.alloc(100), { binary: true }, 'first-message-must-be-start'],
      ['not JSON', () => 'hello', undefined, 'first-message-must-be-start'],
      ['not a start', () => JSON.stringify({ type: 'stop' }), undefined, 'first-message-must-be-start'],
      ['a standalone start (no meeting)', () => JSON.stringify({ type: 'start', sampleRate: 16000 }), undefined, 'meeting-mismatch'],
      ['another meeting', () => start(token, OTHER), undefined, 'meeting-mismatch'],
      ['another meeting with its own ticket', () => start(otherToken, OTHER), undefined, 'meeting-mismatch'],
      ['a different ticket for this meeting', () => start(rig.ticket()), undefined, 'ticket-mismatch']
    ]
    for (const [name, build, options, reason] of cases) {
      const { client } = await rig.connect(PATH, [TICKET_PROTOCOL, token])
      client.send(build(), options)
      const closed = await client.closed
      assert.equal(closed.code, 1008, name)
      assert.equal(closed.reason, reason, name)
    }
    assert.equal(rig.upstreamReceived.length, 0, 'not one rejected message was forwarded')
  } finally {
    await rig.close()
  }
})

test('a client that never says start is dropped', async () => {
  const rig = await startRig({ relayOptions: { startTimeoutMs: 80 } })
  try {
    const { client } = await rig.connect(PATH, [TICKET_PROTOCOL, rig.ticket()])
    const closed = await client.closed
    assert.equal(closed.code, 1008)
    assert.equal(closed.reason, 'start-timeout')
  } finally {
    await rig.close()
  }
})

test('when the client disconnects the speech service connection is closed too', async () => {
  const rig = await startRig()
  try {
    const token = rig.ticket()
    const { client } = await rig.connect(PATH, [TICKET_PROTOCOL, token])
    client.send(start(token))
    await client.next()
    const upstreamClosed = new Promise((resolve) => rig.upstreamSockets[0].on('close', (code) => resolve(code)))
    client.ws.close(1000)
    assert.ok(await upstreamClosed)
  } finally {
    await rig.close()
  }
})

test('when the speech service is unreachable the client is closed with 1011, not left hanging', async () => {
  const rig = await startRig({ upstreamUrl: 'ws://127.0.0.1:1/live-speech' })
  try {
    const token = rig.ticket()
    const { client } = await rig.connect(PATH, [TICKET_PROTOCOL, token])
    client.send(start(token))
    const closed = await client.closed
    assert.equal(closed.code, 1011)
    assert.equal(closed.reason, 'speech-service-unavailable')
  } finally {
    await rig.close()
  }
})

test('at the connection limit a new client is refused with 503, and a freed slot is reusable', async () => {
  const rig = await startRig({ relayOptions: { maxConnections: 1 } })
  try {
    const first = await rig.connect(PATH, [TICKET_PROTOCOL, rig.ticket()])
    assert.ok(first.client)
    const second = await rig.connect(PATH, [TICKET_PROTOCOL, rig.ticket(OTHER)])
    assert.equal(second.rejected, 503)
    assert.equal(second.body.code, 'live-speech-busy')

    first.client.ws.close(1000)
    await first.client.closed
    await new Promise((resolve) => setTimeout(resolve, 50))
    const third = await rig.connect(PATH, [TICKET_PROTOCOL, rig.ticket(OTHER)])
    assert.ok(third.client, 'the slot was freed')
  } finally {
    await rig.close()
  }
})

test('an oversized message closes the connection (1009) instead of being buffered', async () => {
  const rig = await startRig({ relayOptions: { maxPayloadBytes: 1024 } })
  try {
    const token = rig.ticket()
    const { client } = await rig.connect(PATH, [TICKET_PROTOCOL, token])
    client.send(start(token))
    await client.next()
    client.send(Buffer.alloc(4096), { binary: true })
    const closed = await client.closed
    assert.equal(closed.code, 1009)
  } finally {
    await rig.close()
  }
})

test('any other WebSocket path is answered 404 by the dispatcher, not left hanging', async () => {
  const rig = await startRig()
  try {
    const result = await rig.connect('/api/v1/nope', [TICKET_PROTOCOL, rig.ticket()])
    assert.equal(result.rejected, 404)
  } finally {
    await rig.close()
  }
})
