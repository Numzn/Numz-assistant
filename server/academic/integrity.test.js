import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIONS, assessmentSignals, enforce, evaluate } from './integrity.js'

const NOW = Date.parse('2026-11-22T12:00:00.000Z')
const session = (over = {}) => ({ id: 's', sessionType: 'study', status: 'active', expiresAt: '2026-11-22T16:00:00.000Z', ...over })

test('study and practice sessions may read the screen and answer; the mode says which', () => {
  for (const action of ['capture', 'read_question', 'answer', 'explain_concept', 'research', 'feedback']) {
    assert.deepEqual(evaluate({ session: session(), action, now: NOW }), { allowed: true, mode: 'full' }, action)
    assert.deepEqual(evaluate({ session: session({ sessionType: 'practice' }), action, now: NOW }), { allowed: true, mode: 'practice' }, action)
  }
})

test('a restricted session reads nothing and answers nothing; it can only teach a concept and take feedback', () => {
  const restricted = session({ sessionType: 'restricted' })
  for (const action of ['capture', 'read_question', 'answer', 'research']) {
    const verdict = evaluate({ session: restricted, action, now: NOW })
    assert.equal(verdict.allowed, false, action)
    assert.equal(verdict.code, 'restricted-assessment')
    assert.match(verdict.message, /explain the underlying concepts/)
  }
  for (const action of ['explain_concept', 'feedback']) assert.deepEqual(evaluate({ session: restricted, action, now: NOW }), { allowed: true, mode: 'conceptual' })
})

test('without a live session nothing happens, whatever the type', () => {
  assert.equal(evaluate({ session: null, action: 'answer', now: NOW }).code, 'session-required')
  assert.equal(evaluate({ session: session({ status: 'paused' }), action: 'capture', now: NOW }).code, 'session-paused')
  assert.equal(evaluate({ session: session({ status: 'ended' }), action: 'explain_concept', now: NOW }).code, 'session-ended')
  assert.equal(evaluate({ session: session({ expiresAt: '2026-11-22T11:00:00.000Z' }), action: 'answer', now: NOW }).code, 'session-expired')
  assert.throws(() => evaluate({ session: session(), action: 'hack', now: NOW }), /unknown academic action/)
  assert.equal(ACTIONS.length, 6)
})

test('enforce turns a refusal into a 403 that offers the conceptual alternative', () => {
  assert.throws(
    () => enforce({ session: session({ sessionType: 'restricted' }), action: 'answer', now: NOW }),
    (err) => err.statusCode === 403 && err.code === 'restricted-assessment' && err.details.offer === 'explain_concept' && err.details.sessionType === 'restricted'
  )
  assert.equal(enforce({ session: session(), action: 'answer', now: NOW }).allowed, true)
})

test('a screen that says it is an examination is noticed (kinds only) but never switches anything', () => {
  assert.deepEqual(assessmentSignals(['closed book'], 'Time remaining: 45:00', ['Q1 ...']).sort(), ['closed-book', 'live-timer'])
  assert.deepEqual(assessmentSignals('You must not use AI or notes during this examination'), ['no-assistance-rule'])
  assert.ok(assessmentSignals('FINAL EXAMINATION - Semester 2').includes('formal-exam'))
  assert.ok(assessmentSignals('Please do not use ChatGPT').includes('no-assistance-rule'))
  assert.deepEqual(assessmentSignals('Explain third normal form with an example.', 'Practice set 3'), [])
  assert.deepEqual(assessmentSignals(), [])
})
