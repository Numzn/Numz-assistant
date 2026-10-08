import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDatabase } from './sqliteDatabase.js'
import { createMeetingRepository } from './meetingRepository.js'
import { createSpeechSessionRepository } from './speechSessionRepository.js'
import { createTranscriptRepository } from './transcriptRepository.js'
import { createMeetingSessionService } from '../services/meetingSessionService.js'
import { MEETING_STATES as S, MeetingDomainError } from '../meetings/meetingDomain.js'

/** A test clock the caller moves forward explicitly, so timeline assertions are exact. */
function makeClock(startMs = Date.parse('2026-10-08T10:00:00.000Z')) {
  let now = startMs
  return { now: () => now, advanceSeconds: (s) => (now += s * 1000) }
}

function makeService(database, clock) {
  return createMeetingSessionService({
    meetingRepository: createMeetingRepository(database),
    speechSessionRepository: createSpeechSessionRepository(database),
    transcriptRepository: createTranscriptRepository(database),
    clock: clock.now
  })
}

/** Minimal canonical segment as the speech transport produces it (session-relative seconds). */
function seg(id, start, end, text, extra = {}) {
  return { id, start, end, text, speaker: null, words: [], confidence: null, language: 'en', uncertain: true, ...extra }
}

/** IDs that are unique across sessions by construction: a session UUID plus a sequence number. */
const segId = (sessionId, n) => `seg_${sessionId.slice(0, 8)}_${String(n).padStart(4, '0')}`
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

test('the same final event delivered twice is stored once: INSERTED, then ALREADY_EXISTS', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession } = service.startMeeting(meeting.meetingId)
  const event = { speechSessionId: speechSession.speechSessionId, segment: seg(segId(UUID_A, 1), 1, 2, 'hello') }

  const first = service.appendFinalSegment(meeting.meetingId, event)
  const second = service.appendFinalSegment(meeting.meetingId, event)

  assert.equal(first.status, 'INSERTED')
  assert.equal(second.status, 'ALREADY_EXISTS')
  assert.equal(service.getTranscript(meeting.meetingId).length, 1)
})

test('different segments never collide, even when every session numbers from 1', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession: a } = service.startMeeting(meeting.meetingId)
  // Session A emits seg 1 and 2; session B emits its own seg 1 and 2 (the old per-session counter case).
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: a.speechSessionId, segment: seg(segId(UUID_A, 1), 0, 1, 'a one') })
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: a.speechSessionId, segment: seg(segId(UUID_A, 2), 2, 3, 'a two') })
  clock.advanceSeconds(10)
  const b = service.attachSpeechSession(meeting.meetingId)
  const r1 = service.appendFinalSegment(meeting.meetingId, { speechSessionId: b.speechSessionId, segment: seg(segId(UUID_B, 1), 0, 1, 'b one') })
  const r2 = service.appendFinalSegment(meeting.meetingId, { speechSessionId: b.speechSessionId, segment: seg(segId(UUID_B, 2), 2, 3, 'b two') })

  assert.equal(r1.status, 'INSERTED')
  assert.equal(r2.status, 'INSERTED')
  assert.equal(service.getTranscript(meeting.meetingId).length, 4)
})

test('same id with different content is a CONFLICT: nothing is overwritten and nothing is reported as saved', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession } = service.startMeeting(meeting.meetingId)
  const id = segId(UUID_A, 1)
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: speechSession.speechSessionId, segment: seg(id, 0, 1, 'original') })

  const collision = service.appendFinalSegment(meeting.meetingId, {
    speechSessionId: speechSession.speechSessionId,
    segment: seg(id, 0, 1, 'different text')
  })

  assert.equal(collision.status, 'CONFLICT')
  assert.equal(collision.inserted, false)
  assert.deepEqual(service.getTranscript(meeting.meetingId).map((s) => s.text), ['original'])
})

test('meeting timeline: a reconnected session never moves time backwards', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession: a } = service.startMeeting(meeting.meetingId)
  for (const [n, start] of [[1, 5], [2, 10], [3, 15]]) {
    service.appendFinalSegment(meeting.meetingId, { speechSessionId: a.speechSessionId, segment: seg(segId(UUID_A, n), start, start + 1, `a${n}`) })
  }

  clock.advanceSeconds(20) // connection dropped; 20 s of wall-clock time passed on the meeting
  const b = service.attachSpeechSession(meeting.meetingId)
  assert.ok(b.timelineOffsetMs >= 20_000, `offset ${b.timelineOffsetMs} must include elapsed time`)
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: b.speechSessionId, segment: seg(segId(UUID_B, 1), 2, 3, 'b1') })
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: b.speechSessionId, segment: seg(segId(UUID_B, 2), 8, 9, 'b2') })

  const transcript = service.getTranscript(meeting.meetingId)
  assert.deepEqual(transcript.map((s) => s.text), ['a1', 'a2', 'a3', 'b1', 'b2'])
  for (let i = 1; i < transcript.length; i++) {
    assert.ok(transcript[i].start >= transcript[i - 1].end - 1e-9, `segment ${transcript[i].id} overlaps its predecessor`)
  }
  assert.ok(transcript[3].start >= 20, 'session B segments must sit after the disconnect, not at 2 s')
  assert.equal(transcript[3].sessionStart, 2, 'session-relative time is kept for traceability')
})

