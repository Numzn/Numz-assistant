import { Router } from 'express'
import { MeetingDomainError } from '../meetings/meetingDomain.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_METADATA_BYTES = 16 * 1024

/**
 * Meeting API. Credentials per route (see server/auth/meetingAuth.js):
 *   admin      - create, lifecycle, reads, ticket minting, session listing
 *   admin|ticket (bound to the meeting) - speech-session attach/end, canonical segment append
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
  return metadata
}

export function createMeetingsRouter({ meetingService, auth }) {
  if (!meetingService || !auth) throw new Error('meetingService and auth are required')
  const router = Router()

  router.post('/', auth.requireAdmin(), (req, res) => {
    const meeting = meetingService.createMeeting(metadataFrom(req.body))
    res.status(201).json({ ...meeting, ticket: auth.issueTicket(meeting.meetingId) })
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

  router.post('/:meetingId/end', auth.requireAdmin(), (req, res) => {
    const meetingId = meetingIdFrom(req)
    meetingService.beginFinalization(meetingId)
    res.json(meetingService.completeMeeting(meetingId))
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
    res.json(meetingService.endSpeechSession(meetingId, speechSessionId, req.body.reason))
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
    res.json({ meetingId, segments: meetingService.getTranscript(meetingId) })
  })

  return router
}
