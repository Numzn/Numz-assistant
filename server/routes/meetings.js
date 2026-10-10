import { Router } from 'express'
import { MeetingDomainError } from '../meetings/meetingDomain.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_METADATA_BYTES = 16 * 1024
const MAX_TITLE_LENGTH = 120
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/

/**
 * Meeting API. Credentials per route (see server/auth/meetingAuth.js):
 *   admin      - create, lifecycle (start, pause, resume, recover, cancel, fail), reads, ticket minting
 *   admin|ticket (bound to the meeting) - speech-session attach/end, canonical segment append, ending the meeting
 *   launch code - starting a NEW meeting from the browser (POST /launch), nothing else
 */
function badRequest(message, code) {
  return new MeetingDomainError(message, { statusCode: 400, code })
}

function requireUuid(value, code, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw badRequest(`${label} must be a UUID`, code)
  return value
}

function meetingIdFrom(req) {
  return requireUuid(req.params.meetingId, 'invalid-meeting-id', 'meetingId')
}

function metadataFrom(body) {
  const metadata = body?.metadata ?? {}
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw badRequest('metadata must be an object', 'invalid-metadata')
  }
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
    throw badRequest(`metadata exceeds ${MAX_METADATA_BYTES} bytes`, 'invalid-metadata')
  }
  // The server records why a meeting was cancelled or failed under this key.
  if (Object.hasOwn(metadata, 'closeReason')) throw badRequest('metadata.closeReason is reserved', 'invalid-metadata')
  return metadata
}

/** The Idempotency-Key header: absent is fine, present-but-malformed is refused rather than silently ignored. */
function idempotencyKeyFrom(req) {
  const raw = req.headers?.['idempotency-key']
  if (raw === undefined) return null
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY_RE.test(raw)) {
    throw badRequest('Idempotency-Key must be 16 to 64 letters, digits, "_" or "-"', 'invalid-idempotency-key')
  }
  return raw
}

function titleFrom(body) {
  const title = body?.title
  if (title === undefined || title === null || title === '') return null
  if (typeof title !== 'string') throw badRequest('title must be a string', 'invalid-title')
  const trimmed = title.trim()
  if (trimmed.length > MAX_TITLE_LENGTH) throw badRequest(`title is longer than ${MAX_TITLE_LENGTH} characters`, 'invalid-title')
  return trimmed || null
}