test('attaching a session supersedes the active one; both remain in the record', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession: a } = service.startMeeting(meeting.meetingId)
  clock.advanceSeconds(5)
  const b = service.attachSpeechSession(meeting.meetingId)

  const sessions = service.listSpeechSessions(meeting.meetingId)
  assert.equal(sessions.length, 2)
  const previous = sessions.find((s) => s.speechSessionId === a.speechSessionId)
  assert.equal(previous.status, 'ENDED')
  assert.equal(previous.endReason, 'superseded')
  assert.equal(sessions.find((s) => s.speechSessionId === b.speechSessionId).status, 'ACTIVE')
})

test('a completed meeting rejects transcript appends and new sessions with 409', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession } = service.startMeeting(meeting.meetingId)
  service.beginFinalization(meeting.meetingId)
  service.completeMeeting(meeting.meetingId)

  assert.throws(
    () => service.appendFinalSegment(meeting.meetingId, { speechSessionId: speechSession.speechSessionId, segment: seg(segId(UUID_A, 9), 0, 1, 'late') }),
    (err) => err instanceof MeetingDomainError && err.statusCode === 409 && err.code === 'meeting-not-accepting-transcript'
  )
  assert.throws(() => service.attachSpeechSession(meeting.meetingId), (err) => err.statusCode === 409)
  assert.equal(service.getTranscript(meeting.meetingId).length, 0)
})

test('invalid lifecycle requests are 409 domain errors, not generic failures', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  assert.throws(() => service.pauseMeeting(meeting.meetingId), (err) => err.statusCode === 409 && err.code === 'invalid-meeting-transition')
  assert.throws(() => service.getMeeting('no-such-meeting'), (err) => err.statusCode === 404 && err.code === 'meeting-not-found')
})

test('invalid segments are rejected with a 400 and nothing is stored', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession } = service.startMeeting(meeting.meetingId)
  const bad = [
    seg(segId(UUID_A, 1), 5, 1, 'end before start'),
    seg(segId(UUID_A, 2), 0, 1, '   '),
    seg('bad id with spaces', 0, 1, 'x'),
    seg(segId(UUID_A, 3), 0, 1, 'no flag', { uncertain: undefined })
  ]
  for (const segment of bad) {
    assert.throws(
      () => service.appendFinalSegment(meeting.meetingId, { speechSessionId: speechSession.speechSessionId, segment }),
      (err) => err.statusCode === 400 && err.code === 'invalid-segment'
    )
  }
  assert.equal(service.getTranscript(meeting.meetingId).length, 0)
})

test('the legacy bare-segment call form routes to the active session', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  service.startMeeting(meeting.meetingId)
  const result = service.appendFinalSegment(meeting.meetingId, seg(segId(UUID_A, 1), 0, 1, 'legacy'))
  assert.equal(result.status, 'INSERTED')
})

test('a RECOVERING meeting can be finalized without resuming capture', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  service.startMeeting(meeting.meetingId)
  service.recoverMeeting(meeting.meetingId)
  service.beginFinalization(meeting.meetingId)
  assert.equal(service.completeMeeting(meeting.meetingId).status, S.COMPLETED)
})

test('process restart: active sessions end, meetings become RECOVERING, data survives, duplicates stay safe', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meeting-restart-'))
  const file = path.join(dir, 'speech.sqlite')
  try {
    const clock = makeClock()
    const db1 = createDatabase({ filename: file })
    const first = makeService(db1, clock)
    const meeting = first.createMeeting()
    const { speechSession: a } = first.startMeeting(meeting.meetingId)
    const kept = seg(segId(UUID_A, 1), 0, 1, 'before the crash')
    first.appendFinalSegment(meeting.meetingId, { speechSessionId: a.speechSessionId, segment: kept })
    db1.close() // the process goes away here

    clock.advanceSeconds(60)
    const db2 = createDatabase({ filename: file })
    const second = makeService(db2, clock)
    assert.deepEqual(second.recoverInterruptedMeetings(), { endedSessions: 1, recoveredMeetings: 1 })
    assert.equal(second.getMeeting(meeting.meetingId).status, S.RECOVERING)
    assert.equal(second.listSpeechSessions(meeting.meetingId)[0].endReason, 'process-restart')

    // The outbox replays the same event after restart: it must not duplicate.
    const replay = second.appendFinalSegment(meeting.meetingId, { speechSessionId: a.speechSessionId, segment: kept })
    assert.equal(replay.status, 'ALREADY_EXISTS')

    const b = second.attachSpeechSession(meeting.meetingId)
    second.resumeMeeting(meeting.meetingId)
    second.appendFinalSegment(meeting.meetingId, { speechSessionId: b.speechSessionId, segment: seg(segId(UUID_B, 1), 0, 1, 'after restart') })
    second.beginFinalization(meeting.meetingId)
    second.completeMeeting(meeting.meetingId)

    const texts = second.getTranscript(meeting.meetingId).map((s) => s.text)
    assert.deepEqual(texts, ['before the crash', 'after restart'])
    db2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
