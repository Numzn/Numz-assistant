import assert from 'node:assert/strict'
import test from 'node:test'
import { rig } from '../academic/testSupport.js'
import { createMeetingRepository } from './meetingRepository.js'
import { applyMigrations, createDatabase } from './sqliteDatabase.js'

test('migrations 8 and 9 upgrade a version 7 database without touching what was there, and attribute meetings that a person launched', () => {
  const database = new (createDatabase({ filename: ':memory:' }).constructor)(':memory:')
  applyMigrations(database, { target: 7 })
  const versions = () => database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version)
  assert.deepEqual(versions(), [1, 2, 3, 4, 5, 6, 7])
  database.prepare(`INSERT INTO ai_users (id, external_id, email, name, role, status, created_at) VALUES ('u1', 'ext1', 'a@example.com', 'A', 'viewer', 'active', 't')`).run()
  const meeting = (id, meta) => database.prepare(`INSERT INTO meetings (meeting_id, status, created_at, updated_at, metadata_json) VALUES (?, 'COMPLETED', 't', 't', ?)`).run(id, JSON.stringify(meta))
  meeting('m-launched', { launchedBy: 'u1', title: 'Lecture 1' })
  meeting('m-ghost', { launchedBy: 'nobody-with-this-id' })
  meeting('m-old', { title: 'before people' })
  database.prepare(`INSERT INTO assistant_conversations (conversation_id, title, created_at, updated_at) VALUES ('c1', 'kept', 't', 't')`).run()

  applyMigrations(database)
  assert.deepEqual(versions(), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  const owner = (id) => database.prepare('SELECT owner_user_id AS o FROM meetings WHERE meeting_id = ?').get(id).o
  assert.equal(owner('m-launched'), 'u1', 'a meeting a signed-in person launched is theirs')
  assert.equal(owner('m-ghost'), null, 'a launcher that is not a known person owns nothing')
  assert.equal(owner('m-old'), null, 'an older meeting stays unowned until the administrator releases it')
  assert.equal(database.prepare('SELECT title FROM assistant_conversations').get().title, 'kept')
  assert.doesNotThrow(() => applyMigrations(database), 'running again is a no-op')
  for (const table of ['academic_courses', 'academic_sessions', 'learning_experiences']) assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
})

test('a person\'s courses, experiences and sessions are theirs alone: another person sees nothing and changes nothing', () => {
  const { academic, who } = rig()
  const alice = academic.forOwner(who.alice)
  const bob = academic.forOwner(who.bob)
  const course = alice.courses.create({ title: 'Database Systems', code: 'CS201' })
  const experience = alice.experiences.insert({ courseId: course.id, topic: 'normalisation', kind: 'difficulty', difficulty: 'tentative', confidence: 0.4, source: 'feedback' })
  const session = alice.sessions.insert({ courseId: course.id, sessionType: 'study', captureEnabled: true, ttlMs: 3600_000 })

  assert.deepEqual(bob.courses.list(), [])
  assert.equal(bob.courses.get(course.id), null)
  assert.equal(bob.courses.update(course.id, { title: 'hijacked' }), null)
  assert.equal(bob.courses.remove(course.id), false)
  assert.equal(bob.experiences.get(experience.id), null)
  assert.equal(bob.experiences.remove(experience.id), false)
  assert.deepEqual(bob.experiences.list({ courseId: course.id }), [])
  assert.equal(bob.sessions.get(session.id), null)
  assert.equal(bob.sessions.current(), null)
  assert.equal(alice.courses.get(course.id).title, 'Database Systems', 'alice\'s course is untouched')
  assert.equal(alice.experiences.list().length, 1)
})

