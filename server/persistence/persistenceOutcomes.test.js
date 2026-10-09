import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations, createDatabase } from './sqliteDatabase.js'
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
/** A LIVE meeting with one speech session attached, as when the speech transport connects. */
function startLive(service, meetingId) {
  const meeting = service.startMeeting(meetingId)
  return { meeting, speechSession: service.attachSpeechSession(meetingId) }
}

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

test('the same final event delivered twice is stored once: INSERTED, then ALREADY_EXISTS', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession } = startLive(service, meeting.meetingId)
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
  const { speechSession: a } = startLive(service, meeting.meetingId)
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
  const { speechSession } = startLive(service, meeting.meetingId)
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
  const { speechSession: a } = startLive(service, meeting.meetingId)
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
  const { speechSession: a } = startLive(service, meeting.meetingId)
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
  const { speechSession } = startLive(service, meeting.meetingId)
  service.endSpeechSession(meeting.meetingId, speechSession.speechSessionId, 'stopped', { committedSegments: 0 })
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
  const { speechSession } = startLive(service, meeting.meetingId)
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

test('a segment that does not name its speech session is refused: identity is never guessed', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  startLive(service, meeting.meetingId)
  const refused = (err) => err.statusCode === 400 && err.code === 'invalid-speech-session-id'
  assert.throws(() => service.appendFinalSegment(meeting.meetingId, { segment: seg(segId(UUID_A, 1), 0, 1, 'orphan') }), refused)
  assert.throws(() => service.appendFinalSegment(meeting.meetingId, seg(segId(UUID_A, 1), 0, 1, 'bare segment')), refused)
  assert.equal(service.getTranscript(meeting.meetingId).length, 0)
})

test('starting a meeting creates no speech session; each connection attaches its own', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  assert.equal(service.startMeeting(meeting.meetingId).status, S.LIVE)
  assert.deepEqual(service.listSpeechSessions(meeting.meetingId), [])
  const a = service.attachSpeechSession(meeting.meetingId)
  const b = service.attachSpeechSession(meeting.meetingId) // same instant on the fixed clock: attach order must still hold
  assert.deepEqual(service.listSpeechSessions(meeting.meetingId).map((x) => x.speechSessionId), [a.speechSessionId, b.speechSessionId])
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
    const { speechSession: a } = startLive(first, meeting.meetingId)
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

    // Ending the meeting while session B is still streaming transcript is refused and changes nothing.
    assert.throws(
      () => second.endMeeting(meeting.meetingId),
      (err) => err.statusCode === 409 && err.code === 'speech-session-active'
    )
    assert.equal(second.getMeeting(meeting.meetingId).status, S.LIVE)

    // The transport stops its stream and reports how many segments it produced, then the meeting can end.
    second.endSpeechSession(meeting.meetingId, b.speechSessionId, 'stopped', { committedSegments: 1 })
    const done = second.endMeeting(meeting.meetingId)
    assert.equal(done.status, S.COMPLETED)
    assert.equal(done.integrity.complete, true)
    assert.equal(done.integrity.verified, false, 'session A ended with the old process and never reported its count')
    assert.equal(done.integrity.unverifiedSessions, 1)

    const texts = second.getTranscript(meeting.meetingId).map((s) => s.text)
    assert.deepEqual(texts, ['before the crash', 'after restart'])
    db2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a meeting cannot end while committed segments are missing; it ends once they arrive, and a refusal changes nothing', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  const { speechSession } = startLive(service, meeting.meetingId)
  const sid = speechSession.speechSessionId
  const delivered = seg(segId(UUID_A, 1), 0, 1, 'delivered')
  const stuck = seg(segId(UUID_A, 2), 2, 3, 'still in the transport outbox')
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: sid, segment: delivered })
  // The transport committed two segments, but only one reached the API before it stopped.
  service.endSpeechSession(meeting.meetingId, sid, 'stopped', { committedSegments: 2 })

  assert.throws(
    () => service.endMeeting(meeting.meetingId),
    (err) => {
      assert.equal(err.statusCode, 409)
      assert.equal(err.code, 'transcript-incomplete')
      assert.equal(err.details.complete, false)
      assert.equal(err.details.missingSegments, 1)
      assert.equal(err.details.sessions.find((entry) => entry.speechSessionId === sid).state, 'INCOMPLETE')
      return true
    }
  )
  assert.equal(service.getMeeting(meeting.meetingId).status, S.LIVE, 'a refusal leaves the meeting exactly as it was')

  // The late delivery from the outbox lands (accepted from an ended session), and now the meeting can end.
  assert.equal(service.appendFinalSegment(meeting.meetingId, { speechSessionId: sid, segment: stuck }).status, 'INSERTED')
  const done = service.endMeeting(meeting.meetingId)
  assert.equal(done.status, S.COMPLETED)
  assert.equal(done.integrity.verified, true)
  assert.equal(done.integrity.sessions.find((entry) => entry.speechSessionId === sid).state, 'VERIFIED')
})

