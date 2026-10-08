import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEETING_STATES,
  assertTransition,
  createMeeting,
  isRecoverableMeetingStatus,
  transitionMeeting
} from './meetingDomain.js'

test('meeting lifecycle accepts valid transitions and timestamps them', () => {
  const created = createMeeting({ meetingId: 'meeting-1', now: '2026-10-08T00:00:00.000Z' })
  const starting = transitionMeeting(created, MEETING_STATES.STARTING, '2026-10-08T00:00:01.000Z')
  const live = transitionMeeting(starting, MEETING_STATES.LIVE, '2026-10-08T00:00:02.000Z')
  const paused = transitionMeeting(live, MEETING_STATES.PAUSED, '2026-10-08T00:00:03.000Z')
  const resumed = transitionMeeting(paused, MEETING_STATES.LIVE, '2026-10-08T00:00:04.000Z')
  const finalizing = transitionMeeting(resumed, MEETING_STATES.FINALIZING, '2026-10-08T00:00:05.000Z')
  const completed = transitionMeeting(finalizing, MEETING_STATES.COMPLETED, '2026-10-08T00:00:06.000Z')

  assert.equal(completed.status, MEETING_STATES.COMPLETED)
  assert.equal(completed.startedAt, '2026-10-08T00:00:02.000Z')
  assert.equal(completed.pausedAt, '2026-10-08T00:00:03.000Z')
  assert.equal(completed.endedAt, '2026-10-08T00:00:06.000Z')
})

test('invalid transitions are rejected', () => {
  const created = createMeeting()
  assert.throws(
    () => transitionMeeting(created, MEETING_STATES.LIVE),
    /Invalid meeting transition/
  )
  assert.throws(
    () => assertTransition(MEETING_STATES.COMPLETED, MEETING_STATES.LIVE),
    /Invalid meeting transition/
  )
})

test('recovery statuses are explicit', () => {
  assert.equal(isRecoverableMeetingStatus(MEETING_STATES.LIVE), true)
  assert.equal(isRecoverableMeetingStatus(MEETING_STATES.COMPLETED), false)
})
