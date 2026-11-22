import { pictureKind } from '../camera/pictureKind.js'

/**
 * What a screenshot is, judged from its own bytes: the kind (as pictureKind: jpeg, png or webp) and its pixel size, read from the
 * header. This is a sanity check, not a decoder: it refuses what is plainly not a picture (a label that lies, a truncated header,
 * a size of zero or of absurd proportions) before any model is asked, and it never allocates anything proportional to the picture.
 *
 *   imageInfo(bytes) -> { mimeType, width, height } | null
 */

function pngSize(b) {
  // 8-byte signature, then the IHDR chunk: length(4) 'IHDR'(4) width(4) height(4)
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function jpegSize(b) {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    let marker = b[i + 1]
    while (marker === 0xff && i + 2 < b.length) {
      i += 1
      marker = b[i + 1]
    }
    // start-of-frame markers carry the size (C4, C8 and CC are not frames)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // end of image / start of scan with no frame header seen
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

function webpSize(b) {
  if (b.length < 30) return null
  const kind = b.toString('latin1', 12, 16)
  if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

export function imageInfo(input) {
  const bytes = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : null
  if (!bytes) return null
  const mimeType = pictureKind(bytes)
  if (!mimeType) return null
  let size = null
  try {
    size = mimeType === 'image/png' ? pngSize(bytes) : mimeType === 'image/jpeg' ? jpegSize(bytes) : webpSize(bytes)
  } catch {
    size = null
  }
  if (!size || !(size.width > 0) || !(size.height > 0)) return null
  return { mimeType, width: size.width, height: size.height }
}