test('more stored than reported is INCONSISTENT and blocks completion instead of being trusted', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  const { speechSession } = startLive(service, meeting.meetingId)
  const sid = speechSession.speechSessionId
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: sid, segment: seg(segId(UUID_A, 1), 0, 1, 'one') })
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: sid, segment: seg(segId(UUID_A, 2), 2, 3, 'two') })
  service.endSpeechSession(meeting.meetingId, sid, 'stopped', { committedSegments: 1 })
  assert.throws(
    () => service.endMeeting(meeting.meetingId),
    (err) => err.code === 'transcript-incomplete' && err.details.sessions.some((entry) => entry.state === 'INCONSISTENT')
  )
})

test('REGRESSION: a session that never reported is never verified, even when nothing is stored for it', () => {
  // The transport attaches, the API is down for the whole session, so nothing is delivered and nothing is
  // reported. Then the API restarts. The session now looks exactly like an empty one, but its committed
  // segments may still be waiting in the transport outbox, where this service cannot see them.
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  service.startMeeting(meeting.meetingId)
  const { speechSessionId } = service.attachSpeechSession(meeting.meetingId)
  service.recoverInterruptedMeetings() // the API restarts: the session ends as process-restart, still unreported

  const report = service.getIntegrity(meeting.meetingId)
  const entry = report.sessions.find((x) => x.speechSessionId === speechSessionId)
  assert.equal(entry.storedSegments, 0)
  assert.equal(entry.endReason, 'process-restart')
  assert.equal(entry.state, 'UNVERIFIED', 'not "empty": nothing here can see the transport outbox')
  assert.equal(report.verified, false, 'the meeting must not claim to be verified')
  assert.equal(report.unverifiedSessions, 1)
  assert.equal(report.complete, true, 'nothing is known to be missing, so ending is still allowed')

  const done = service.endMeeting(meeting.meetingId)
  assert.equal(done.integrity.verified, false)
  assert.equal(done.integrity.unverifiedSessions, 1)
})

test('REGRESSION: a session still active with no report and nothing stored is not verified, and blocks ending', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  service.startMeeting(meeting.meetingId)
  const { speechSessionId } = service.attachSpeechSession(meeting.meetingId)

  const before = service.getIntegrity(meeting.meetingId)
  assert.equal(before.sessions[0].state, 'OPEN', 'still streaming, even though nothing is stored yet')
  assert.equal(before.verified, false)
  assert.equal(before.complete, false)
  assert.throws(() => service.endMeeting(meeting.meetingId), (err) => err.statusCode === 409 && err.code === 'speech-session-active')
  assert.equal(service.getMeeting(meeting.meetingId).status, 'LIVE', 'refusing changes nothing')

  // A lost transport is closed by the operator without a count: then ending is allowed, and never verified.
  service.endSpeechSession(meeting.meetingId, speechSessionId, 'disconnected')
  const done = service.endMeeting(meeting.meetingId)
  assert.equal(done.integrity.sessions.find((x) => x.speechSessionId === speechSessionId).state, 'UNVERIFIED')
  assert.equal(done.integrity.verified, false)
})

