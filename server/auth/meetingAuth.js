import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Authentication boundary for meeting persistence.
 *
 * Two credential types, both bearer tokens:
 *   - Admin token (MEETING_API_TOKEN): lifecycle, reads, ticket minting.
 *   - Meeting ticket (HMAC-signed with MEETING_TICKET_SECRET): bound to ONE meeting and
 *     expiring. Grants speech-session attach/end, canonical segment append and ending that one
 *     meeting. The speech transport and the browser receive a ticket; neither receives the admin token.
 *
 * One narrow extra gate, for a browser that has no user login: a shared launch code
 * (MEETING_LAUNCH_CODE, sent as X-Meeting-Launch-Code) that allows exactly one thing, starting a NEW
 * meeting and receiving its ticket. It cannot read, list or end anything. Wrong codes are throttled.
 *
 * Fails closed: a route whose credential type is not configured answers 503, never allows.
 *
 * This module is the only place that knows the provider. Routes call requireAdmin,
 * requireMeetingWriter and issueTicket, so the provider can be replaced (for example by
 * user authentication) without touching route or service code.
 */

const TICKET_VERSION = 1
const TICKET_SCOPE = 'meeting-write'
const MIN_SECRET_LENGTH = 32
const MIN_LAUNCH_CODE_LENGTH = 12
const LAUNCH_FAILURE_LIMIT = 10
const LAUNCH_FAILURE_WINDOW_MS = 60_000

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest()
}

/** Constant-time comparison of two strings (digests give equal lengths for timingSafeEqual). */
function secretsEqual(candidate, expected) {
  return timingSafeEqual(digest(candidate), digest(expected))
}

function usable(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH
}

function bearerToken(req) {
  const header = req.headers?.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1] : null
}

function deny(res, req, status, code, message) {
  if (status === 401) res.set('WWW-Authenticate', 'Bearer')
  return res.status(status).json({ error: message, code, requestId: req.id })
}