test('the database itself refuses a session or experience that names someone else\'s course', () => {
  const { academic, who, database } = rig()
  const alice = academic.forOwner(who.alice)
  const bob = academic.forOwner(who.bob)
  const course = alice.courses.create({ title: 'Networks' })
  assert.throws(() => bob.sessions.insert({ courseId: course.id, sessionType: 'study', ttlMs: 1000 }), /course-owner-mismatch/)
  assert.throws(() => bob.experiences.insert({ courseId: course.id, topic: 'tcp', kind: 'difficulty', confidence: 0.4, source: 'x' }), /course-owner-mismatch/)
  const mine = bob.sessions.insert({ sessionType: 'study', ttlMs: 1000 })
  assert.throws(() => database.prepare('UPDATE academic_sessions SET course_id = ? WHERE id = ?').run(course.id, mine.id), /course-owner-mismatch/)
})

test('the declared kind of a session never changes, and a restricted session can never capture or answer by itself', () => {
  const { academic, who, database } = rig()
  const alice = academic.forOwner(who.alice)
  const study = alice.sessions.insert({ sessionType: 'study', captureEnabled: true, autoAnswer: true, ttlMs: 1000 })
  // (a session that captures cannot become restricted either: SQLite does not promise which of the two triggers speaks first, both refuse)
  for (const to of ['practice', 'restricted']) assert.throws(() => database.prepare('UPDATE academic_sessions SET session_type = ? WHERE id = ?').run(to, study.id), /session-type-is-permanent|restricted-session-no-capture/)
  const quiet = alice.sessions.insert({ sessionType: 'study', ttlMs: 1000 })
  assert.throws(() => database.prepare('UPDATE academic_sessions SET session_type = ? WHERE id = ?').run('restricted', quiet.id), /session-type-is-permanent/)
  assert.equal(alice.sessions.get(quiet.id).sessionType, 'study')
  assert.throws(() => alice.sessions.insert({ sessionType: 'restricted', captureEnabled: true, ttlMs: 1000 }), /restricted-session-no-capture/)
  assert.throws(() => alice.sessions.insert({ sessionType: 'restricted', autoAnswer: true, ttlMs: 1000 }), /restricted-session-no-capture/)
  const restricted = alice.sessions.insert({ sessionType: 'restricted', ttlMs: 1000 })
  assert.equal(restricted.captureEnabled, false)
  assert.throws(() => alice.sessions.save({ ...restricted, captureEnabled: true, lastActivityAt: 't', expiresAt: 't' }), /restricted-session-no-capture/)
  assert.throws(() => alice.sessions.insert({ sessionType: 'exam', ttlMs: 1000 }), /sessionType must be one of/)
})

test('deleting a course removes its learning memories and only unlinks its sessions', () => {
  const { academic, who } = rig()
  const alice = academic.forOwner(who.alice)
  const keep = alice.courses.create({ title: 'Keep' })
  const drop = alice.courses.create({ title: 'Drop' })
  alice.experiences.insert({ courseId: drop.id, topic: 't', kind: 'difficulty', confidence: 0.4, source: 's' })
  alice.experiences.insert({ courseId: keep.id, topic: 't', kind: 'difficulty', confidence: 0.4, source: 's' })
  const session = alice.sessions.insert({ courseId: drop.id, sessionType: 'practice', ttlMs: 1000 })
  assert.equal(alice.courses.remove(drop.id), true)
  assert.deepEqual(alice.experiences.list().map((e) => e.courseId), [keep.id])
  assert.equal(alice.sessions.get(session.id).courseId, null)
})

