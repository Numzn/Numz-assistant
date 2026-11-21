import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createStabilityTracker,
  looksLikeText,
  motionBetween,
  signatureDistance,
  signatureOf,
  toGray
} from '../src/interfaces/camera/frameAnalysis.js'
import { H, W, flat, page, rng, withExposure, withNoise } from './helpers/cameraFrames.js'

/**
 * The cheap, on-device part of the Smart Camera: deciding WHEN a picture is worth sending to be read. Nothing here
 * reads text. It answers three questions about small grayscale frames (160x120): is the camera holding still, does
 * the picture look like a page of text, and is it a different picture from the one already sent.
 *
 * Every threshold is an unmeasured default (no real phone footage was available); these tests pin the shape of the
 * rule with synthetic frames that behave like a photographed screen: a light page of dark word-shaped blocks, with
 * sensor noise, exposure drift and a little camera shake.
 */

// ---- colour to gray ----------------------------------------------------------------------------------------

test('toGray turns RGBA pixels into one luma value each, weighting green most', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255])
  const gray = toGray(rgba, 5, 1)
  assert.equal(gray.length, 5)
  assert.ok(gray[1] > gray[0] && gray[0] > gray[2], 'green is brighter than red, red brighter than blue')
  assert.equal(gray[3], 255)
  assert.equal(gray[4], 0)
})

// ---- holding still -----------------------------------------------------------------------------------------

test('noise and exposure changes are stillness; a shake or a different page is movement (motion only says "wait")', () => {
  const a = page(1)
  assert.ok(motionBetween(a, withNoise(a, 2), W, H) < 0.05, 'noise alone is not motion')
  assert.ok(motionBetween(a, withNoise(a, 3, 12), W, H) < 0.08, 'nor is strong noise')
  for (const [gain, offset] of [[1.04, 2], [0.7, -8], [1.25, 12], [0.4, 0]]) {
    assert.ok(motionBetween(a, withExposure(a, gain, offset), W, H) < 0.02, `exposure x${gain} ${offset}: the phone's auto exposure is not motion`)
  }
  assert.ok(motionBetween(a, page(1, { dx: 1, dy: 1 }), W, H) > 0.2, 'one pixel of shake is')
  assert.ok(motionBetween(a, page(1, { dx: 3, dy: 2 }), W, H) > 0.2, 'a few pixels of shake is')
  assert.ok(motionBetween(a, page(99), W, H) > 0.2, 'a different page is')
  assert.equal(motionBetween(a, a, W, H), 0)
})

test('motionBetween refuses frames of different sizes instead of guessing', () => {
  assert.throws(() => motionBetween(new Uint8Array(10), new Uint8Array(12)), /same size/)
})

test('the camera counts as steady only after it has held still for the whole interval, and any movement starts it over', () => {
  const tracker = createStabilityTracker({ stillBelow: 0.03, stableMs: 700 })
  assert.equal(tracker.push(0.01, 0).stable, false, 'the first quiet frame starts the clock')
  assert.equal(tracker.push(0.01, 250).stable, false)
  assert.equal(tracker.push(0.02, 500).stable, false)
  assert.equal(tracker.push(0.01, 700).stable, true, '700 ms of stillness')
  assert.equal(tracker.push(0.01, 950).stable, true, 'and it stays steady')
  assert.equal(tracker.push(0.2, 1200).stable, false, 'a movement ends it at once')
  assert.equal(tracker.push(0.01, 1450).stable, false, 'and the clock starts again')
  assert.equal(tracker.push(0.01, 2200).stable, true)
  assert.equal(tracker.stableForMs(), 750)
})

test('the stability clock can be reset, for after a picture was sent', () => {
  const tracker = createStabilityTracker({ stillBelow: 0.03, stableMs: 500 })
  tracker.push(0.01, 0)
  assert.equal(tracker.push(0.01, 600).stable, true)
  tracker.reset()
  assert.equal(tracker.push(0.01, 650).stable, false)
  assert.equal(tracker.stableForMs(), 0)
})

