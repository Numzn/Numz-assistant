import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * What a visitor downloads for a built page, and what waits until it is needed.
 *
 * "First load" is the HTML plus everything it names directly: module scripts, modulepreloads and stylesheets.
 * Files that only a dynamic import() reaches (the Three.js orb, the Picovoice SDK) are "lazy": they are in the
 * build but not in anyone's first load. Sizes are measured here, not trusted from Vite: raw bytes, gzip -9 and
 * Brotli 11 of the file as built.
 */

export function sizesOf(buffer) {
  return {
    raw: buffer.length,
    gzip: zlib.gzipSync(buffer, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length
      }
    }).length
  }
}

/** URLs a built HTML page loads at once, in document order. */
export function firstLoadUrls(html) {
  const urls = []
  const add = (url, kind) => {
    if (url && url.startsWith('/') && !urls.some((u) => u.url === url)) urls.push({ url, kind })
  }
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (/type=["']module["']/i.test(tag)) add(tag.match(/\bsrc=["']([^"']+)["']/i)?.[1], 'script')
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1]
    if (rel === 'modulepreload') add(tag.match(/\bhref=["']([^"']+)["']/i)?.[1], 'script')
    else if (rel === 'stylesheet') add(tag.match(/\bhref=["']([^"']+)["']/i)?.[1], 'style')
  }
  return urls
}

/** @returns {{ page: string, files: { url, kind, raw, gzip, brotli }[], totals: { raw, gzip, brotli }, scripts: { raw, gzip, brotli } }} */
export function firstLoad(distDir, page = 'index.html') {
  const html = fs.readFileSync(path.join(distDir, page))
  const files = [{ url: `/${page}`, kind: 'html', ...sizesOf(html) }]
  for (const { url, kind } of firstLoadUrls(html.toString('utf8'))) {
    files.push({ url, kind, ...sizesOf(fs.readFileSync(path.join(distDir, url))) })
  }
  const sum = (list) => list.reduce((t, f) => ({ raw: t.raw + f.raw, gzip: t.gzip + f.gzip, brotli: t.brotli + f.brotli }), { raw: 0, gzip: 0, brotli: 0 })
  return { page, files, totals: sum(files), scripts: sum(files.filter((f) => f.kind === 'script')) }
}

/** Every built script that no page loads up front. */
export function lazyScripts(distDir, pages = ['index.html', 'history.html']) {
  const loaded = new Set(pages.flatMap((page) => firstLoad(distDir, page).files.map((f) => f.url)))
  const assets = path.join(distDir, 'assets')
  return fs
    .readdirSync(assets)
    .filter((name) => name.endsWith('.js') && !loaded.has(`/assets/${name}`))
    .map((name) => ({ url: `/assets/${name}`, ...sizesOf(fs.readFileSync(path.join(assets, name))) }))
}

export function readText(distDir, url) {
  return fs.readFileSync(path.join(distDir, url), 'utf8')
}
