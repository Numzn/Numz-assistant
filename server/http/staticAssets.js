import express from 'express'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Serves the built frontend (dist/) quickly and cheaply:
 *
 *   - Compression. `npm run build` leaves a Brotli (.br) and a gzip (.gz) copy beside each compressible file
 *     (scripts/precompress.js). A request that accepts one gets it with Content-Encoding and Vary, so nothing
 *     is compressed per request. Brotli wins whenever it is accepted, whatever order the browser lists it in.
 *     A copy older than its original is ignored (a stale copy must never be served for a newer file).
 *   - Caching. Everything under /assets/ has a content hash in its name, so it never changes: it is cached for
 *     a year and marked immutable, and a returning visitor downloads none of it. Every other file (index.html
 *     above all, which names the current hashed files) is `no-cache`: kept, but revalidated by ETag each time.
 *
 * Only GET and HEAD are handled; anything else, and any path that is not a file, falls through to `next()`.
 */

/** File types worth compressing; scripts/precompress.js writes the copies for exactly these. */
export const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.txt', '.xml', '.webmanifest', '.map'])
const IMMUTABLE_PREFIXES = ['/assets/']
const ONE_YEAR_S = 31_536_000

function toUrlPath(root, file) {
  return '/' + path.relative(root, file).split(path.sep).join('/')
}

/** Every `<file>.br` / `<file>.gz` in dir whose original exists and is not newer: url path -> { br, gz }. */
function scanVariants(dir) {
  const variants = new Map()
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const match = entry.name.match(/^(.*)\.(br|gz)$/)
      if (!match) continue
      const original = path.join(current, match[1])
      try {
        if (fs.statSync(full).mtimeMs < fs.statSync(original).mtimeMs) continue
      } catch {
        continue
      }
      const key = toUrlPath(dir, original)
      const found = variants.get(key) ?? {}
      found[match[2]] = true
      variants.set(key, found)
    }
  }
  walk(dir)
  return variants
}

function cacheControlFor(urlPath) {
  return IMMUTABLE_PREFIXES.some((prefix) => urlPath.startsWith(prefix))
    ? `public, max-age=${ONE_YEAR_S}, immutable`
    : 'no-cache'
}

/** @returns an Express middleware (also callable as `handler(req, res, next)`). */
export function createStaticAssets({ dir }) {
  const root = path.resolve(dir)
  const variants = scanVariants(root)

  const files = express.static(root, {
    index: false,
    // Cache-Control is set here, per file, because the same middleware serves hashed and unhashed files.
    setHeaders(res, filePath) {
      const original = filePath.replace(/\.(br|gz)$/, '')
      res.setHeader('Cache-Control', cacheControlFor(toUrlPath(root, original)))
    }
  })

  function staticAssets(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()

    let urlPath
    try {
      urlPath = decodeURIComponent(req.path)
    } catch {
      return next()
    }

    const extension = path.extname(urlPath).toLowerCase()
    if (COMPRESSIBLE.has(extension)) {
      res.vary('Accept-Encoding')
      const available = variants.get(urlPath)
      if (available) {
        const encoding = available.br && req.acceptsEncodings('br') ? 'br' : available.gz && req.acceptsEncodings('gzip') ? 'gzip' : null
        if (encoding) {
          // Serve the compressed file, but under the original's name and type.
          res.type(extension)
          res.setHeader('Content-Encoding', encoding)
          const originalUrl = req.url
          const query = originalUrl.includes('?') ? originalUrl.slice(originalUrl.indexOf('?')) : ''
          const suffix = encoding === 'br' ? '.br' : '.gz'
          req.url = (urlPath + suffix).split('/').map(encodeURIComponent).join('/') + query
          return files(req, res, (error) => {
            req.url = originalUrl
            res.removeHeader('Content-Encoding')
            next(error)
          })
        }
      }
    }
    return files(req, res, next)
  }

  /**
   * For "any other page path": the app itself (index.html), compressed and revalidated like the rest.
   * Not for /assets/: a hashed file that is not there is a 404. Answering 200 with the page instead would hand a
   * stale browser tab (one opened before a deploy, asking for last week's chunk) HTML where it expects script.
   */
  staticAssets.sendIndex = (req, res, next) => {
    if (IMMUTABLE_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next()
    req.url = '/index.html'
    return staticAssets(req, res, next)
  }

  return staticAssets
}
