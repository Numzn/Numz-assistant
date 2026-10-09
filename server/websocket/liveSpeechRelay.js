import { WebSocket, WebSocketServer } from 'ws'
import { rejectUpgrade } from './upgradeRouter.js'

/**
 * Authenticated pass-through from the browser to the speech service's live WebSocket.
 *
 * Why it exists: a page served over HTTPS may only open `wss://` connections, and the speech service
 * (audio/live_speech_ws.py) speaks plain `ws://` on a host port that is not meant to be reachable from
 * outside. The browser connects here, same origin as the page, and this relay opens the upstream socket.
 *
 * Who may connect: only a holder of a valid meeting ticket. A browser WebSocket cannot set an
 * Authorization header, and a ticket must not sit in a URL, so the client offers two subprotocols:
 *   new WebSocket(url, [TICKET_PROTOCOL, ticketToken])
 * The relay answers with TICKET_PROTOCOL only; the token is never echoed. The admin token is refused here.
 *
 * What it forwards: everything, unchanged, in both directions (text stays text, binary stays binary),
 * except that the first client message must be a `start` for the ticket's own meeting carrying that same
 * ticket. So a ticket cannot be used to open a standalone session or to write to another meeting.
 * The speech service still validates the ticket against the meeting API on its own.
 */

export const LIVE_SPEECH_PATH = '/api/v1/live-speech'
export const TICKET_PROTOCOL = 'numz.meeting-ticket.v1'

const DEFAULT_START_TIMEOUT_MS = 10_000
const UPSTREAM_CONNECT_TIMEOUT_MS = 5_000
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024

/** http(s)://host:port  ->  ws(s)://host:port/live-speech */
export function liveSpeechUpstreamUrl(audioServiceUrl = 'http://127.0.0.1:8765') {
  const url = new URL(audioServiceUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/live-speech'
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** A close code that may legally be sent on the wire (1005/1006 are reserved for local use only). */
function sendableCloseCode(code) {
  const ok =
    code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  return ok ? code : 1011
}

function firstMessageProblem(data, isBinary, principal, token) {
  if (isBinary) return 'first-message-must-be-start'
  let message
  try {
    message = JSON.parse(data.toString('utf8'))
  } catch {
    return 'first-message-must-be-start'
  }
  if (message?.type !== 'start') return 'first-message-must-be-start'
  if (message.meetingId !== principal.meetingId) return 'meeting-mismatch'
  if (message.meetingTicket !== token) return 'ticket-mismatch'
  return null
}

function bridge({ client, upstreamUrl, principal, token, active, logger, maxPayload, startTimeoutMs }) {
  let started = false
  let closed = false
  let pendingBytes = 0
  const pending = []

  const upstream = new WebSocket(upstreamUrl, { handshakeTimeout: UPSTREAM_CONNECT_TIMEOUT_MS, maxPayload })
  const startTimer = setTimeout(() => finish(1008, 'start-timeout'), startTimeoutMs)

  function finish(code, reason = '') {
    if (closed) return
    closed = true
    clearTimeout(startTimer)
    active.delete(client)
    logger.log(`[live-speech] relay closed meeting=${principal.meetingId} code=${code} active=${active.size}`)
    try {
      if (client.readyState === WebSocket.OPEN) client.close(sendableCloseCode(code), reason.slice(0, 100))
    } catch {
      /* already closing */
    }
    try {
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
      else upstream.close()
    } catch {
      /* already closing */
    }
  }

  client.on('message', (data, isBinary) => {
    if (closed) return
    if (!started) {
      const problem = firstMessageProblem(data, isBinary, principal, token)
      if (problem) return finish(1008, problem)
      started = true
      clearTimeout(startTimer)
    }
    if (upstream.readyState === WebSocket.OPEN) {
      if (upstream.bufferedAmount > MAX_BACKLOG_BYTES) return finish(1013, 'speech-service-too-slow')
      upstream.send(data, { binary: isBinary })
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      pendingBytes += data.length
      if (pendingBytes > MAX_BACKLOG_BYTES) return finish(1013, 'speech-service-too-slow')
      pending.push({ data, isBinary })
    }
  })

  upstream.on('open', () => {
    for (const { data, isBinary } of pending.splice(0)) upstream.send(data, { binary: isBinary })
  })
  upstream.on('message', (data, isBinary) => {
    if (!closed && client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  upstream.on('close', (code, reason) => finish(code, reason.toString('utf8')))
  upstream.on('error', (err) => {
    logger.warn(`[live-speech] speech service connection failed: ${err.message}`)
    finish(1011, 'speech-service-unavailable')
  })
  client.on('close', () => finish(1000))
  client.on('error', () => finish(1011, 'client-error'))
}

export function attachLiveSpeechRelay({
  upgrades,
  auth,
  upstreamUrl,
  path = LIVE_SPEECH_PATH,
  maxConnections = 4,
  maxPayloadBytes = 1024 * 1024,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  logger = console
}) {
  if (!upgrades || !auth || !upstreamUrl) throw new Error('upgrades, auth and upstreamUrl are required')
  const active = new Set()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxPayloadBytes,
    handleProtocols: (protocols) => (protocols.has(TICKET_PROTOCOL) ? TICKET_PROTOCOL : false)
  })

  upgrades.add(path, (req, socket, head) => {
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    const token = offered.length === 2 && offered[0] === TICKET_PROTOCOL ? offered[1] : null
    if (!token) return rejectUpgrade(socket, 401, 'auth-required')

    const principal = auth.authenticateToken(token)
    if (principal.kind === 'expired') return rejectUpgrade(socket, 401, 'ticket-expired')
    if (principal.kind !== 'ticket') return rejectUpgrade(socket, 401, 'auth-required')
    if (active.size >= maxConnections) return rejectUpgrade(socket, 503, 'live-speech-busy')

    wss.handleUpgrade(req, socket, head, (client) => {
      active.add(client)
      logger.log(`[live-speech] relay opened meeting=${principal.meetingId} active=${active.size}`)
      bridge({ client, upstreamUrl, principal, token, active, logger, maxPayload: maxPayloadBytes, startTimeoutMs })
    })
  })

  return { wss, active, upstreamUrl, path }
}
