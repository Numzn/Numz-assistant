import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, applyMigrations } from './sqliteDatabase.js'
import { createMeetingRepository } from './meetingRepository.js'
import { createSpeechSessionRepository } from './speechSessionRepository.js'
import { createTranscriptRepository } from './transcriptRepository.js'
import { createMeetingSessionService } from '../services/meetingSessionService.js'
import { MEETING_STATES } from '../meetings/meetingDomain.js'

// The fixture runs the real migrations. It used to hand-copy an older schema,
// which drifted from the code (missing columns) and hid real failures.
function makeSystem(database) {
  if (database === undefined) return makeSystem(createDatabase({ filename: ':memory:' }))
  applyMigrations(database)
  const meetingRepository = createMeetingRepository(database)
  const speechSessionRepository = createSpeechSessionRepository(database)
  const transcriptRepository = createTranscriptRepository(database)
  const service = createMeetingSessionService({ meetingRepository, speechSessionRepository, transcriptRepository })
  return { database, meetingRepository, speechSessionRepository, transcriptRepository, service }
}

function segment(id, start, text) {
  return { id, start, end: start + 1, text, speaker: null, words: [], confidence: 0.9, language: 'en', uncertain: true }
}

test('meeting persistence supports lifecycle and multiple speech sessions', () => {
  const system = makeSystem()
  const meeting = system.service.createMeeting({ title: 'Fixture meeting' })
  const live = system.service.startMeeting(meeting.meetingId)
  const first = system.service.attachSpeechSession(meeting.meetingId)
  const second = system.service.attachSpeechSession(meeting.meetingId)

  assert.equal(live.status, MEETING_STATES.LIVE)
  assert.notEqual(first.speechSessionId, second.speechSessionId)
  assert.equal(system.speechSessionRepository.getByMeeting(meeting.meetingId).length, 2)

  system.service.beginFinalization(meeting.meetingId)
  const completed = system.service.completeMeeting(meeting.meetingId)
  assert.equal(completed.status, MEETING_STATES.COMPLETED)
})

test('final segments are idempotent and chronologically ordered', () => {
  const system = makeSystem()
  const meeting = system.service.createMeeting()
  system.service.startMeeting(meeting.meetingId)
  const { speechSessionId } = system.service.attachSpeechSession(meeting.meetingId)
  const append = (item) => system.service.appendFinalSegment(meeting.meetingId, { speechSessionId, segment: item })

  const later = append(segment('seg_0002', 2, 'later'))
  const earlier = append(segment('seg_0001', 0, 'earlier'))
  const duplicate = append(segment('seg_0001', 0, 'duplicate'))

  assert.equal(later.inserted, true)
  assert.equal(earlier.inserted, true)
  assert.equal(duplicate.inserted, false)
  assert.deepEqual(system.service.getTranscript(meeting.meetingId).map((item) => item.text), ['earlier', 'later'])
})

test('active meetings are recoverable after repository reinitialization', () => {
  const database = new DatabaseSync(':memory:')
  const first = makeSystem(database)
  const meeting = first.service.createMeeting()
  first.service.startMeeting(meeting.meetingId)
  const { speechSessionId } = first.service.attachSpeechSession(meeting.meetingId)
  first.service.appendFinalSegment(meeting.meetingId, { speechSessionId, segment: segment('seg_0001', 0, 'durable') })

  const recovered = makeSystem(database)
  const active = recovered.meetingRepository.getActiveMeetings()
  assert.equal(active.length, 1)
  assert.equal(active[0].meetingId, meeting.meetingId)
  assert.equal(recovered.service.getTranscript(meeting.meetingId)[0].text, 'durable')
  assert.equal(recovered.service.recoverMeeting(meeting.meetingId).status, MEETING_STATES.RECOVERING)
})
