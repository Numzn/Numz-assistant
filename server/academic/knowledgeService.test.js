import assert from 'node:assert/strict'
import test from 'node:test'
import { createKnowledgeRepository } from '../persistence/knowledgeRepository.js'
import { createMeetingRepository } from '../persistence/meetingRepository.js'
import { createSpeechSessionRepository } from '../persistence/speechSessionRepository.js'
import { createTranscriptRepository } from '../persistence/transcriptRepository.js'
import { createMeetingSessionService } from '../services/meetingSessionService.js'
import { createKnowledgeService } from './knowledgeService.js'
import { rig } from './testSupport.js'

function setup() {
  const t = rig()
  const knowledge = createKnowledgeRepository(t.database)
  const meetingService = createMeetingSessionService({
    meetingRepository: createMeetingRepository(t.database),
    speechSessionRepository: createSpeechSessionRepository(t.database),
    transcriptRepository: createTranscriptRepository(t.database)
  })
  const service = createKnowledgeService({ knowledge, meetingService })
  const aliceCourses = t.academic.forOwner(t.who.alice).courses
  const db = aliceCourses.create({ title: 'Databases' })
  const net = aliceCourses.create({ title: 'Networks' })
  const alice = service.forOwner(t.who.alice)
  const bob = service.forOwner(t.who.bob)
  knowledge.forOwner(t.who.alice).addDocument({ courseId: db.id, title: 'DB notes', text: '# Keys\n\nA primary key identifies a row.' })
  knowledge.forOwner(t.who.alice).addDocument({ courseId: net.id, title: 'Net notes', text: '# Keys\n\nSession keys are exchanged by the handshake.' })
  return { ...t, knowledge, meetingService, alice, bob, db, net }
}

function finishedLecture(t, { owner, title = 'Lecture' }) {
  const meeting = t.meetingService.createMeeting({ title }, { ownerUserId: owner })
  t.meetingService.startMeeting(meeting.meetingId)
  const speech = t.meetingService.attachSpeechSession(meeting.meetingId)
  const id = speech.speechSessionId ?? speech.session?.speechSessionId ?? speech.id
  t.meetingService.appendFinalSegment(meeting.meetingId, { speechSessionId: id, segment: { id: 'seg_0001', start: 0, end: 4, text: 'Today: transactions and isolation.', speaker: null, uncertain: false, words: [], language: 'en' } })
  t.meetingService.endSpeechSession(meeting.meetingId, id, 'stopped', { committedSegments: 1 })
  t.meetingService.beginFinalization?.(meeting.meetingId)
  t.meetingService.endMeeting(meeting.meetingId)
  return meeting.meetingId
}

test('a search looks in the course it is asked about and labels what it finds so an answer can cite it', () => {
  const t = setup()
  const result = t.alice.retrieve({ courseId: t.db.id, query: 'what identifies a row?' })
  assert.equal(result.crossCourse, false)
  assert.deepEqual(result.passages.map((p) => [p.label, p.title, p.headingPath, p.crossCourse]), [['S1', 'DB notes', 'Keys', false]])
  assert.match(result.passages[0].text, /primary key/)
  assert.deepEqual(t.alice.retrieve({ courseId: null, query: 'keys' }).passages, [], 'with no course there is nothing to search')
})

test('another of the person\'s courses is searched only when named, with a reason that travels with the evidence', () => {
  const t = setup()
  assert.throws(() => t.alice.retrieve({ courseId: t.db.id, query: 'session keys handshake', alsoCourseIds: [t.net.id] }), (err) => err.code === 'cross-course-needs-reason')
  assert.throws(() => t.alice.retrieve({ courseId: t.db.id, query: 'keys', alsoCourseIds: [t.net.id], reason: 'ok' }), (err) => err.code === 'cross-course-needs-reason')
  const result = t.alice.retrieve({ courseId: t.db.id, query: 'session keys handshake', alsoCourseIds: [t.net.id], reason: 'the question is about encryption keys, which networks covers' })
  assert.equal(result.crossCourse, true)
  assert.match(result.reason, /encryption keys/)
  const net = result.passages.find((p) => p.title === 'Net notes')
  assert.equal(net.crossCourse, true)
  assert.equal(t.alice.retrieve({ courseId: t.db.id, query: 'session keys handshake' }).passages.some((p) => p.title === 'Net notes'), false, 'without naming it, the other course is not searched')
})

