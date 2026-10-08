import { randomUUID } from 'node:crypto'

export const MEETING_STATES = Object.freeze({
  CREATED: 'CREATED',
  STARTING: 'STARTING',
  LIVE: 'LIVE',
  PAUSED: 'PAUSED',
  RECOVERING: 'RECOVERING',
  FINALIZING: 'FINALIZING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
})

const S = MEETING_STATES

const transitions = {
  [S.CREATED]: new Set([S.STARTING, S.CANCELLED, S.FAILED]),
  [S.STARTING]: new Set([S.LIVE, S.RECOVERING, S.FAILED, S.CANCELLED]),
  [S.LIVE]: new Set([S.PAUSED, S.RECOVERING, S.FINALIZING, S.FAILED, S.CANCELLED]),
  [S.PAUSED]: new Set([S.LIVE, S.RECOVERING, S.FINALIZING, S.FAILED, S.CANCELLED]),
  // RECOVERING may finalize directly: a meeting interrupted by a restart can be ended without resuming capture.
  [S.RECOVERING]: new Set([S.STARTING, S.LIVE, S.FINALIZING, S.FAILED, S.CANCELLED]),
  [S.FINALIZING]: new Set([S.COMPLETED, S.FAILED]),
  [S.COMPLETED]: new Set(),
  [S.FAILED]: new Set(),
  [S.CANCELLED]: new Set()
}

/**
 * Domain error carrying an HTTP-facing classification. The API layer maps
 * statusCode to the response and exposes `message` and `code` (never stacks).
 */
export class MeetingDomainError extends Error {
  constructor(message, { statusCode = 409, code = 'meeting-conflict', details = null } = {}) {
    super(message)
    this.name = 'MeetingDomainError'
    this.statusCode = statusCode
    this.code = code
    this.expose = true
    // Structured, safe-to-return facts that help the caller act (for example which sessions are incomplete).
    this.details = details
  }
}

/** A meeting in one of these states is closed: it accepts nothing and never reopens. */
export const TERMINAL_MEETING_STATES = Object.freeze([S.COMPLETED, S.FAILED, S.CANCELLED])

/** Meeting states that accept canonical transcript appends. FINALIZING accepts late, already-produced events. */
export const TRANSCRIPT_ACCEPTING_STATES = Object.freeze(
  new Set([S.STARTING, S.LIVE, S.PAUSED, S.RECOVERING, S.FINALIZING])
)

/** Meeting states in which a new speech session may be attached. */
export const SESSION_ATTACHABLE_STATES = Object.freeze(new Set([S.STARTING, S.LIVE, S.RECOVERING]))

export const SPEECH_SESSION_END_REASONS = Object.freeze([
  'stopped',
  'disconnected',
  'superseded',
  'process-restart',
  'meeting-completed',
  'error'
])

export function canTransition(from, to) {
  return from === to || transitions[from]?.has(to) === true
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new MeetingDomainError(`Invalid meeting transition: ${from} -> ${to}`, {
      statusCode: 409,
      code: 'invalid-meeting-transition'
    })
  }
}

export function createMeeting({ meetingId = randomUUID(), metadata = {}, now = new Date().toISOString() } = {}) {
  return {
    meetingId,
    status: S.CREATED,
    createdAt: now,
    startedAt: null,
    pausedAt: null,
    endedAt: null,
    updatedAt: now,
    metadata
  }
}

export function transitionMeeting(meeting, status, now = new Date().toISOString()) {
  assertTransition(meeting.status, status)
  // Repeating the current state is a safe no-op. In particular a closed meeting is never rewritten,
  // so its end time cannot drift when a client retries.
  if (meeting.status === status) return meeting
  const next = { ...meeting, status, updatedAt: now }

  if (status === S.LIVE && meeting.startedAt === null) next.startedAt = now
  if (status === S.PAUSED) next.pausedAt = now
  if ([S.COMPLETED, S.FAILED, S.CANCELLED].includes(status)) {
    next.endedAt = now
  }
  return next
}

export function isRecoverableMeetingStatus(status) {
  return [S.STARTING, S.LIVE, S.PAUSED, S.RECOVERING].includes(status)
}