test('REGRESSION (2026-10-09): Stop while the recognizer is behind loses no lines', () => {
  // Observed: the user pressed Stop, the browser ended the meeting half a second later while the speech
  // service was still decoding, and the 4 lines that arrived afterwards were refused (409) as "not accepting".
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  service.startMeeting(meeting.meetingId)
  const { speechSessionId } = service.attachSpeechSession(meeting.meetingId)

  // Stop pressed: nothing stored yet, the recognizer is still working. Ending must be refused, not allowed.
  assert.throws(() => service.endMeeting(meeting.meetingId), (err) => err.code === 'speech-session-active')

  // The late lines arrive and the transport reports its count, as the speech service does after its last decode.
  for (let n = 1; n <= 4; n++) {
    const outcome = service.appendFinalSegment(meeting.meetingId, { speechSessionId, segment: seg(segId(speechSessionId, n), n, n + 1, `line ${n}`) })
    assert.equal(outcome.status, 'INSERTED', `line ${n} is accepted, not refused`)
  }
  service.endSpeechSession(meeting.meetingId, speechSessionId, 'stopped', { committedSegments: 4 })

  const done = service.endMeeting(meeting.meetingId)
  assert.equal(done.status, 'COMPLETED')
  assert.equal(done.integrity.verified, true)
  assert.equal(service.getTranscript(meeting.meetingId).length, 4)
})

test('only a report makes a session verified; a late report repairs an unverified one', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())

  const clean = service.createMeeting()
  service.startMeeting(clean.meetingId)
  const stopped = service.attachSpeechSession(clean.meetingId)
  service.endSpeechSession(clean.meetingId, stopped.speechSessionId, 'stopped', { committedSegments: 0 })
  const cleanReport = service.getIntegrity(clean.meetingId)
  assert.equal(cleanReport.sessions[0].state, 'VERIFIED', 'a transport that stopped cleanly said it committed nothing')
  assert.equal(cleanReport.verified, true)

  const crashed = service.createMeeting()
  service.startMeeting(crashed.meetingId)
  const lost = service.attachSpeechSession(crashed.meetingId)
  service.recoverInterruptedMeetings()
  assert.equal(service.getIntegrity(crashed.meetingId).verified, false)
  // The transport comes back and files its count for the session that ended without one.
  service.endSpeechSession(crashed.meetingId, lost.speechSessionId, 'disconnected', { committedSegments: 0 })
  const repaired = service.getIntegrity(crashed.meetingId)
  assert.equal(repaired.sessions[0].state, 'VERIFIED')
  assert.equal(repaired.verified, true)
})

test('a session that stored segments but never reported stays unverified and does not block ending', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  const { speechSession } = startLive(service, meeting.meetingId)
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: speechSession.speechSessionId, segment: seg(segId(UUID_A, 1), 0, 1, 'x') })
  assert.equal(service.getIntegrity(meeting.meetingId).sessions[0].state, 'OPEN', 'active and producing transcript')
  service.endSpeechSession(meeting.meetingId, speechSession.speechSessionId, 'disconnected') // no count reported
  const report = service.getIntegrity(meeting.meetingId)
  assert.equal(report.sessions[0].state, 'UNVERIFIED')
  assert.equal(report.complete, true, 'unknown is not known loss')
  assert.equal(report.verified, false, 'but it is not claimed as verified either')
  assert.equal(service.endMeeting(meeting.meetingId).integrity.unverifiedSessions, 1)
})

test('a count reported after the session already ended is recorded once; the first report wins', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession: a } = startLive(service, meeting.meetingId)
  clock.advanceSeconds(5)
  service.attachSpeechSession(meeting.meetingId) // supersedes A before A's transport could report
  service.appendFinalSegment(meeting.meetingId, { speechSessionId: a.speechSessionId, segment: seg(segId(UUID_A, 1), 0, 1, 'late from A') })

  service.endSpeechSession(meeting.meetingId, a.speechSessionId, 'disconnected', { committedSegments: 1 })
  assert.equal(service.listSpeechSessions(meeting.meetingId).find((x) => x.speechSessionId === a.speechSessionId).committedSegments, 1)
  assert.equal(service.listSpeechSessions(meeting.meetingId).find((x) => x.speechSessionId === a.speechSessionId).endReason, 'superseded', 'the original end reason is kept')
  service.endSpeechSession(meeting.meetingId, a.speechSessionId, 'disconnected', { committedSegments: 99 })
  assert.equal(service.listSpeechSessions(meeting.meetingId).find((x) => x.speechSessionId === a.speechSessionId).committedSegments, 1)
})

