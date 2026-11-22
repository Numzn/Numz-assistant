import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryLaneManager } from './memoryLanes.js'
import { rig } from './testSupport.js'

function setup() {
  const t = rig()
  const lanes = createMemoryLaneManager({ academic: t.academic, audit: t.audit, clock: () => t.clock.t })
  const alice = lanes.forOwner(t.who.alice)
  const course = alice.createCourse({ title: 'Databases' })
  return { ...t, lanes, alice, course }
}
const feedback = (t, kind, over = {}) => t.alice.recordFeedback({ kind, courseId: t.course.id, topic: 'normalisation', ...over })
const rows = (t) => t.alice.listExperiences({ courseId: t.course.id })
const byKind = (t, kind) => rows(t).find((e) => e.kind === kind)

test('one bad moment is a hint, not a label: a first difficulty is tentative with low confidence', () => {
  const t = setup()
  const r = feedback(t, 'not_helpful')
  assert.equal(r.recorded, true)
  assert.equal(r.experience.difficulty, 'tentative')
  assert.ok(r.experience.confidence <= 0.45)
  assert.equal(r.experience.evidenceCount, 1)
  assert.equal(r.experience.source, 'feedback:not_helpful')
  assert.equal(r.experience.observedIssue, 'the explanation did not help')
  assert.ok(r.experience.createdAt && r.experience.lastConfirmedAt && r.experience.updatedAt && r.experience.courseId === t.course.id && r.experience.retention === 'learning')
})

test('the same difficulty twice within a month becomes "needs practice", with more confidence; a long gap does not', () => {
  const t = setup()
  feedback(t, 'misunderstanding', { note: 'mixes 2NF and 3NF' })
  t.clock.t += 5 * 86_400_000
  const second = feedback(t, 'not_helpful')
  assert.equal(second.experience.difficulty, 'needs_practice')
  assert.equal(second.experience.evidenceCount, 2)
  assert.ok(second.experience.confidence > 0.45)
  assert.equal(second.experience.observedIssue, 'the explanation did not help', 'the newest note is kept')

  const slow = setup()
  feedback(slow, 'not_helpful')
  slow.clock.t += 60 * 86_400_000
  assert.equal(feedback(slow, 'not_helpful').experience.difficulty, 'tentative', 'two events two months apart is not a pattern')
})

test('helpful explanations are remembered with the approach that worked; after a difficulty, two of them mean it is improving', () => {
  const t = setup()
  feedback(t, 'not_helpful')
  feedback(t, 'helpful', { approach: 'example_first', note: 'the library example' })
  assert.equal(byKind(t, 'helpful_explanation').helpfulExplanation, 'example_first: the library example')
  assert.equal(byKind(t, 'difficulty').difficulty, 'tentative', 'one good moment does not erase the difficulty')
  feedback(t, 'helpful', { approach: 'example_first' })
  assert.equal(byKind(t, 'difficulty').difficulty, 'improving')
  assert.equal(byKind(t, 'improvement').evidenceCount, 2)
  assert.throws(() => t.alice.recordFeedback({ kind: 'helpful', courseId: t.course.id, topic: 'x', approach: 'telepathy' }), (err) => err.code === 'invalid-input')
})

test('a correction from the student outranks what was inferred; a settled memory is re-assessed, never silently overwritten', () => {
  const t = setup()
  feedback(t, 'correction', { note: 'the answer said 3NF allows transitive dependencies; it does not' })
  const correction = byKind(t, 'correction')
  assert.equal(correction.confidence, 0.7)
  assert.match(correction.observedIssue, /transitive/)

  // build a well-established difficulty: it takes four observations to reach 0.7 confidence
  for (let i = 0; i < 4; i++) feedback(t, 'not_helpful', { topic: 'indexing' })
  const settled = t.alice.listExperiences({ courseId: t.course.id, topic: 'indexing' }).find((e) => e.kind === 'difficulty')
  assert.ok(settled.evidenceCount >= 3 && settled.confidence >= 0.7, `settled: ${JSON.stringify(settled)}`)
  const before = { evidence: settled.evidenceCount, confidence: settled.confidence }
  feedback(t, 'helpful', { topic: 'indexing', approach: 'step_by_step' })
  const after = t.alice.listExperiences({ courseId: t.course.id, topic: 'indexing' }).find((e) => e.kind === 'difficulty')
  assert.equal(after.status, 'needs_reassessment', 'new evidence against a settled memory asks for a second look')
  assert.deepEqual({ evidence: after.evidenceCount, confidence: after.confidence }, before, 'and does not rewrite it')
  assert.ok(t.alice.listExperiences({ courseId: t.course.id, topic: 'indexing' }).some((e) => e.kind === 'helpful_explanation'), 'the new event is kept beside it')
})

