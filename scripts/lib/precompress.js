import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { COMPRESSIBLE } from '../../server/http/staticAssets.js'

/**
 * Writes a Brotli (.br) and a gzip (.gz) copy beside every compressible file in `dir`, for the server to hand
 * out as they are (server/http/staticAssets.js). A copy is kept only when it is smaller than the original, and
 * a copy left over from an earlier build is removed when it no longer earns its place.
 *
 * @returns {{ file: string, raw: number, br: number | null, gz: number | null }[]}
 */
const MIN_BYTES = 256

export function precompressDir(dir) {
  const results = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (COMPRESSIBLE.has(path.extname(entry.name).toLowerCase())) results.push(compressOne(dir, full))
    }
  }
  walk(dir)
  return results.filter(Boolean).sort((a, b) => b.raw - a.raw)
}

function compressOne(root, file) {
  const source = fs.readFileSync(file)
  const relative = path.relative(root, file).split(path.sep).join('/')
  const write = (suffix, build) => {
    const target = file + suffix
    if (source.length < MIN_BYTES) {
      fs.rmSync(target, { force: true })
      return null
    }
    const packed = build()
    if (packed.length >= source.length) {
      fs.rmSync(target, { force: true })
      return null
    }
    fs.writeFileSync(target, packed)
    return packed.length
  }
  return {
    file: relative,
    raw: source.length,
    br: write('.br', () =>
      zlib.brotliCompressSync(source, {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length
        }
      })
    ),
    gz: write('.gz', () => zlib.gzipSync(source, { level: 9 }))
  }
}