test('a malformed committed count is a 400 and changes nothing', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())
  const meeting = service.createMeeting()
  const { speechSession } = startLive(service, meeting.meetingId)
  for (const bad of [-1, 1.5, '3', Number.NaN, 1e12, {}]) {
    assert.throws(
      () => service.endSpeechSession(meeting.meetingId, speechSession.speechSessionId, 'stopped', { committedSegments: bad }),
      (err) => err.statusCode === 400 && err.code === 'invalid-committed-segments',
      `committedSegments ${String(bad)}`
    )
  }
  assert.equal(service.listSpeechSessions(meeting.meetingId)[0].status, 'ACTIVE')
})

test('cancel and fail end the meeting on purpose, record why, close the sessions, and make it immutable', () => {
  const service = makeService(createDatabase({ filename: ':memory:' }), makeClock())

  const cancelled = service.createMeeting()
  const { speechSession } = startLive(service, cancelled.meetingId)
  service.appendFinalSegment(cancelled.meetingId, { speechSessionId: speechSession.speechSessionId, segment: seg(segId(UUID_A, 1), 0, 1, 'kept') })
  const afterCancel = service.cancelMeeting(cancelled.meetingId, { reason: '  wrong room  ' })
  assert.equal(afterCancel.status, S.CANCELLED)
  assert.equal(afterCancel.metadata.closeReason, 'wrong room')
  assert.equal(service.listSpeechSessions(cancelled.meetingId)[0].status, 'ENDED')
  assert.deepEqual(service.getTranscript(cancelled.meetingId).map((x) => x.text), ['kept'], 'stored transcript stays readable')
  assert.throws(
    () => service.appendFinalSegment(cancelled.meetingId, { speechSessionId: speechSession.speechSessionId, segment: seg(segId(UUID_A, 2), 2, 3, 'late') }),
    (err) => err.statusCode === 409 && err.code === 'meeting-not-accepting-transcript'
  )
  assert.throws(() => service.failMeeting(cancelled.meetingId), (err) => err.statusCode === 409 && err.code === 'invalid-meeting-transition')

  const failed = service.createMeeting()
  service.startMeeting(failed.meetingId)
  assert.equal(service.failMeeting(failed.meetingId, { reason: 'transcript can never be completed' }).status, S.FAILED)
  assert.equal(service.getMeeting(failed.meetingId).metadata.closeReason, 'transcript can never be completed')
  assert.throws(() => service.resumeMeeting(failed.meetingId), (err) => err.statusCode === 409)

  const created = service.createMeeting()
  assert.equal(service.cancelMeeting(created.meetingId).status, S.CANCELLED, 'a meeting that never started can be cancelled')
  for (const bad of ['', '   ', 'x'.repeat(201), 42, {}]) {
    assert.throws(
      () => service.failMeeting(service.createMeeting().meetingId, { reason: bad }),
      (err) => err.statusCode === 400 && err.code === 'invalid-close-reason'
    )
  }
})

