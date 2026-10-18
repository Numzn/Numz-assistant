import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import express from 'express'
import { precompressDir } from '../scripts/lib/precompress.js'
import { createStaticAssets } from '../server/http/staticAssets.js'

const IMMUTABLE = 'public, max-age=31536000, immutable'
const APP_JS = `export const answer = () => 42;\n${'// padding so the file is worth compressing\n'.repeat(80)}`
const STYLE_CSS = `body{margin:0}\n${'.rule-a{color:#eee;background:#212121}\n'.repeat(60)}`
const INDEX_HTML = `<!doctype html><html><head><script type="module" src="/assets/app-abc123.js"></script></head><body>${'<p>hello</p>'.repeat(60)}</body></html>`

function makeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numz-dist-'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.mkdirSync(path.join(dir, 'porcupine'))
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML)
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), APP_JS)
  fs.writeFileSync(path.join(dir, 'assets', 'style-def456.css'), STYLE_CSS)
  fs.writeFileSync(path.join(dir, 'assets', 'tiny-aaa111.js'), 'export default 1')
  fs.writeFileSync(path.join(dir, 'porcupine', 'model.pv'), Buffer.alloc(2000, 7))
  precompressDir(dir)
  return dir
}

/** Starts the handler the way server.js mounts it; returns { get, close }. get() returns the RAW response. */
async function serve(dir) {
  const app = express()
  const assets = createStaticAssets({ dir })
  app.use(assets)
  app.get('*', (req, res, next) => (req.path.startsWith('/api') ? next() : assets.sendIndex(req, res, next)))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const get = (urlPath, { headers = {}, method = 'GET' } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
  return { get, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function withServer(fn, prepare) {
  const dir = makeDist()
  if (prepare) prepare(dir)
  const server = await serve(dir)
  try {
    await fn(server, dir)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('a browser that lists br last still gets Brotli, and the body decodes to the original file', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'gzip, deflate, br, zstd' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], 'br')
    assert.match(res.headers['content-type'], /^application\/javascript/)
    assert.match(res.headers.vary, /Accept-Encoding/i)
    assert.equal(zlib.brotliDecompressSync(res.body).toString(), APP_JS)
    assert.equal(Number(res.headers['content-length']), res.body.length, 'Content-Length is the compressed size')
    assert.ok(res.body.length < APP_JS.length / 4, 'and it is much smaller')
  })
})

test('gzip is used when only gzip is accepted, and a q=0 Brotli is not used', async () => {
  await withServer(async ({ get }) => {
    for (const accept of ['gzip', 'br;q=0, gzip', 'gzip, deflate']) {
      const res = await get('/assets/style-def456.css', { headers: { 'Accept-Encoding': accept } })
      assert.equal(res.headers['content-encoding'], 'gzip', accept)
      assert.match(res.headers['content-type'], /^text\/css/)
      assert.equal(zlib.gunzipSync(res.body).toString(), STYLE_CSS)
    }
  })
})

test('with no Accept-Encoding, or identity, the original bytes are sent untouched', async () => {
  await withServer(async ({ get }) => {
    for (const headers of [{}, { 'Accept-Encoding': 'identity' }]) {
      const res = await get('/assets/app-abc123.js', { headers })
      assert.equal(res.status, 200)
      assert.equal(res.headers['content-encoding'], undefined)
      assert.equal(res.body.toString(), APP_JS)
      assert.match(res.headers.vary, /Accept-Encoding/i, 'caches must still key on the encoding')
    }
  })
})

test('hashed assets are cached for a year as immutable, in every encoding', async () => {
  await withServer(async ({ get }) => {
    for (const accept of ['br', 'gzip', 'identity']) {
      const res = await get('/assets/app-abc123.js', { headers: { 'Accept-Encoding': accept } })
      assert.equal(res.headers['cache-control'], IMMUTABLE, accept)
    }
    const css = await get('/assets/style-def456.css', { headers: { 'Accept-Encoding': 'br' } })
    assert.equal(css.headers['cache-control'], IMMUTABLE)
  })
})

test('the page that names the hashed files is never cached without revalidation', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/index.html', { headers: { 'Accept-Encoding': 'br' } })
    assert.equal(res.headers['cache-control'], 'no-cache')
    assert.equal(res.headers['content-encoding'], 'br')
    assert.match(res.headers['content-type'], /^text\/html/)
    assert.equal(zlib.brotliDecompressSync(res.body).toString(), INDEX_HTML)
  })
})

