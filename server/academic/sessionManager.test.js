import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionManager } from './sessionManager.js'
import { rig } from './testSupport.js'

function setup() {
  const t = rig()
  const manager = createSessionManager({ academic: t.academic, clock: () => t.clock.t, ttlMs: 60 * 60_000, audit: t.audit })
  const alice = manager.forOwner(t.who.alice)
  const bob = manager.forOwner(t.who.bob)
  const course = t.academic.forOwner(t.who.alice).courses.create({ title: 'Databases' })
  return { ...t, manager, alice, bob, course }
}

test('a session is started by the person with a declared type; the type is required and one of three', () => {
  const t = setup()
  const s = t.alice.start({ type: 'study', courseId: t.course.id, topic: 'normal forms', captureEnabled: true })
  assert.equal(s.sessionType, 'study')
  assert.equal(s.status, 'active')
  assert.equal(s.captureEnabled, true)
  assert.equal(t.alice.current().id, s.id)
  for (const bad of [undefined, 'exam', '', 'STUDY']) assert.throws(() => t.alice.start({ type: bad }), (err) => err.code === 'invalid-input', String(bad))
  assert.ok(t.audits.some((a) => a.event === 'academic.session_start' && a.detail.sessionId === s.id && a.detail.type === 'study'))
})

test('a restricted session cannot be started with capture or self-answering, and cannot be given them later', () => {
  const t = setup()
  for (const opts of [{ captureEnabled: true }, { autoAnswer: true }]) assert.throws(() => t.alice.start({ type: 'restricted', ...opts }), (err) => err.code === 'restricted-no-capture' && err.statusCode === 400)
  const r = t.alice.start({ type: 'restricted' })
  assert.equal(r.captureEnabled, false)
  assert.throws(() => t.alice.update(r.id, { captureEnabled: true }), (err) => err.code === 'restricted-no-capture')
  assert.throws(() => t.alice.update(r.id, { autoAnswer: true }), (err) => err.code === 'invalid-input')
  assert.throws(() => t.alice.start({ type: 'study', autoAnswer: true }), (err) => err.code === 'invalid-input', 'answering by itself needs screen reading')
})

test('the type never changes: not through update, and a new type means a new session that replaces the old one', () => {
  const t = setup()
  const study = t.alice.start({ type: 'study', captureEnabled: true })
  assert.equal(t.alice.update(study.id, { type: 'restricted', topic: 'joins' }).sessionType, 'study', 'a type in the patch is ignored, never applied')
  const restricted = t.alice.start({ type: 'restricted' })
  assert.equal(t.alice.get(study.id).status, 'ended')
  assert.equal(t.alice.get(study.id).endReason, 'replaced')
  assert.equal(t.alice.current().id, restricted.id)
  assert.ok(t.audits.some((a) => a.event === 'academic.session_end' && a.detail.reason === 'replaced'))
})

test('pause, resume and stop; a stopped session stays stopped and releases what it held', () => {
  const t = setup()
  const s = t.alice.start({ type: 'practice', captureEnabled: true })
  t.alice.runtime(s.id).questions.set('q', { id: 'q' })
  assert.equal(t.alice.pause(s.id).status, 'paused')
  assert.equal(t.alice.current().status, 'paused', 'a paused session is still the open one')
  assert.equal(t.alice.pause(s.id).status, 'paused')
  assert.equal(t.alice.resume(s.id).status, 'active')
  assert.equal(t.alice.stop(s.id).status, 'ended')
  assert.equal(t.alice.current(), null)
  assert.equal(t.manager.heldCount(), 0, 'what the session held in memory is gone')
  assert.throws(() => t.alice.resume(s.id), (err) => err.code === 'session-ended' && err.statusCode === 409)
  assert.equal(t.alice.stop(s.id).status, 'ended', 'stopping again is fine')
  assert.throws(() => t.alice.stop('nope'), (err) => err.code === 'session-not-found')
})

test('a session times out, activity keeps it open, and a sweep releases what an expired one held', () => {
  const t = setup()
  const s = t.alice.start({ type: 'study' })
  t.alice.runtime(s.id).known.push('x')
  t.clock.t += 50 * 60_000
  t.alice.touch(s.id)
  t.clock.t += 50 * 60_000
  assert.equal(t.alice.current().id, s.id, 'activity moved the end time on')
  t.clock.t += 61 * 60_000
  assert.equal(t.alice.current(), null)
  assert.equal(t.alice.get(s.id).endReason, 'expired')
  assert.equal(t.manager.heldCount(), 0)
  const again = t.alice.start({ type: 'study' })
  t.alice.runtime(again.id)
  t.clock.t += 2 * 60 * 60_000
  assert.equal(t.manager.sweep(), 1)
})

test('a person\'s sessions are theirs: another person cannot see, change or stop them, nor name a course that is not theirs', () => {
  const t = setup()
  const s = t.alice.start({ type: 'study', courseId: t.course.id })
  assert.equal(t.bob.current(), null)
  assert.equal(t.bob.get(s.id), null)
  assert.throws(() => t.bob.stop(s.id), (err) => err.code === 'session-not-found')
  assert.throws(() => t.bob.pause(s.id), (err) => err.code === 'session-not-found')
  assert.throws(() => t.bob.start({ type: 'study', courseId: t.course.id }), (err) => err.code === 'course-not-found')
  assert.throws(() => t.alice.update(s.id, { courseId: 'nope' }), (err) => err.code === 'course-not-found')
  assert.equal(t.alice.current().status, 'active')
  t.alice.runtime(s.id).known.push('alice-only')
  assert.deepEqual(t.bob.runtime(s.id).known, [], 'even the same id gives bob an empty room of his own')
  t.bob.clearRuntime()
  assert.deepEqual(t.alice.runtime(s.id).known, ['alice-only'])
})