export function createMeetingAuth({
  adminToken = '',
  ticketSecret = '',
  launchCode = '',
  ticketTtlSeconds = 12 * 3600,
  clock = () => Date.now(),
  logger = console
} = {}) {
  const adminEnabled = usable(adminToken)
  const ticketsEnabled = usable(ticketSecret)
  // Launching also needs tickets: the new meeting's ticket is the only thing the browser receives.
  const launchEnabled = typeof launchCode === 'string' && launchCode.length >= MIN_LAUNCH_CODE_LENGTH && ticketsEnabled
  if (adminToken && !adminEnabled) {
    logger.warn(`[meeting-auth] MEETING_API_TOKEN must be at least ${MIN_SECRET_LENGTH} characters; admin access disabled`)
  }
  if (ticketSecret && !ticketsEnabled) {
    logger.warn(`[meeting-auth] MEETING_TICKET_SECRET must be at least ${MIN_SECRET_LENGTH} characters; tickets disabled`)
  }

  if (launchCode && !launchEnabled) {
    logger.warn(
      `[meeting-auth] MEETING_LAUNCH_CODE must be at least ${MIN_LAUNCH_CODE_LENGTH} characters and tickets must be enabled; ` +
        'starting meetings from the browser is disabled'
    )
  }

  const nowSeconds = () => Math.floor(clock() / 1000)
  const launchFailures = [] // timestamps (ms) of recent wrong launch codes

  function sign(payload) {
    return createHmac('sha256', ticketSecret).update(payload).digest('base64url')
  }

  function issueTicket(meetingId) {
    if (!ticketsEnabled) return null
    const expiresAt = nowSeconds() + ticketTtlSeconds
    const payload = Buffer.from(
      JSON.stringify({
        v: TICKET_VERSION,
        scope: TICKET_SCOPE,
        mid: meetingId,
        exp: expiresAt,
        jti: randomBytes(8).toString('hex')
      })
    ).toString('base64url')
    return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(expiresAt * 1000).toISOString() }
  }

  /** Returns { meetingId, expired } for a correctly signed ticket, or null if it is not one of ours. */
  function readTicket(token) {
    if (!ticketsEnabled) return null
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [payload, signature] = parts
    if (!secretsEqual(signature, sign(payload))) return null
    let data
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      return null
    }
    if (data?.v !== TICKET_VERSION || data.scope !== TICKET_SCOPE || typeof data.mid !== 'string') return null
    if (!Number.isFinite(data.exp)) return null
    return { meetingId: data.mid, expired: data.exp <= nowSeconds() }
  }

  /** Who a raw bearer token belongs to: admin, a live ticket, an expired ticket, or nobody. */
  function principalForToken(token) {
    if (typeof token !== 'string' || !token) return { kind: 'anonymous' }
    if (adminEnabled && secretsEqual(token, adminToken)) return { kind: 'admin' }
    const ticket = readTicket(token)
    if (ticket && !ticket.expired) return { kind: 'ticket', meetingId: ticket.meetingId }
    return { kind: ticket ? 'expired' : 'invalid' }
  }

  function principalFor(req) {
    return principalForToken(bearerToken(req))
  }

  function notConfigured(req, res) {
    return deny(res, req, 503, 'auth-not-configured', 'Meeting API authentication is not configured on this server')
  }

  function rejectUnauthenticated(req, res, principal) {
    if (principal.kind === 'expired') return deny(res, req, 401, 'ticket-expired', 'Meeting ticket has expired')
    return deny(res, req, 401, 'auth-required', 'Valid credentials are required')
  }

  /** Admin-only operation: lifecycle, reads, ticket minting. */
  function requireAdmin() {
    return (req, res, next) => {
      if (!adminEnabled) return notConfigured(req, res)
      const principal = principalFor(req)
      req.principal = principal
      if (principal.kind === 'admin') return next()
      if (principal.kind === 'ticket') {
        return deny(res, req, 403, 'forbidden', 'A meeting ticket cannot perform this operation')
      }
      return rejectUnauthenticated(req, res, principal)
    }
  }

  /** Admin, or a ticket that is bound to the meeting named in the route. */
  function requireMeetingWriter({ meetingParam = 'meetingId' } = {}) {
    return (req, res, next) => {
      if (!adminEnabled && !ticketsEnabled) return notConfigured(req, res)
      const principal = principalFor(req)
      req.principal = principal
      if (principal.kind === 'admin') return next()
      if (principal.kind === 'ticket') {
        if (principal.meetingId === req.params[meetingParam]) return next()
        return deny(res, req, 403, 'forbidden', 'This meeting ticket does not grant access to this meeting')
      }
      return rejectUnauthenticated(req, res, principal)
    }
  }

  /**
   * The browser's one capability: start a new meeting. Fails closed (503) when no launch code is
   * configured, answers 401 for a missing or wrong code, and refuses everything with 429 for a
   * minute after too many wrong codes, so the code cannot be guessed at speed.
   */
  function requireLaunchCode() {
    return (req, res, next) => {
      const refuse = (status, code, message) => res.status(status).json({ error: message, code, requestId: req.id })
      if (!launchEnabled) {
        return refuse(503, 'launch-not-configured', 'Starting meetings from the browser is not configured on this server')
      }
      const now = clock()
      while (launchFailures.length && now - launchFailures[0] >= LAUNCH_FAILURE_WINDOW_MS) launchFailures.shift()
      if (launchFailures.length >= LAUNCH_FAILURE_LIMIT) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((launchFailures[0] + LAUNCH_FAILURE_WINDOW_MS - now) / 1000))))
        return refuse(429, 'too-many-attempts', 'Too many wrong launch codes; wait a minute and try again')
      }
      const supplied = req.headers?.['x-meeting-launch-code']
      if (typeof supplied !== 'string' || !supplied) return refuse(401, 'launch-code-required', 'A launch code is required')
      if (!secretsEqual(supplied, launchCode)) {
        launchFailures.push(now)
        return refuse(401, 'launch-code-invalid', 'The launch code was not accepted')
      }
      return next()
    }
  }

  return {
    requireAdmin,
    requireMeetingWriter,
    requireLaunchCode,
    issueTicket,
    /** For connections that cannot send an Authorization header (browser WebSocket): same result as a header. */
    authenticateToken: principalForToken,
    ticketTtlSeconds,
    launchEnabled,
    enabled: { admin: adminEnabled, tickets: ticketsEnabled }
  }
}
