import assert from 'node:assert/strict'
import test from 'node:test'
import { createUnconfiguredVision } from '../server/camera/vision.js'
import { runVisionCheck } from '../server/camera/visionCheck.js'

/**
 * The one-command check that a vision provider is set up properly (scripts/camera-vision-check.js): sends a picture to
 * the configured provider and says, in words, what happened. It must be useful when something is wrong, and it must
 * never print the key or the provider's own error text (which can echo it).
 */

const KEY = 'sk-live-secret-0123456789'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const GOOD = JSON.stringify({ isQuestion: true, text: 'A car travels 150 km in 2.5 hours. What is its average speed?', options: [{ label: 'A', text: '40 km/h' }, { label: 'B', text: '60 km/h' }], type: 'multiple-choice', subject: 'physics', hasDiagram: false, confidence: 0.92, reason: '' })

const vision = (read, name = 'anthropic') => ({ configured: true, name, read })
let clock = 0
const now = () => (clock += 250)

test('a working provider: the question it read is reported, with how long it took', async () => {
  const seen = []
  const result = await runVisionCheck({ vision: vision(async (call) => (seen.push(call), GOOD)), picture: JPEG, now })
  assert.equal(result.ok, true)
  assert.equal(result.stage, 'done')
  assert.equal(result.provider, 'anthropic')
  assert.match(result.question.text, /150 km in 2\.5 hours/)
  assert.deepEqual(result.question.options.map((o) => o.label), ['A', 'B'])
  assert.equal(result.question.confidence, 0.92)
  assert.equal(result.ms, 250)
  assert.equal(seen.length, 1, 'one picture, one call')
  assert.equal(seen[0].image.mimeType, 'image/jpeg')
  assert.equal(seen[0].messages[0].role, 'system', 'the same prompt the page uses')
})

test('nothing configured: says which settings are missing, never a value', async () => {
  const result = await runVisionCheck({ vision: createUnconfiguredVision(['CAMERA_VISION_API_KEY', 'CAMERA_VISION_MODEL']), picture: JPEG, now })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'configuration')
  assert.deepEqual(result.missing, ['CAMERA_VISION_API_KEY', 'CAMERA_VISION_MODEL'])
  assert.match(result.advice, /CAMERA_VISION_API_KEY/)
})

test('with no provider chosen yet, the advice names everything that has to be set', async () => {
  const result = await runVisionCheck({ vision: createUnconfiguredVision(['CAMERA_VISION_PROVIDER']), picture: JPEG, now })
  for (const name of ['CAMERA_VISION_PROVIDER', 'CAMERA_VISION_API_KEY', 'CAMERA_VISION_MODEL']) assert.match(result.advice, new RegExp(name))
  assert.match(result.advice, /anthropic/)
  assert.match(result.advice, /openai-compatible/)
})

test('a file that is not a picture the camera accepts is refused before anything is sent', async () => {
  let called = false
  for (const picture of [Buffer.from('%PDF-1.4'), Buffer.alloc(0), Buffer.from('hello')]) {
    const result = await runVisionCheck({ vision: vision(async () => ((called = true), GOOD)), picture, now })
    assert.equal(result.stage, 'picture')
    assert.equal(result.ok, false)
  }
  assert.equal(called, false)
})

test('a rejected request is explained by its status, and neither the key nor the provider\'s words are shown', async () => {
  const cases = [
    [401, /key|permission/i],
    [403, /key|permission/i],
    [404, /model|address/i],
    [400, /picture.*model.*setting|setting.*model/i],
    [429, /limit|quota|busy|wait/i],
    [500, /provider/i],
    [529, /provider|busy|overloaded/i]
  ]
  for (const [status, advice] of cases) {
    const result = await runVisionCheck({ vision: vision(async () => { throw Object.assign(new Error(`bad key ${KEY}`), { statusCode: status }) }), picture: JPEG, now })
    assert.equal(result.ok, false, String(status))
    assert.equal(result.stage, 'provider')
    assert.equal(result.status, status)
    assert.match(result.advice, advice, String(status))
    assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY), 'the key must never be printed')
  }
})

test('a provider that cannot be reached, or does not answer in time, is said to be unreachable', async () => {
  const down = await runVisionCheck({ vision: vision(async () => { throw Object.assign(new Error('The vision service could not be reached'), { name: 'VisionError' }) }), picture: JPEG, now })
  assert.equal(down.stage, 'provider')
  assert.equal(down.status, null)
  assert.match(down.advice, /reach|address|network/i)
  const slow = await runVisionCheck({ vision: vision(async () => { throw Object.assign(new Error('late'), { name: 'TimeoutError' }) }), picture: JPEG, now })
  assert.match(slow.advice, /in time|slow|timed/i)
})

test('a reply that is not the expected JSON is reported, and what came back is not echoed', async () => {
  const result = await runVisionCheck({ vision: vision(async () => `I cannot help with that. ${KEY}`), picture: JPEG, now })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'reply')
  assert.match(result.advice, /JSON|format|model/i)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY))
})

test('a picture with no question in it is a result, not a failure of the provider', async () => {
  const none = JSON.stringify({ isQuestion: false, text: '', options: [], type: 'other', subject: '', hasDiagram: false, confidence: 0.9, reason: 'It is a menu.' })
  const result = await runVisionCheck({ vision: vision(async () => none), picture: JPEG, now })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'reading')
  assert.equal(result.reading, 'not-a-question')
  assert.match(result.advice, /question/i)
})

test('a deadline is applied so a hung provider cannot hang the check', async () => {
  const result = await runVisionCheck({ vision: vision(() => new Promise(() => {})), picture: JPEG, now, timeoutMs: 20 })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'provider')
  assert.match(result.advice, /in time|timed/i)
})
