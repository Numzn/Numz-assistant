import assert from 'node:assert/strict'
import test from 'node:test'
import { AcademicApiError, createAcademicApi } from '../src/interfaces/academic/academicApi.js'

function recorder(respond = () => ({ status: 200, body: {} })) {
  const calls = []
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, ...init })
    const { status, body, headers } = respond(url, init)
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers?.[k.toLowerCase()] ?? null }, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
  }
  return { calls, api: createAcademicApi({ fetchFn }) }
}

test('every call goes to the assistant\'s academic API under the page\'s own sign-in, and ids are escaped', async () => {
  const { api, calls } = recorder()
  await api.courses.list()
  await api.documents.list('a b/c')
  await api.documents.lectures()
  await api.sessions.pause('s 1')
  assert.ok(calls.every((c) => c.url.includes('/api/v1/assistant/academic/') && c.credentials === 'same-origin'))
  assert.match(calls[1].url, /courses\/a%20b%2Fc\/documents$/)
  assert.match(calls[2].url, /\/academic\/meetings$/)
  assert.match(calls[3].url, /sessions\/s%201\/pause$/)
  assert.equal(calls[3].method, 'POST')
})

test('a document is sent as the text itself, not wrapped: markdown and plain text keep their own content type', async () => {
  const { api, calls } = recorder()
  await api.documents.upload('c1', { title: 'Week 1 & 2', type: 'lecture_notes', text: '# Heading', markdown: true })
  await api.documents.upload('c1', { title: 'plain', text: 'words', markdown: false })
  assert.match(calls[0].url, /title=Week%201%20%26%202&type=lecture_notes$/)
  assert.equal(calls[0].headers['Content-Type'], 'text/markdown')
  assert.equal(calls[0].body, '# Heading')
  assert.equal(calls[1].headers['Content-Type'], 'text/plain')
})

test('a file is sent as the file itself (streamed from disk, never read into the page), a retry and the server\'s limits have their own calls, and a 202 is a success', async () => {
  const { api, calls } = recorder((url) => (url.endsWith('/retry') || /documents\?/.test(url) ? { status: 202, body: { document: { id: 'd1', status: 'processing' }, processing: true } } : { status: 200, body: { maxDocumentBytes: 104857600, maxBatchFiles: 50 } }))
  const file = { name: 'big.md', size: 90_000_000 } // stands in for a File: any Blob goes straight to fetch
  const queued = await api.documents.upload('c1', { title: 'big', type: 'textbook', file, markdown: true })
  assert.equal(calls[0].body, file, 'the file itself is the body')
  assert.equal(calls[0].headers['Content-Type'], 'text/markdown')
  assert.equal(queued.processing, true)
  assert.equal((await api.documents.retry('d 1')).document.status, 'processing')
  assert.match(calls[1].url, /documents\/d%201\/retry$/)
  assert.equal(calls[1].method, 'POST')
  assert.deepEqual(await api.documents.limits(), { maxDocumentBytes: 104857600, maxBatchFiles: 50 })
  assert.match(calls[2].url, /academic\/limits$/)
})

test('a screenshot is sent as the picture itself with its own type, and an answer carries the chosen options', async () => {
  const { api, calls } = recorder()
  const bytes = new Uint8Array([1, 2, 3])
  await api.sendCapture('s1', { bytes, mimeType: 'image/jpeg' })
  await api.answer('s1', 'q1', { style: 'simpler', confirmPractice: true })
  assert.equal(calls[0].headers['Content-Type'], 'image/jpeg')
  assert.equal(calls[0].body, bytes)
  assert.deepEqual(JSON.parse(calls[1].body), { style: 'simpler', confirmPractice: true })
})

test('destructive memory calls name what they delete, and "everything" must say so', async () => {
  const { api, calls } = recorder()
  await api.memory.removeLane('experience')
  await api.memory.removeLane('knowledge', { courseId: 'c 1' })
  await api.memory.removeLane('knowledge', { confirmAll: true })
  await api.memory.removeEverything()
  assert.match(calls[0].url, /memory\/lane\/experience\?$/)
  assert.match(calls[1].url, /memory\/lane\/knowledge\?course=c%201&$/)
  assert.match(calls[2].url, /confirm=all$/)
  assert.match(calls[3].url, /\/memory\?confirm=all$/)
  assert.ok(calls.every((c) => c.method === 'DELETE'))
})

test('a refusal carries its code, a message fit to show, the details and any Retry-After; a dead network is a transient failure', async () => {
  const { api } = recorder(() => ({ status: 429, body: { error: 'Too fast.', code: 'capture-rate-limited', details: { wait: 3 } }, headers: { 'retry-after': '4' } }))
  await assert.rejects(api.courses.list(), (err) => err instanceof AcademicApiError && err.code === 'capture-rate-limited' && err.message === 'Too fast.' && err.retryAfterMs === 4000 && err.details.wait === 3 && err.transient === true)
  const forbidden = recorder(() => ({ status: 403, body: { error: 'No.', code: 'restricted-assessment' } }))
  await assert.rejects(forbidden.api.ask('s', 'q'), (err) => err.code === 'restricted-assessment' && err.transient === false)
  const dead = createAcademicApi({ fetchFn: async () => { throw new TypeError('down') } })
  await assert.rejects(dead.courses.list(), (err) => err.code === 'network' && err.transient === true)
  const aborted = createAcademicApi({ fetchFn: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) } })
  await assert.rejects(aborted.courses.list(), (err) => err.name === 'AbortError')
})

test('a 204 is nothing, and a body that is not JSON is an empty one', async () => {
  const none = recorder(() => ({ status: 204 }))
  assert.equal(await none.api.courses.remove('c1'), true)
  const odd = createAcademicApi({ fetchFn: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '<html>' }) })
  assert.deepEqual(await odd.courses.list(), {})
})
