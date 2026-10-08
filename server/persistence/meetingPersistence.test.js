import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from './sqliteDatabase.js'
import { createMeetingRepository } from './meetingRepository.js'
import { createSpeechSessionRepository } from './speechSessionRepository.js'
import { createTranscriptRepository } from './transcriptRepository.js'
import { createMeetingSessionService } from '../services/meetingSessionService.js'
import { MEETING_STATES } from '../meetings/meetingDomain.js'

function makeSystem(database) {
  if (database === undefined) return makeSystem(createDatabase({ filename: ':memory:' }))
  if (database !== undefined) {
    database.exec('PRAGMA foreign_keys = ON;')
    const existing = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meetings'").get()
    if (!existing) database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE meetings (meeting_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, paused_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL, metadata_json TEXT NOT NULL);
      CREATE TABLE speech_sessions (speech_session_id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id), status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE transcript_segments (meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id), segment_id TEXT NOT NULL, speaker_id TEXT, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL, confidence REAL, is_final INTEGER NOT NULL, schema_version TEXT NOT NULL, segment_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (meeting_id, segment_id));
    `)
  }
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
  const first = system.service.startMeeting(meeting.meetingId)
  const second = system.service.attachSpeechSession(meeting.meetingId)

  assert.equal(first.meeting.status, MEETING_STATES.LIVE)
  assert.notEqual(first.speechSession.speechSessionId, second.speechSessionId)
  assert.equal(system.speechSessionRepository.getByMeeting(meeting.meetingId).length, 2)

  system.service.beginFinalization(meeting.meetingId)
  const completed = system.service.completeMeeting(meeting.meetingId)
  assert.equal(completed.status, MEETING_STATES.COMPLETED)
})

test('final segments are idempotent and chronologically ordered', () => {
  const system = makeSystem()
  const meeting = system.service.createMeeting()
  system.service.startMeeting(meeting.meetingId)

  const later = system.service.appendFinalSegment(meeting.meetingId, segment('seg_0002', 2, 'later'))
  const earlier = system.service.appendFinalSegment(meeting.meetingId, segment('seg_0001', 0, 'earlier'))
  const duplicate = system.service.appendFinalSegment(meeting.meetingId, segment('seg_0001', 0, 'duplicate'))

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
  first.service.appendFinalSegment(meeting.meetingId, segment('seg_0001', 0, 'durable'))

  const recovered = makeSystem(database)
  const active = recovered.meetingRepository.getActiveMeetings()
  assert.equal(active.length, 1)
  assert.equal(active[0].meetingId, meeting.meetingId)
  assert.equal(recovered.service.getTranscript(meeting.meetingId)[0].text, 'durable')
  assert.equal(recovered.service.recoverMeeting(meeting.meetingId).status, MEETING_STATES.RECOVERING)
})