test('another person\'s course cannot be searched by naming it', () => {
  const t = setup()
  const bobCourse = t.academic.forOwner(t.who.bob).courses.create({ title: 'Bob' })
  t.knowledge.forOwner(t.who.bob).addDocument({ courseId: bobCourse.id, title: 'Bob notes', text: 'bob keys secret' })
  const result = t.alice.retrieve({ courseId: t.db.id, query: 'keys secret', alsoCourseIds: [bobCourse.id], reason: 'trying to read someone else' })
  assert.ok(!JSON.stringify(result).includes('bob keys secret'))
  assert.deepEqual(t.bob.retrieve({ courseId: t.db.id, query: 'primary key' }).passages, [], 'and bob cannot search alice\'s course')
})

test('a finished lecture of your own becomes course material; someone else\'s, an unowned one, an unfinished one and a missing one do not', () => {
  const t = setup()
  const mine = finishedLecture(t, { owner: t.who.alice, title: 'Databases 5' })
  const result = t.alice.ingestMeeting({ meetingId: mine, courseId: t.db.id })
  assert.equal(result.document.title, 'Databases 5')
  assert.equal(result.document.sourceType, 'lecture_transcript')
  assert.equal(result.document.sourceRef, `meeting:${mine}`)
  assert.match(t.alice.retrieve({ courseId: t.db.id, query: 'transactions isolation' }).passages[0].text, /\[00:00\] Today: transactions/)
  assert.equal(t.alice.ingestMeeting({ meetingId: mine, courseId: t.db.id }).unchanged, true, 'again is a no-op')

  const bobs = finishedLecture(t, { owner: t.who.bob })
  const unowned = finishedLecture(t, { owner: null })
  for (const id of [bobs, unowned, 'no-such-meeting']) assert.throws(() => t.alice.ingestMeeting({ meetingId: id, courseId: t.db.id }), (err) => err.code === 'meeting-not-found' && err.statusCode === 404, id)
  const live = t.meetingService.createMeeting({ title: 'live' }, { ownerUserId: t.who.alice })
  t.meetingService.startMeeting(live.meetingId)
  assert.throws(() => t.alice.ingestMeeting({ meetingId: live.meetingId, courseId: t.db.id }), (err) => err.code === 'meeting-not-finished' && err.statusCode === 409)
  assert.throws(() => t.alice.ingestMeeting({ meetingId: mine, courseId: 'nope' }), (err) => err.code === 'course-not-found')
})

test('the list of lectures to choose from holds only your own finished ones, newest first, with nothing of anyone else\'s', () => {
  const t = setup()
  assert.deepEqual(t.alice.listLectures(), [])
  const first = finishedLecture(t, { owner: t.who.alice, title: 'Databases 5' })
  const second = finishedLecture(t, { owner: t.who.alice, title: 'Databases 6' })
  finishedLecture(t, { owner: t.who.bob, title: 'Bob\'s lecture' })
  const unowned = t.meetingService.createMeeting({ title: 'Nobody\'s' })
  t.meetingService.startMeeting(unowned.meetingId)
  const unfinished = t.meetingService.createMeeting({ title: 'Still going' }, { ownerUserId: t.who.alice })
  t.meetingService.startMeeting(unfinished.meetingId)
  const lectures = t.alice.listLectures()
  assert.deepEqual(new Set(lectures.map((l) => l.meetingId)), new Set([first, second]))
  assert.deepEqual(lectures.map((l) => l.title).sort(), ['Databases 5', 'Databases 6'])
  assert.deepEqual(Object.keys(lectures[0]).sort(), ['createdAt', 'endedAt', 'meetingId', 'title'], 'ids, title and dates only: no transcript text')
  assert.deepEqual(t.bob.listLectures().map((l) => l.title), ['Bob\'s lecture'])
})
