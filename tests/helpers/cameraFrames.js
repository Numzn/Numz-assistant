/**
 * Synthetic camera frames for the Smart Camera tests: small grayscale pictures that behave like a photographed
 * screen (a light page of dark word-shaped blocks) with sensor noise, exposure drift and shake.
 */

export const W = 160
export const H = 120

export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A page: light background, rows of dark "words" (blocks of random glyph-like pixels). Different seeds, different words. */
export function page(seed, { dx = 0, dy = 0, rows = 7 } = {}) {
  const rand = rng(seed)
  const gray = new Uint8Array(W * H).fill(215)
  for (let row = 0; row < rows; row++) {
    const y0 = 14 + row * 14 + dy
    let x = 12 + dx
    while (x < W - 14) {
      const wordLength = 8 + Math.floor(rand() * 22)
      for (let gx = 0; gx < wordLength && x + gx < W - 10; gx++) {
        for (let gy = 0; gy < 7; gy++) {
          const yy = y0 + gy
          const xx = x + gx
          if (yy >= 0 && yy < H && xx >= 0 && xx < W && rand() < 0.55) gray[yy * W + xx] = 40
        }
      }
      x += wordLength + 5
    }
  }
  return gray
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))

export function withNoise(gray, seed, amount = 6) {
  const rand = rng(seed)
  return gray.map((v) => clamp(v + (rand() - 0.5) * 2 * amount))
}

export const withExposure = (gray, gain, offset = 0) => gray.map((v) => clamp(v * gain + offset))
export const flat = (value) => new Uint8Array(W * H).fill(value)
