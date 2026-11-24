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

// ---- an answer as it is written ---------------------------------------------------------------------------------------------------

const streamReply = (chunks, { status = 200 } = {}) => {
  const encoder = new TextEncoder()
  let i = 0
  return {
    ok: status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: encoder.encode(chunks[i++]), done: false } : { value: undefined, done: true }) }) },
    text: async () => chunks.join('')
  }
}
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

test('asking for an answer as it is written sends the event-stream request, passes each event on, and returns the final result', async () => {
  const seen = []
  const fetchFn = async (url, init) => {
    seen.push({ url, headers: init.headers })
    // the events arrive in pieces that do not line up with the events
    const all = sse('start', { task: 'define', complexity: 'simple', parts: [{ key: null, label: 'ANSWER' }] }) + sse('delta', { text: 'The next ' }) + sse('delta', { text: 'best thing.' }) + sse('result', { status: 'answered', markdown: '#### ANSWER\n\nThe next best thing.' })
    return streamReply([all.slice(0, 40), all.slice(40, 130), all.slice(130)])
  }
  const api = createAcademicApi({ fetchFn })
  const events = []
  const result = await api.answer('s1', 'q 1', { style: null }, { onEvent: (e) => events.push(e) })
  assert.equal(seen[0].headers.Accept, 'text/event-stream')
  assert.match(seen[0].url, /sessions\/s1\/questions\/q%201\/answer$/)
  assert.deepEqual(events.map((e) => e.type), ['start', 'delta', 'delta'])
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'The next best thing.')
  assert.equal(result.markdown, '#### ANSWER\n\nThe next best thing.')
})

test('an answer asked for live that the server answers as plain JSON (a refusal, or a decision for the person) is read as it always was', async () => {
  const { api } = recorder(() => ({ status: 403, body: { error: 'Restricted.', code: 'restricted-assessment', details: { offer: 'explain_concept' } } }))
  await assert.rejects(api.ask('s1', 'What is 2+2?', {}, { onEvent() {} }), (err) => err instanceof AcademicApiError && err.code === 'restricted-assessment' && err.details.offer === 'explain_concept')
  const { api: ok } = recorder(() => ({ status: 200, body: { status: 'confirm-required', signals: ['exam'] } }))
  assert.deepEqual((await ok.answer('s1', 'q1', {}, { onEvent() {} })).signals, ['exam'])
})

test('a stream that fails, or ends without its result, is an error the page can act on; a plain body with no reader still works', async () => {
  const failing = createAcademicApi({ fetchFn: async () => streamReply([sse('start', {}), sse('error', { status: 502, code: 'answer-failed', error: 'An answer could not be worked out just now. Try again.' })]) })
  await assert.rejects(failing.answer('s1', 'q1', {}, { onEvent() {} }), (err) => err.code === 'answer-failed' && err.status === 502 && /could not be worked out/.test(err.message))
  const cut = createAcademicApi({ fetchFn: async () => streamReply([sse('start', {}), sse('delta', { text: 'Half' })]) })
  await assert.rejects(cut.answer('s1', 'q1', {}, { onEvent() {} }), (err) => err.code === 'network')
  const noReader = createAcademicApi({ fetchFn: async () => ({ ...streamReply([sse('delta', { text: 'x' }), sse('result', { status: 'answered', markdown: 'x' })]), body: null }) })
  const heard = []
  assert.equal((await noReader.answer('s1', 'q1', {}, { onEvent: (e) => heard.push(e.type) })).status, 'answered')
  assert.deepEqual(heard, ['delta'])
  // without a listener nothing about the request changes
  const { api, calls } = recorder(() => ({ status: 200, body: { status: 'answered' } }))
  await api.answer('s1', 'q1', {})
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
  assert.equal(calls[0].headers.Accept, undefined)
})
