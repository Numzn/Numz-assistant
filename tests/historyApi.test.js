import assert from 'node:assert/strict'
import test from 'node:test'
import { HistoryApiError, createHistoryApi } from '../src/interfaces/history/historyApi.js'

function rig(responses) {
  const calls = []
  const queue = [...responses]
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init?.method })
    const next = queue.shift()
    if (next instanceof Error) throw next
    const { status = 200, body } = next
    return { status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
  }
  return { api: createHistoryApi({ fetchFn }), calls }
}

test('list asks for a page and returns the server answer', async () => {
  const answer = { enabled: true, total: 1, conversations: [{ id: 'a', title: 'Hello', messageCount: 2 }] }
  const { api, calls } = rig([{ body: answer }])
  assert.deepEqual(await api.list({ limit: 20, offset: 40 }), answer)
  assert.deepEqual(calls, [{ url: '/api/v1/assistant/conversations?limit=20&offset=40', method: 'GET' }])
})

test('get opens one conversation, with the id escaped', async () => {
  const { api, calls } = rig([{ body: { id: 'x', messages: [] } }])
  await api.get('a/b c')
  assert.equal(calls[0].url, '/api/v1/assistant/conversations/a%2Fb%20c')
})

test('remove deletes one and resolves true on 204', async () => {
  const { api, calls } = rig([{ status: 204 }])
  assert.equal(await api.remove('abc'), true)
  assert.deepEqual(calls, [{ url: '/api/v1/assistant/conversations/abc', method: 'DELETE' }])
})

test('removeAll always sends the explicit confirmation the server demands', async () => {
  const { api, calls } = rig([{ body: { deleted: 3 } }])
  assert.deepEqual(await api.removeAll(), { deleted: 3 })
  assert.deepEqual(calls, [{ url: '/api/v1/assistant/conversations?confirm=all', method: 'DELETE' }])
})

test('a missing conversation is a not-found error; other failures carry the server message', async () => {
  const { api } = rig([{ status: 404, body: { error: 'Conversation not found' } }, { status: 500, body: { error: 'database is locked' } }])
  await assert.rejects(api.get('x'), (err) => err instanceof HistoryApiError && err.code === 'not-found' && err.status === 404)
  await assert.rejects(api.list(), (err) => err.code === 'request-error' && /database is locked/.test(err.message))
})

test('a network failure is reported as one, and an unreadable body does not crash', async () => {
  const { api } = rig([new Error('offline'), { status: 502 }])
  await assert.rejects(api.list(), (err) => err.code === 'network' && /offline/.test(err.message))
  await assert.rejects(api.list(), (err) => err.status === 502 && /502/.test(err.message))
})