test('a closed meeting is immutable in the database itself, not only in the service', () => {
  const database = createDatabase({ filename: ':memory:' })
  const service = makeService(database, makeClock())
  const insertSegment = (meetingId, id) =>
    database
      .prepare(
        `INSERT INTO transcript_segments
           (meeting_id, segment_id, start_ms, end_ms, text, is_final, schema_version, segment_json, created_at, updated_at)
         VALUES (?, ?, 0, 1000, 't', 1, '1.0', '{}', 'now', 'now')`
      )
      .run(meetingId, id)

  const open = service.createMeeting()
  service.startMeeting(open.meetingId)
  assert.doesNotThrow(() => insertSegment(open.meetingId, 'open-ok'), 'an open meeting is unaffected')

  for (const close of [
    (id) => service.cancelMeeting(id),
    (id) => service.failMeeting(id),
    (id) => service.endMeeting(id)
  ]) {
    const meeting = service.createMeeting()
    service.startMeeting(meeting.meetingId)
    insertSegment(meeting.meetingId, 'seed') // a stored segment to try to edit once the meeting is closed
    close(meeting.meetingId)
    const closedStatus = service.getMeeting(meeting.meetingId).status

    assert.throws(() => insertSegment(meeting.meetingId, 'sneaky'), /meeting-closed/, `${closedStatus}: segment insert`)
    assert.throws(
      () => database.prepare('UPDATE transcript_segments SET text = ? WHERE meeting_id = ?').run('edited', meeting.meetingId),
      /meeting-closed/,
      `${closedStatus}: segment edit`
    )
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO speech_sessions (speech_session_id, meeting_id, status, started_at, updated_at, timeline_offset_ms)
             VALUES ('99999999-9999-4999-8999-999999999999', ?, 'ACTIVE', 'now', 'now', 0)`
          )
          .run(meeting.meetingId),
      /meeting-closed/,
      `${closedStatus}: session insert`
    )
    assert.throws(
      () => database.prepare("UPDATE meetings SET status = 'LIVE' WHERE meeting_id = ?").run(meeting.meetingId),
      /meeting-terminal/,
      `${closedStatus}: reopening`
    )
    assert.equal(service.getMeeting(meeting.meetingId).status, closedStatus, 'the status survived the attempt')
  }
})

test('migration 3 upgrades a version 2 database in place and keeps its data', () => {
  const database = new DatabaseSync(':memory:')
  applyMigrations(database, { target: 2 })
  const meetings = createMeetingRepository(database)
  const transcript = createTranscriptRepository(database)
  const meeting = meetings.create({ metadata: { title: 'written under schema 2' } })
  // Raw SQL: the session repository prepares statements for the newest schema, which this old one lacks.
  const legacySessionId = '88888888-8888-4888-8888-888888888888'
  database
    .prepare(
      `INSERT INTO speech_sessions (speech_session_id, meeting_id, status, started_at, updated_at, timeline_offset_ms)
       VALUES (?, ?, 'ENDED', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 0)`
    )
    .run(legacySessionId, meeting.meetingId)
  transcript.insertFinalSegment({
    meetingId: meeting.meetingId,
    speechSessionId: legacySessionId,
    canonical: seg('legacy-1', 0, 1, 'kept across the upgrade'),
    now: '2026-10-01T00:00:00.000Z'
  })
  assert.deepEqual(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version), [1, 2])

  applyMigrations(database)
  const sessions = createSpeechSessionRepository(database)

  assert.deepEqual(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version), [1, 2, 3])
  assert.ok(database.prepare('PRAGMA table_info(speech_sessions)').all().some((c) => c.name === 'committed_segments'))
  assert.equal(transcript.getByMeeting(meeting.meetingId)[0].text, 'kept across the upgrade')
  assert.equal(sessions.getById(legacySessionId).committedSegments, null, 'old sessions are unverified, not zero')
  assert.equal(meetings.getById(meeting.meetingId).metadata.title, 'written under schema 2')
  assert.doesNotThrow(() => applyMigrations(database), 'running again is a no-op')
})

test('two sessions writing at the same time, one of them already superseded, never collide', () => {
  const clock = makeClock()
  const service = makeService(createDatabase({ filename: ':memory:' }), clock)
  const meeting = service.createMeeting()
  const { speechSession: a } = startLive(service, meeting.meetingId)
  clock.advanceSeconds(3)
  const b = service.attachSpeechSession(meeting.meetingId) // A is superseded but its connection is still delivering

  const writes = []
  for (let n = 1; n <= 20; n++) {
    writes.push({ session: a, text: `A${n}`, id: segId(UUID_A, n), at: n })
    writes.push({ session: b, text: `B${n}`, id: segId(UUID_B, n), at: n })
  }
  const outcomes = writes.map((w) =>
    service.appendFinalSegment(meeting.meetingId, { speechSessionId: w.session.speechSessionId, segment: seg(w.id, w.at, w.at + 0.5, w.text) })
  )

  assert.deepEqual([...new Set(outcomes.map((o) => o.status))], ['INSERTED'], 'every write landed; none was ignored or collided')
  const stored = service.getTranscript(meeting.meetingId)
  assert.equal(stored.length, 40)
  assert.equal(new Set(stored.map((x) => x.id)).size, 40, 'no duplicate ids')
  for (const segment of stored) {
    const owner = segment.text.startsWith('A') ? a : b
    assert.equal(segment.speechSessionId, owner.speechSessionId, `${segment.text} stays linked to the session that produced it`)
  }
  for (let i = 1; i < stored.length; i++) {
    assert.ok(stored[i].start >= stored[i - 1].start, 'the transcript is ordered on the meeting timeline')
  }
})
