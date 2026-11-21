import assert from 'node:assert/strict'
import test from 'node:test'
import { cameraLimitsFromEnv } from '../server/camera/cameraLimits.js'

/** The owner's cost control: how many pictures one camera session may read, from CAMERA_MAX_READS. */

test('unset or empty: nothing is overridden, so the built-in limit applies', () => {
  assert.deepEqual(cameraLimitsFromEnv({}), {})
  assert.deepEqual(cameraLimitsFromEnv({ CAMERA_MAX_READS: '' }), {})
  assert.deepEqual(cameraLimitsFromEnv({ CAMERA_MAX_READS: '   ' }), {})
})

test('a whole number from 1 to 1000 sets the limit', () => {
  assert.deepEqual(cameraLimitsFromEnv({ CAMERA_MAX_READS: '2' }), { maxReads: 2 })
  assert.deepEqual(cameraLimitsFromEnv({ CAMERA_MAX_READS: ' 40 ' }), { maxReads: 40 })
  assert.deepEqual(cameraLimitsFromEnv({ CAMERA_MAX_READS: '1000' }), { maxReads: 1000 })
})

test('anything else is ignored rather than guessed at: zero, negative, fractional, huge, text', () => {
  for (const bad of ['0', '-5', '2.5', '1001', '99999999', 'many', '10 pictures', '1e3', '0x10', 'NaN']) {
    assert.deepEqual(cameraLimitsFromEnv({ CAMERA_MAX_READS: bad }), {}, bad)
  }
})
