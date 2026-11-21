/**
 * What kind of picture some bytes are, judged by the bytes and not by any label the sender gave: 'image/jpeg',
 * 'image/png', 'image/webp', or null for anything else (an SVG, a PDF, text, an empty body).
 */
export function pictureKind(bytes) {
  if (!bytes || typeof bytes.length !== 'number') return null
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 12 && Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, 12).toString('latin1', 0, 4) === 'RIFF' && Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, 12).toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}