// ---- does it look like a page of text ----------------------------------------------------------------------

test('a page of words looks like text; a blank wall, a smooth gradient and pure noise do not', () => {
  assert.equal(looksLikeText(page(1), W, H), true)
  assert.equal(looksLikeText(withNoise(page(1), 3, 8), W, H), true, 'with sensor noise')
  assert.equal(looksLikeText(withExposure(page(1), 0.6), W, H), true, 'dim')
  assert.equal(looksLikeText(flat(120), W, H), false, 'a blank wall')
  assert.equal(looksLikeText(withNoise(flat(120), 4, 6), W, H), false, 'a noisy blank wall')
  const gradient = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gradient[y * W + x] = Math.round((x / W) * 200 + 20)
  assert.equal(looksLikeText(gradient, W, H), false, 'a smooth gradient')
  const rand = rng(8)
  assert.equal(looksLikeText(Uint8Array.from({ length: W * H }, () => Math.floor(rand() * 256)), W, H), false, 'pure noise is not text')
})

test('a dark-mode page of light words looks like text too', () => {
  const light = page(5)
  const inverted = light.map((v) => 255 - v)
  assert.equal(looksLikeText(inverted, W, H), true)
})

test('only a few words on an otherwise empty page still look like text, one dot does not', () => {
  assert.equal(looksLikeText(page(6, { rows: 2 }), W, H), true)
  const dot = flat(215)
  dot[60 * W + 80] = 0
  assert.equal(looksLikeText(dot, W, H), false)
})

// ---- is it a different picture ----------------------------------------------------------------------------

test('the same page is the same picture whatever the noise or the exposure', () => {
  const base = signatureOf(page(1), W, H)
  const noisy = signatureOf(withNoise(page(1), 7, 10), W, H)
  const brighter = signatureOf(withExposure(page(1), 1.25, 12), W, H)
  const darker = signatureOf(withExposure(page(1), 0.7, -8), W, H)
  for (const [name, other] of [['noise', noisy], ['brighter', brighter], ['darker', darker]]) {
    assert.ok(signatureDistance(base, other) < 0.12, `${name}: ${signatureDistance(base, other).toFixed(3)}`)
  }
  assert.equal(signatureDistance(base, base), 0)
})

test('a different page of the same layout is a different picture, clearly further than noise', () => {
  const base = signatureOf(page(1), W, H)
  const worstSame = Math.max(
    signatureDistance(base, signatureOf(withNoise(page(1), 9, 12), W, H)),
    signatureDistance(base, signatureOf(withExposure(page(1), 1.3, 15), W, H))
  )
  for (const seed of [2, 3, 4, 5, 6]) {
    const different = signatureDistance(base, signatureOf(page(seed), W, H))
    assert.ok(different > worstSame * 1.8, `page ${seed}: ${different.toFixed(3)} vs the worst "same" ${worstSame.toFixed(3)}`)
    assert.ok(different > 0.2, `page ${seed}: ${different.toFixed(3)}`)
  }
})

test('a page nudged a little (the user re-aims) is still nearer than a different page', () => {
  const base = signatureOf(page(1), W, H)
  const nudged = signatureDistance(base, signatureOf(page(1, { dx: 2, dy: 1 }), W, H))
  const different = signatureDistance(base, signatureOf(page(2), W, H))
  assert.ok(nudged < different, `${nudged.toFixed(3)} < ${different.toFixed(3)}`)
})

test('a flat frame has a neutral signature and is not mistaken for a page', () => {
  const blank = signatureOf(flat(100), W, H)
  assert.ok(blank.every((v) => v === 0))
  assert.ok(signatureDistance(blank, signatureOf(page(1), W, H)) > 0.2)
  assert.equal(signatureDistance(blank, signatureOf(flat(200), W, H)), 0, 'two blank frames are the same picture')
})

test('signatures of different sizes cannot be compared', () => {
  assert.throws(() => signatureDistance(new Float32Array(4), new Float32Array(5)), /same size/)
})
