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

const transitions = {
  [MEETING_STATES.CREATED]: new Set([MEETING_STATES.STARTING, MEETING_STATES.CANCELLED, MEETING_STATES.FAILED]),
  [MEETING_STATES.STARTING]: new Set([MEETING_STATES.LIVE, MEETING_STATES.RECOVERING, MEETING_STATES.FAILED, MEETING_STATES.CANCELLED]),
  [MEETING_STATES.LIVE]: new Set([MEETING_STATES.PAUSED, MEETING_STATES.RECOVERING, MEETING_STATES.FINALIZING, MEETING_STATES.FAILED, MEETING_STATES.CANCELLED]),
  [MEETING_STATES.PAUSED]: new Set([MEETING_STATES.LIVE, MEETING_STATES.RECOVERING, MEETING_STATES.FINALIZING, MEETING_STATES.FAILED, MEETING_STATES.CANCELLED]),
  [MEETING_STATES.RECOVERING]: new Set([MEETING_STATES.STARTING, MEETING_STATES.LIVE, MEETING_STATES.FAILED, MEETING_STATES.CANCELLED]),
  [MEETING_STATES.FINALIZING]: new Set([MEETING_STATES.COMPLETED, MEETING_STATES.FAILED]),
  [MEETING_STATES.COMPLETED]: new Set(),
  [MEETING_STATES.FAILED]: new Set(),
  [MEETING_STATES.CANCELLED]: new Set()
}

export function canTransition(from, to) {
  return from === to || transitions[from]?.has(to) === true
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const error = new Error(`Invalid meeting transition: ${from} -> ${to}`)
    error.code = 'invalid-meeting-transition'
    throw error
  }
}

export function createMeeting({ meetingId = randomUUID(), metadata = {}, now = new Date().toISOString() } = {}) {
  return {
    meetingId,
    status: MEETING_STATES.CREATED,
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
  const next = { ...meeting, status, updatedAt: now }

  if (status === MEETING_STATES.LIVE && meeting.startedAt === null) next.startedAt = now
  if (status === MEETING_STATES.PAUSED) next.pausedAt = now
  if ([MEETING_STATES.COMPLETED, MEETING_STATES.FAILED, MEETING_STATES.CANCELLED].includes(status)) {
    next.endedAt = now
  }
  return next
}

export function isRecoverableMeetingStatus(status) {
  return [
    MEETING_STATES.STARTING,
    MEETING_STATES.LIVE,
    MEETING_STATES.PAUSED,
    MEETING_STATES.RECOVERING
  ].includes(status)
}
