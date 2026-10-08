import assert from 'node:assert/strict'
import test from 'node:test'
import { MEETING_STATES as S, MeetingDomainError, canTransition, transitionMeeting, createMeeting } from './meetingDomain.js'

// The full transition table, written out explicitly so any change to the state machine is a visible test diff.
const EXPECTED = {
  [S.CREATED]: [S.STARTING, S.CANCELLED, S.FAILED],
  [S.STARTING]: [S.LIVE, S.RECOVERING, S.FAILED, S.CANCELLED],
  [S.LIVE]: [S.PAUSED, S.RECOVERING, S.FINALIZING, S.FAILED, S.CANCELLED],
  [S.PAUSED]: [S.LIVE, S.RECOVERING, S.FINALIZING, S.FAILED, S.CANCELLED],
  [S.RECOVERING]: [S.STARTING, S.LIVE, S.FINALIZING, S.FAILED, S.CANCELLED],
  [S.FINALIZING]: [S.COMPLETED, S.FAILED],
  [S.COMPLETED]: [],
  [S.FAILED]: [],
  [S.CANCELLED]: []
}

test('transition table matches the documented state machine exactly', () => {
  for (const from of Object.values(S)) {
    for (const to of Object.values(S)) {
      const expected = from === to || EXPECTED[from].includes(to)
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`)
    }
  }
})

test('invalid transitions raise a 409 domain error with a stable code', () => {
  const created = createMeeting({ meetingId: 'm' })
  assert.throws(
    () => transitionMeeting(created, S.LIVE),
    (err) =>
      err instanceof MeetingDomainError && err.statusCode === 409 && err.code === 'invalid-meeting-transition'
  )
})

test('terminal states accept nothing except a no-op to themselves', () => {
  for (const terminal of [S.COMPLETED, S.FAILED, S.CANCELLED]) {
    assert.deepEqual(
      Object.values(S).filter((to) => to !== terminal && canTransition(terminal, to)),
      []
    )
  }
})

test('repeating the current state changes nothing, so a closed meeting is never rewritten', () => {
  const closedAt = '2026-10-08T10:00:00.000Z'
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED']) {
    const closed = { ...createMeeting({ now: closedAt }), status, endedAt: closedAt, updatedAt: closedAt }
    const again = transitionMeeting(closed, status, '2026-10-08T11:00:00.000Z')
    assert.equal(again, closed, `${status}: the same record is returned untouched`)
    assert.equal(again.endedAt, closedAt)
    assert.equal(again.updatedAt, closedAt)
  }
})
