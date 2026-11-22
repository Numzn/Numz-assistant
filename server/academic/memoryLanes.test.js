import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryLaneManager, LANES } from './memoryLanes.js'
import { rig } from './testSupport.js'

function lanesFor(t, name = 'alice', extra = {}) {
  const manager = createMemoryLaneManager({ academic: t.academic, audit: t.audit, ...extra })
  return manager.forOwner(t.who[name])
}

test('there are six lanes, and the memory centre shows each, for this person only', () => {
  assert.deepEqual([...LANES], ['profile', 'academic', 'knowledge', 'conversation', 'experience', 'session'])
  const t = rig()
  const alice = lanesFor(t)
  const course = alice.createCourse({ title: 'Software Engineering' })
  t.academic.forOwner(t.who.alice).experiences.insert({ courseId: course.id, topic: 'uml', kind: 'difficulty', confidence: 0.4, source: 'feedback' })
  const seen = alice.inspect()
  assert.deepEqual(Object.keys(seen.lanes), [...LANES])
  assert.equal(seen.lanes.academic.courses[0].title, 'Software Engineering')
  assert.equal(seen.lanes.experience.items[0].topic, 'uml')
  assert.equal(seen.lanes.profile.learningProfile.writingStyle, 'natural_student_academic')
  assert.equal(seen.adaptiveLearning, true)
  const bob = lanesFor(t, 'bob').inspect()
  assert.deepEqual(bob.lanes.academic.courses, [])
  assert.deepEqual(bob.lanes.experience.items, [])
})

test('conversations appear in the memory centre from the existing history, and are never deleted from here', () => {
  const t = rig()
  const conversations = { forOwner: () => ({ getHistory: () => ({ list: () => ({ conversations: [{ id: 'c1', title: 'Normal forms', updatedAt: 'now', messageCount: 4 }] }) }) }) }
  const alice = lanesFor(t, 'alice', { conversations })
  assert.deepEqual(alice.inspect().lanes.conversation.recent, [{ id: 'c1', title: 'Normal forms', updatedAt: 'now', messageCount: 4 }])
  assert.throws(() => alice.deleteLane('conversation'), (err) => err.code === 'use-conversations')
})

test('each lane can be emptied on its own, a course can be deleted with what is about it, and everything stays inside this person\'s memory', () => {
  const t = rig()
  const alice = lanesFor(t)
  const bob = lanesFor(t, 'bob')
  const a = alice.createCourse({ title: 'A' })
  const b = alice.createCourse({ title: 'B' })
  const mine = t.academic.forOwner(t.who.alice)
  mine.experiences.insert({ courseId: a.id, topic: 'x', kind: 'difficulty', confidence: 0.4, source: 's' })
  mine.experiences.insert({ courseId: b.id, topic: 'y', kind: 'difficulty', confidence: 0.4, source: 's' })
  const bobCourse = bob.createCourse({ title: 'Bob\'s' })
  t.academic.forOwner(t.who.bob).experiences.insert({ courseId: bobCourse.id, topic: 'z', kind: 'difficulty', confidence: 0.4, source: 's' })

  assert.deepEqual(alice.deleteLane('experience', { courseId: a.id }), { lane: 'experience', removed: 1 })
  assert.deepEqual(alice.listExperiences().map((e) => e.topic), ['y'])
  assert.throws(() => alice.deleteLane('experience', { courseId: bobCourse.id }), (err) => err.code === 'course-not-found', 'another person\'s course is not found')
  assert.equal(bob.listExperiences().length, 1, 'bob\'s memory was not touched')

  assert.equal(alice.deleteCourse(b.id), true)
  assert.deepEqual(alice.listExperiences(), [])
  assert.equal(alice.deleteCourse(bobCourse.id), false)
  assert.equal(bob.listCourses().length, 1)

  alice.updateProfile({ learningProfile: { explanationLevel: 'advanced' } })
  alice.deleteLane('profile')
  assert.equal(alice.getProfile().learningProfile.explanationLevel, 'clear_and_accessible')
  assert.throws(() => alice.deleteLane('academic'), (err) => err.code === 'confirm-required')
  assert.throws(() => alice.deleteLane('nonsense'), (err) => err.code === 'invalid-input')
})

test('a person can correct or delete a single learning memory; correcting confirms it and lifts any doubt', () => {
  const t = rig()
  const alice = lanesFor(t)
  const course = alice.createCourse({ title: 'DB' })
  const e = t.academic.forOwner(t.who.alice).experiences.insert({ courseId: course.id, topic: 'normalisation', kind: 'difficulty', difficulty: 'needs_practice', observedIssue: 'mixes 2NF and 3NF', confidence: 0.55, status: 'needs_reassessment', source: 'feedback' })
  const fixed = alice.correctExperience(e.id, { observedIssue: 'was confused about 3NF only', difficulty: 'improving' })
  assert.equal(fixed.observedIssue, 'was confused about 3NF only')
  assert.equal(fixed.difficulty, 'improving')
  assert.equal(fixed.status, 'active')
  assert.equal(fixed.confidence, 0.9)
  assert.ok(fixed.lastConfirmedAt)
  assert.throws(() => alice.correctExperience(e.id, { difficulty: 'hopeless' }), (err) => err.code === 'invalid-input')
  assert.equal(lanesFor(t, 'bob').correctExperience(e.id, { observedIssue: 'x' }), null)
  assert.equal(lanesFor(t, 'bob').deleteExperience(e.id), false)
  assert.equal(alice.deleteExperience(e.id), true)
  assert.equal(alice.correctExperience(e.id, {}), null)
})

test('exporting gives the person their academic notes; deleting everything empties every lane except the conversations', () => {
  const t = rig()
  const alice = lanesFor(t)
  const course = alice.createCourse({ title: 'Networks' })
  t.academic.forOwner(t.who.alice).experiences.insert({ courseId: course.id, topic: 'tcp', kind: 'difficulty', confidence: 0.4, source: 's' })
  alice.updateProfile({ academicProfile: { institution: 'UNZA' }, adaptiveLearning: false })
  const exported = alice.exportAll()
  assert.equal(exported.courses[0].title, 'Networks')
  assert.equal(exported.experiences.length, 1)
  assert.equal(exported.academicProfile.institution, 'UNZA')
  assert.equal(exported.adaptiveLearning, false)
  const result = alice.deleteEverything()
  assert.ok(result.experience >= 1)
  const after = alice.inspect()
  assert.deepEqual(after.lanes.academic.courses, [])
  assert.deepEqual(after.lanes.experience.items, [])
  assert.equal(after.lanes.academic.academicProfile.institution, null)
  assert.equal(after.adaptiveLearning, true, 'the learning switch returns to its default')
})

test('the audit trail records what changed, by id and count, never what was said', () => {
  const t = rig()
  const alice = lanesFor(t)
  const course = alice.createCourse({ title: 'A secret-ish course title' })
  alice.updateProfile({ academicProfile: { institution: 'Some University' } })
  alice.deleteCourse(course.id)
  alice.deleteLane('experience')
  const log = JSON.stringify(t.audits)
  for (const event of ['academic.course_create', 'academic.profile_update', 'academic.course_delete', 'academic.memory_delete']) assert.ok(t.audits.some((a) => a.event === event), event)
  assert.equal(log.includes('secret-ish'), false)
  assert.equal(log.includes('Some University'), false)
  assert.ok(t.audits.every((a) => a.userId === t.who.alice))
})