export function createMeetingsRouter({ meetingService, auth, intelligenceService = null }) {
  if (!meetingService || !auth) throw new Error('meetingService and auth are required')
  const router = Router()

  router.post('/', auth.requireAdmin(), (req, res) => {
    const meeting = meetingService.createMeeting(metadataFrom(req.body))
    res.status(201).json({ ...meeting, ticket: auth.issueTicket(meeting.meetingId) })
  })

  // Launch session: type the code once and meetings can then be started (by voice or button) without it. The
  // session is a cookie the browser's JavaScript cannot read, and it authorises starting a meeting only.
  router.get('/launch/session', (req, res) => {
    res.json(auth.launchSessionStatus(req))
  })

  router.post('/launch/session', auth.requireLaunchCode(), (req, res) => {
    const { expiresAt } = auth.startLaunchSession(req, res)
    res.json({ authenticated: true, expiresAt })
  })

  router.delete('/launch/session', (req, res) => {
    auth.endLaunchSession(req, res)
    res.status(204).end()
  })

  // The browser's way in: create the meeting, start it and hand back its own ticket in one step.
  // Nothing is created unless a ticket can be issued, and a meeting that cannot be started is cancelled.
  // With an Idempotency-Key, repeating the same attempt returns the same meeting (200, `reused`) with a fresh
  // ticket, so a double trigger or a retry after a lost answer cannot leave two meetings recording.
  router.post('/launch', auth.requireLaunchAccess(), (req, res) => {
    const title = titleFrom(req.body)
    const launchKey = idempotencyKeyFrom(req)
    if (req.launchVia === 'code') auth.startLaunchSession(req, res)

    if (launchKey) {
      const existing = meetingService.findActiveByLaunchKey(launchKey)
      if (existing) {
        const ticket = auth.issueTicket(existing.meetingId)
        if (ticket) return res.status(200).json({ ...existing, ticket, reused: true })
      }
    }

    const meeting = meetingService.createMeeting({
      source: 'browser',
      ...(title ? { title } : {}),
      ...(launchKey ? { launchKey } : {})
    })
    let started
    try {
      started = meetingService.startMeeting(meeting.meetingId)
    } catch (err) {
      meetingService.cancelMeeting(meeting.meetingId, { reason: 'launch-failed' })
      throw err
    }
    const ticket = auth.issueTicket(meeting.meetingId)
    if (!ticket) {
      meetingService.cancelMeeting(meeting.meetingId, { reason: 'launch-failed' })
      throw new MeetingDomainError('Meeting tickets are not configured on this server', {
        statusCode: 503,
        code: 'auth-not-configured'
      })
    }
    res.status(201).json({ ...started, ticket })
  })

  router.get('/:meetingId', auth.requireAdmin(), (req, res) => {
    res.json(meetingService.getMeeting(meetingIdFrom(req)))
  })

  router.post('/:meetingId/ticket', auth.requireAdmin(), (req, res) => {
    const meetingId = meetingIdFrom(req)
    meetingService.getMeeting(meetingId)
    const ticket = auth.issueTicket(meetingId)
    if (!ticket) {
      return res.status(503).json({
        error: 'Meeting tickets are not configured on this server',
        code: 'auth-not-configured',
        requestId: req.id
      })
    }
    return res.status(201).json({ meetingId, ticket })
  })

  router.post('/:meetingId/start', auth.requireAdmin(), (req, res) => {
    res.json(meetingService.startMeeting(meetingIdFrom(req)))
  })

  router.post('/:meetingId/pause', auth.requireAdmin(), (req, res) => {
    res.json(meetingService.pauseMeeting(meetingIdFrom(req)))
  })

  router.post('/:meetingId/resume', auth.requireAdmin(), (req, res) => {
    res.json(meetingService.resumeMeeting(meetingIdFrom(req)))
  })

  router.post('/:meetingId/recover', auth.requireAdmin(), (req, res) => {
    res.json(meetingService.recoverMeeting(meetingIdFrom(req)))
  })

  // Refused with 409 (and the meeting left untouched) while committed segments are missing
  // (`transcript-incomplete`) or a speech session that produced transcript is still open (`speech-session-active`).
  // The ticket holder may end its own meeting (the browser that launched it); no other lifecycle step.
  router.post('/:meetingId/end', auth.requireMeetingWriter(), (req, res) => {
    res.json(meetingService.endMeeting(meetingIdFrom(req)))
  })

  router.post('/:meetingId/cancel', auth.requireAdmin(), (req, res) => {
    res.json(meetingService.cancelMeeting(meetingIdFrom(req), { reason: req.body?.reason }))
  })

  router.post('/:meetingId/fail', auth.requireAdmin(), (req, res) => {
    res.json(meetingService.failMeeting(meetingIdFrom(req), { reason: req.body?.reason }))
  })

  router.get('/:meetingId/sessions', auth.requireAdmin(), (req, res) => {
    const meetingId = meetingIdFrom(req)
    res.json({ meetingId, speechSessions: meetingService.listSpeechSessions(meetingId) })
  })

  router.post('/:meetingId/sessions', auth.requireMeetingWriter(), (req, res) => {
    res.status(201).json(meetingService.attachSpeechSession(meetingIdFrom(req)))
  })

  router.post('/:meetingId/sessions/:speechSessionId/end', auth.requireMeetingWriter(), (req, res) => {
    const meetingId = meetingIdFrom(req)
    const speechSessionId = requireUuid(req.params.speechSessionId, 'invalid-speech-session-id', 'speechSessionId')
    if (typeof req.body?.reason !== 'string') throw badRequest('reason is required', 'invalid-end-reason')
    res.json(
      meetingService.endSpeechSession(meetingId, speechSessionId, req.body.reason, {
        committedSegments: req.body.committedSegments
      })
    )
  })

  router.post('/:meetingId/transcript/final', auth.requireMeetingWriter(), (req, res) => {
    const meetingId = meetingIdFrom(req)
    const speechSessionId = requireUuid(req.body?.speechSessionId, 'invalid-speech-session-id', 'speechSessionId')
    const result = meetingService.appendFinalSegment(meetingId, { speechSessionId, segment: req.body?.segment })

    if (result.status === 'INSERTED') return res.status(201).json(result)
    if (result.status === 'ALREADY_EXISTS') return res.status(200).json(result)
    // Same id, different content: a real collision. Never report it as success.
    throw new MeetingDomainError(`Segment ${result.segment?.id} already exists with different content`, {
      statusCode: 409,
      code: 'segment-id-conflict'
    })
  })

  router.get('/:meetingId/transcript', auth.requireAdmin(), (req, res) => {
    const meetingId = meetingIdFrom(req)
    res.json({ meetingId, segments: meetingService.getTranscript(meetingId), integrity: meetingService.getIntegrity(meetingId) })
  })

  // Intelligence is computed from the SAVED transcript of the named meeting: no text is accepted from the caller.
  if (intelligenceService) {
    // Questions, action items and decisions found in the words themselves. No model, no cost.
    router.get('/:meetingId/intelligence', auth.requireAdmin(), (req, res) => {
      res.json(intelligenceService.signals(meetingIdFrom(req)))
    })

    // A model's summary and notes, each item checked against the transcript. Sends the transcript to the
    // configured AI provider, so it is a deliberate request, and refused until the transcript is final.
    router.post('/:meetingId/intelligence/notes', auth.requireAdmin(), (req, res, next) => {
      const meetingId = meetingIdFrom(req)
      const allowUnverified = req.body?.allowUnverified === true
      intelligenceService
        .notes(meetingId, { allowUnverified })
        .then((result) => res.json(result))
        .catch(next)
    })
  }

  return router
}
