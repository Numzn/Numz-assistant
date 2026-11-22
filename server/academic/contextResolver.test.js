import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveContext } from './contextResolver.js'

const courses = [
  { id: 'db', title: 'Database Systems', code: 'CS201' },
  { id: 'net', title: 'Computer Networks', code: 'CS301' },
  { id: 'se', title: 'Software Engineering', code: 'CS305' }
]

test('a course chosen for the session always wins, and the screen can only add a note', () => {
  const r = resolveContext({ session: { courseId: 'net' }, courses, reading: { subject: 'databases', topic: 'third normal form', questions: [{ text: 'Explain Database Systems normalisation.' }] } })
  assert.equal(r.courseId, 'net')
  assert.equal(r.confidence, 'high')
  assert.equal(r.source, 'session')
  assert.equal(r.needsClarification, false)
  assert.equal(r.note, 'the-screen-looks-like-another-course')
  assert.equal(r.suggestion.courseId, 'db')
})

test('without a declared course, a clear match on the title or the code picks one', () => {
  const byTitle = resolveContext({ session: null, courses, reading: { subject: 'database systems', topic: 'normalisation' } })
  assert.deepEqual([byTitle.courseId, byTitle.confidence, byTitle.source], ['db', 'high', 'match'])
  const byCode = resolveContext({ session: null, courses, text: 'CS 301 Tutorial 4: explain the TCP handshake' })
  assert.equal(byCode.courseId, 'net')
  assert.equal(resolveContext({ session: null, courses, reading: { subject: 'computer networks' } }).courseId, 'net')
})

test('an unclear screen is never guessed: the answer is to ask, with the candidates', () => {
  const vague = resolveContext({ session: null, courses, reading: { subject: 'systems', topic: 'design' } })
  assert.equal(vague.courseId, null)
  assert.equal(vague.needsClarification, true)
  assert.equal(vague.confidence, 'low')
  assert.ok(vague.candidates.length > 0 && vague.candidates.length <= 3)
  const tie = resolveContext({ session: null, courses: [{ id: 'a', title: 'Networks A' }, { id: 'b', title: 'Networks B' }], reading: { subject: 'networks' } })
  assert.equal(tie.needsClarification, true)
  assert.equal(tie.reason, 'several-courses-match')
})

test('with no courses there is nothing to attach to, and that is not an error', () => {
  assert.deepEqual(resolveContext({ session: null, courses: [], reading: { subject: 'anything' } }), { courseId: null, confidence: 'none', source: 'none', needsClarification: false, candidates: [], reason: 'no-courses' })
  assert.equal(resolveContext({ session: { courseId: 'gone' }, courses, reading: {} }).needsClarification, true, 'a session course that no longer exists is not trusted')
})