test('any other page path gets the app, compressed and revalidated; API paths are left alone', async () => {
  await withServer(async ({ get }) => {
    const page = await get('/history', { headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(page.status, 200)
    assert.equal(page.headers['cache-control'], 'no-cache')
    assert.equal(zlib.gunzipSync(page.body).toString(), INDEX_HTML)
    const api = await get('/api/v1/nothing')
    assert.equal(api.status, 404, 'an /api path falls through (to the API handlers in the real server)')
  })
})

test('files that are not compressible are served as they are and revalidated', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/porcupine/model.pv', { headers: { 'Accept-Encoding': 'br, gzip' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], undefined)
    assert.equal(res.headers['cache-control'], 'no-cache')
    assert.equal(res.body.length, 2000)
  })
})

test('a file too small to gain from compression has no compressed copy and is sent plain', async () => {
  await withServer(async ({ get }, dir) => {
    assert.equal(fs.existsSync(path.join(dir, 'assets', 'tiny-aaa111.js.br')), false)
    const res = await get('/assets/tiny-aaa111.js', { headers: { 'Accept-Encoding': 'br' } })
    assert.equal(res.headers['content-encoding'], undefined)
    assert.equal(res.body.toString(), 'export default 1')
    assert.equal(res.headers['cache-control'], IMMUTABLE)
  })
})

test('a compressed copy older than its file is ignored: a stale copy is never served', async () => {
  await withServer(
    async ({ get }) => {
      const res = await get('/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'br, gzip' } })
      assert.equal(res.headers['content-encoding'], undefined)
      assert.match(res.body.toString(), /newer content/)
    },
    (dir) => {
      const file = path.join(dir, 'assets', 'app-abc123.js')
      fs.writeFileSync(file, `${APP_JS}// newer content\n`)
      const later = new Date(Date.now() + 5000)
      fs.utimesSync(file, later, later)
    }
  )
})

test('each encoding has its own ETag and a repeat request answers 304', async () => {
  await withServer(async ({ get }) => {
    const br = await get('/index.html', { headers: { 'Accept-Encoding': 'br' } })
    const plain = await get('/index.html', { headers: { 'Accept-Encoding': 'identity' } })
    assert.ok(br.headers.etag && plain.headers.etag)
    assert.notEqual(br.headers.etag, plain.headers.etag)
    const again = await get('/index.html', { headers: { 'Accept-Encoding': 'br', 'If-None-Match': br.headers.etag } })
    assert.equal(again.status, 304)
    assert.equal(again.body.length, 0)
  })
})

test('HEAD works, other methods and traversal attempts are not served', async () => {
  await withServer(async ({ get }) => {
    const head = await get('/assets/app-abc123.js', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } })
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-encoding'], 'br')
    assert.equal(head.body.length, 0)
    const post = await get('/assets/app-abc123.js', { method: 'POST' })
    assert.equal(post.status, 404)
    for (const bad of ['/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2f..%2fpackage.json', '/assets/%00.js']) {
      // Whatever the status, the answer is the app shell or an error, never a file from outside the folder.
      const res = await get(bad, { headers: { 'Accept-Encoding': 'identity' } })
      if (res.status === 200) assert.equal(res.body.toString(), INDEX_HTML, bad)
      assert.doesNotMatch(res.body.toString(), /root:|"name":/, bad)
    }
  })
})

test('precompressDir keeps a copy only when it is smaller, writes both kinds, and removes copies that stopped paying', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numz-pre-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), APP_JS)
    fs.writeFileSync(path.join(dir, 'tiny.js'), 'x')
    fs.writeFileSync(path.join(dir, 'noise.bin'), Buffer.alloc(5000, 1))
    fs.writeFileSync(path.join(dir, 'tiny.js.br'), 'left over from an old build')
    const results = precompressDir(dir)
    const a = results.find((r) => r.file === 'a.js')
    assert.ok(a.br < a.gz && a.gz < a.raw, `brotli ${a.br} < gzip ${a.gz} < raw ${a.raw}`)
    assert.equal(zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, 'a.js.br'))).toString(), APP_JS)
    assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'a.js.gz'))).toString(), APP_JS)
    assert.equal(fs.existsSync(path.join(dir, 'tiny.js.br')), false, 'the stale copy is gone')
    assert.equal(fs.existsSync(path.join(dir, 'noise.bin.br')), false, 'not a compressible type')
    assert.deepEqual(results.map((r) => r.file).sort(), ['a.js', 'tiny.js'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