test('the profiles live in the person\'s settings: defaults, validated changes, and other keys left alone', () => {
  const { academic, who, database } = rig()
  const alice = academic.forOwner(who.alice)
  assert.equal(alice.settings.get().learningProfile.writingStyle, 'natural_student_academic')
  assert.equal(alice.settings.get().adaptiveLearning, true)
  database.prepare(`INSERT INTO ai_user_settings (user_id, settings_json, updated_at) VALUES (?, ?, 't')`).run(who.alice, JSON.stringify({ somethingElse: { keep: 'me' } }))
  const next = alice.settings.update({ learningProfile: { explanationLevel: 'simple', preferredStructure: ['relevant_examples', 'relevant_examples', 'check_understanding'] }, academicProfile: { institution: ' UNZA ', verified: true }, adaptiveLearning: false })
  assert.equal(next.learningProfile.explanationLevel, 'simple')
  assert.deepEqual(next.learningProfile.preferredStructure, ['relevant_examples', 'check_understanding'])
  assert.equal(next.academicProfile.institution, 'UNZA')
  assert.equal(next.adaptiveLearning, false)
  assert.deepEqual(JSON.parse(database.prepare('SELECT settings_json FROM ai_user_settings WHERE user_id = ?').get(who.alice).settings_json).somethingElse, { keep: 'me' })
  for (const bad of [{ learningProfile: { writingStyle: 'gibberish' } }, { learningProfile: { preferredStructure: ['nope'] } }, { adaptiveLearning: 'yes' }, { academicProfile: { institution: 'x'.repeat(300) } }, { learningProfile: 'x' }]) {
    assert.throws(() => alice.settings.update(bad), (err) => err.code === 'invalid-input' && err.statusCode === 400, JSON.stringify(bad))
  }
  assert.equal(academic.forOwner(who.bob).settings.get().learningProfile.explanationLevel, 'clear_and_accessible', 'bob has his own')
  database.prepare('UPDATE ai_user_settings SET settings_json = ? WHERE user_id = ?').run('{not json', who.alice)
  assert.equal(alice.settings.get().learningProfile.writingStyle, 'natural_student_academic', 'a damaged blob is no preferences, not an error')
})

test('sessions: one current at a time, expiry ends them, ended ones are purged after the retention, and a restart ends every open one', () => {
  const { academic, who, clock } = rig()
  const alice = academic.forOwner(who.alice)
  const a = alice.sessions.insert({ sessionType: 'study', ttlMs: 60_000 })
  assert.equal(alice.sessions.current().id, a.id)
  clock.t += 120_000
  assert.deepEqual(academic.maintain({ retentionDays: 14 }), { expired: 1, purged: 0 })
  assert.equal(alice.sessions.current(), null)
  assert.equal(alice.sessions.get(a.id).endReason, 'expired')
  clock.t += 15 * 86_400_000
  assert.equal(academic.maintain({ retentionDays: 14 }).purged, 1)
  assert.equal(alice.sessions.get(a.id), null)
  alice.sessions.insert({ sessionType: 'practice', ttlMs: 3_600_000 })
  academic.forOwner(who.bob).sessions.insert({ sessionType: 'study', ttlMs: 3_600_000 })
  assert.equal(academic.endAllOpenSessions('server-restart'), 2)
  assert.equal(alice.sessions.current(), null)
})

test('meetings record their owner outside the meeting record; the owner is permanent; only unowned meetings can be claimed', () => {
  const { database, who } = rig()
  const meetings = createMeetingRepository(database)
  const mine = meetings.create({ metadata: { title: 'mine' }, ownerUserId: who.alice })
  const nobody = meetings.create({ metadata: { title: 'admin-made' } })
  assert.equal(meetings.getOwner(mine.meetingId), who.alice)
  assert.equal(meetings.getOwner(nobody.meetingId), null)
  assert.equal('ownerUserId' in meetings.getById(mine.meetingId), false, 'the meeting record itself is unchanged')
  assert.deepEqual(meetings.listOwnedBy(who.alice).map((m) => m.metadata.title), ['mine'])
  assert.deepEqual(meetings.listOwnedBy(who.bob), [])
  assert.deepEqual(meetings.listUnowned().map((m) => m.metadata.title), ['admin-made'])
  assert.equal(meetings.claim(who.bob, [mine.meetingId, nobody.meetingId]), 1, 'alice\'s meeting cannot be taken, the unowned one can')
  assert.equal(meetings.getOwner(mine.meetingId), who.alice)
  assert.equal(meetings.getOwner(nobody.meetingId), who.bob)
  assert.throws(() => database.prepare('UPDATE meetings SET owner_user_id = ? WHERE meeting_id = ?').run(who.alice, nobody.meetingId), /meeting-owner-is-permanent/)
  // a meeting still moves through its life as before
  assert.doesNotThrow(() => database.prepare(`UPDATE meetings SET status = 'LIVE' WHERE meeting_id = ?`).run(mine.meetingId))
})
