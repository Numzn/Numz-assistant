/**
 * The cheap, on-device part of the Smart Camera: deciding WHEN a picture is worth sending to be read. Nothing here
 * reads text and nothing leaves the phone. It works on small grayscale frames (about 160x120, sampled a few times a
 * second from the live preview) and answers three questions:
 *
 *   motionBetween / createStabilityTracker   is the camera holding still?
 *   looksLikeText                            does the picture look like a page of text, and not a wall, a face or noise?
 *   signatureOf / signatureDistance          is it a different picture from one already sent?
 *
 * Motion and signatures are compared on frames pooled down to 40x30 cells, so a hand's tremor of a pixel or two and
 * sensor noise average out while a different page does not. Brightness is normalised out (the phone's exposure
 * drifts as the screen refreshes), so only the layout of light and dark counts.
 *
 * Every threshold here is an UNMEASURED default: no real phone footage of a screen has been run through it. The tests
 * pin the shape of each rule with synthetic frames. The server reads the text and has the last word on whether a
 * question is new, so a threshold that is too keen costs one wasted read, never a wrong answer.
 */

export const POOLED_WIDTH = 40
export const POOLED_HEIGHT = 30

/** RGBA pixels (a canvas's ImageData) to one 0-255 luma value each. */
export function toGray(rgba, width, height) {
  const gray = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (299 * rgba[p] + 587 * rgba[p + 1] + 114 * rgba[p + 2]) / 1000
  }
  return gray
}

/** Box-averages a frame down to POOLED_WIDTH x POOLED_HEIGHT cells (any frame at least that large). */
function pool(gray, width, height) {
  const out = new Float32Array(POOLED_WIDTH * POOLED_HEIGHT)
  for (let cy = 0; cy < POOLED_HEIGHT; cy++) {
    const y0 = Math.floor((cy * height) / POOLED_HEIGHT)
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / POOLED_HEIGHT))
    for (let cx = 0; cx < POOLED_WIDTH; cx++) {
      const x0 = Math.floor((cx * width) / POOLED_WIDTH)
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / POOLED_WIDTH))
      let sum = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += gray[y * width + x]
      out[cy * POOLED_WIDTH + cx] = sum / ((y1 - y0) * (x1 - x0))
    }
  }
  return out
}

function centered(values) {
  let mean = 0
  for (const v of values) mean += v
  mean /= values.length
  return Float32Array.from(values, (v) => v - mean)
}

/**
 * How much the layout changed between two frames of the same size, 0 (the same) up to about 1, ignoring any change in
 * brightness or contrast. Sensor noise stays under 0.1 even when strong; a pixel of hand tremor already reads about
 * 0.4 on a hard-edged page, so it can tell "still" from "moving" but not a nudge from a new page: that is the
 * signature's job, and in the end the server's, once the text has been read.
 */
export function motionBetween(a, b, width = 160, height = 120) {
  if (a.length !== b.length) throw new Error('motionBetween needs two frames of the same size')
  return signatureDistance(signatureOf(a, width, height), signatureOf(b, width, height))
}

/**
 * Whether the camera has held still. push() takes the motion between the latest two frames (motionBetween) and when
 * it was measured; the camera counts as steady once it has stayed below `stillBelow` for `stableMs`. Any movement
 * starts the count again.
 */
export function createStabilityTracker({ stillBelow = 0.12, stableMs = 700 } = {}) {
  let stillSince = null
  let latest = 0
  return {
    push(motion, nowMs) {
      latest = nowMs
      if (motion < stillBelow) {
        if (stillSince === null) stillSince = nowMs
      } else {
        stillSince = null
      }
      return { stable: stillSince !== null && nowMs - stillSince >= stableMs, stableForMs: stillSince === null ? 0 : nowMs - stillSince }
    },
    stableForMs: () => (stillSince === null ? 0 : latest - stillSince),
    reset() {
      stillSince = null
    }
  }
}

const EDGE_FLOOR = 18 // a step this small between neighbouring pixels is noise whatever the contrast
const EDGE_SHARE = 0.25 // ... and an edge is a quarter of the picture's own contrast, so dim pictures still count
const MIN_EDGE_DENSITY = 0.03
const MAX_EDGE_DENSITY = 0.45
const BUSY_ROW_SHARE = 0.08
const MIN_BUSY_ROWS = 4

/**
 * Whether a frame looks like a page of text: enough sharp edges (letters) but not everywhere (noise), spread over
 * several rows (lines of words). Light on dark and dark on light are the same. This is a cheap gate, not reading:
 * it keeps a blank wall, the floor or a hand from being sent.
 */
export function looksLikeText(gray, width, height) {
  const sorted = Uint8Array.from(gray).sort()
  const contrast = sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)]
  const threshold = Math.max(EDGE_FLOOR, contrast * EDGE_SHARE)
  let edges = 0
  let busyRows = 0
  for (let y = 0; y < height - 1; y++) {
    let rowEdges = 0
    for (let x = 0; x < width - 1; x++) {
      const here = gray[y * width + x]
      if (Math.abs(here - gray[y * width + x + 1]) >= threshold || Math.abs(here - gray[(y + 1) * width + x]) >= threshold) rowEdges++
    }
    edges += rowEdges
    if (rowEdges / (width - 1) >= BUSY_ROW_SHARE) busyRows++
  }
  const density = edges / ((width - 1) * (height - 1))
  return density >= MIN_EDGE_DENSITY && density <= MAX_EDGE_DENSITY && busyRows >= MIN_BUSY_ROWS
}

/** The layout of light and dark in a frame, brightness removed: POOLED cells with mean 0 and spread 1 (all 0 if blank). */
export function signatureOf(gray, width, height) {
  const pooled = pool(gray, width, height)
  const values = centered(pooled)
  let variance = 0
  for (const v of values) variance += v * v
  const spread = Math.sqrt(variance / values.length)
  if (spread < 0.5) return new Float32Array(values.length) // nothing to tell apart: a blank frame
  return values.map((v) => v / spread)
}

/** How different two pictures are: 0 for the same, about 0.8 or more for unrelated pages. */
export function signatureDistance(a, b) {
  if (a.length !== b.length) throw new Error('signatureDistance needs two signatures of the same size')
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}