test('with adaptive learning off nothing is recorded and nothing is used; without a course or with another person\'s, nothing is recorded', () => {
  const t = setup()
  feedback(t, 'misunderstanding', { note: 'x' })
  assert.equal(t.alice.relevantExperiences({ courseId: t.course.id, topic: 'normalisation' }).length, 1)
  t.alice.updateProfile({ adaptiveLearning: false })
  assert.deepEqual(feedback(t, 'not_helpful'), { recorded: false, reason: 'adaptive-learning-off' })
  assert.deepEqual(t.alice.relevantExperiences({ courseId: t.course.id, topic: 'normalisation' }), [], 'switched off: not used either')
  assert.equal(rows(t).length, 1, 'and nothing new was stored')
  t.alice.updateProfile({ adaptiveLearning: true })
  assert.deepEqual(t.alice.recordFeedback({ kind: 'not_helpful', courseId: null, topic: 'x' }), { recorded: false, reason: 'no-course' })
  const bob = t.lanes.forOwner(t.who.bob)
  assert.throws(() => bob.recordFeedback({ kind: 'not_helpful', courseId: t.course.id, topic: 'x' }), (err) => err.code === 'course-not-found')
  assert.throws(() => t.alice.recordFeedback({ kind: 'sulking', courseId: t.course.id, topic: 'x' }), (err) => err.code === 'invalid-input')
  assert.throws(() => t.alice.recordFeedback({ kind: 'helpful', courseId: t.course.id, topic: '' }), (err) => err.code === 'invalid-input')
  assert.throws(() => t.alice.recordFeedback({ kind: 'helpful', courseId: t.course.id, topic: 'x', note: 'n'.repeat(500) }), (err) => err.code === 'invalid-input')
})

test('only what is relevant to this topic is offered to the model: corrections first, nothing from other courses, nothing too doubtful', () => {
  const t = setup()
  const other = t.alice.createCourse({ title: 'Networks' })
  feedback(t, 'not_helpful', { topic: 'second normal form' })
  feedback(t, 'correction', { topic: 'normal forms', note: 'answer was wrong about BCNF' })
  feedback(t, 'not_helpful', { topic: 'joins' })
  t.alice.recordFeedback({ kind: 'not_helpful', courseId: other.id, topic: 'normal forms in networks?' })
  const picked = t.alice.relevantExperiences({ courseId: t.course.id, topic: 'third normal form and normal forms' })
  assert.deepEqual(picked.map((e) => [e.kind, e.topic]), [['correction', 'normal forms'], ['difficulty', 'second normal form']])
  assert.ok(picked.every((e) => e.courseId === t.course.id))
  assert.deepEqual(t.alice.relevantExperiences({ courseId: t.course.id, topic: 'photosynthesis' }), [])
  assert.deepEqual(t.alice.relevantExperiences({ courseId: t.course.id, topic: '' }), [])
  assert.deepEqual(t.lanes.forOwner(t.who.bob).relevantExperiences({ courseId: t.course.id, topic: 'normal forms' }), [])
})

test('progress: per topic where the student is, what helped, and what to review next; marking it reviewed moves it down the list', () => {
  const t = setup()
  feedback(t, 'misunderstanding', { topic: 'joins' })
  t.clock.t += 86_400_000
  feedback(t, 'not_helpful', { topic: 'joins' })
  feedback(t, 'helpful', { topic: 'indexing', approach: 'visual' })
  feedback(t, 'not_helpful', { topic: 'keys' })
  const p = t.alice.progress({ courseId: t.course.id })
  assert.equal(p.adaptiveLearning, true)
  assert.deepEqual(p.topics.map((x) => x.topic).sort(), ['indexing', 'joins', 'keys'])
  const joins = p.topics.find((x) => x.topic === 'joins')
  assert.equal(joins.difficulty, 'needs_practice')
  assert.ok(p.topics.find((x) => x.topic === 'indexing').helpful[0].startsWith('visual'))
  assert.deepEqual(p.suggestedReview.map((x) => x.topic), ['joins'], 'only what came up more than once as hard is suggested')
  const id = joins.experienceIds[0]
  assert.ok(t.alice.markReviewed(id).lastReviewedAt)
  assert.equal(t.alice.markReviewed('nope'), null)
  assert.equal(t.lanes.forOwner(t.who.bob).markReviewed(id), null)
  assert.deepEqual(t.lanes.forOwner(t.who.bob).progress({}).topics, [])
})

test('feedback is audited by id and kind, never by what was said', () => {
  const t = setup()
  feedback(t, 'correction', { note: 'a very private remark about the lecturer' })
  assert.ok(t.audits.some((a) => a.event === 'academic.memory_record' && a.detail.kind === 'correction'))
  assert.equal(JSON.stringify(t.audits).includes('private remark'), false)
})
