import assert from 'node:assert/strict'
import test from 'node:test'
import { MeetingApiError, createMeetingApi } from '../src/interfaces/meeting/meetingApi.js'

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) })

function recorder(response) {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    if (response instanceof Error) throw response
    return typeof response === 'function' ? response(url, init) : response
  }
  return { calls, api: createMeetingApi({ fetchFn }) }
}

test('launch sends the code in its own header, the title in the body, and no other credential', async () => {
  const { calls, api } = recorder(json(201, { meetingId: 'm1', ticket: { token: 't', expiresAt: 'x' } }))
  const result = await api.launch({ code: 'the-code', title: 'Weekly' })
  assert.equal(result.meetingId, 'm1')
  assert.equal(calls[0].url, '/api/v1/meetings/launch')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['X-Meeting-Launch-Code'], 'the-code')
  assert.equal(calls[0].init.headers.Authorization, undefined)
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Weekly' })

  const untitled = recorder(json(201, { meetingId: 'm2', ticket: { token: 't', expiresAt: 'x' } }))
  await untitled.api.launch({ code: 'c', title: '' })
  assert.deepEqual(JSON.parse(untitled.calls[0].init.body), {})
})

test('end authenticates with the meeting ticket as a Bearer token and encodes the id', async () => {
  const { calls, api } = recorder(json(200, { status: 'COMPLETED', integrity: {} }))
  await api.end({ meetingId: 'a/b c', ticketToken: 'tok.sig' })
  assert.equal(calls[0].url, '/api/v1/meetings/a%2Fb%20c/end')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok.sig')
  assert.equal(calls[0].init.headers['X-Meeting-Launch-Code'], undefined)
})

test('server errors keep their status, stable code and details', async () => {
  const { api } = recorder(json(409, { error: 'incomplete', code: 'transcript-incomplete', details: { missingSegments: 2 } }))
  await assert.rejects(
    () => api.end({ meetingId: 'm', ticketToken: 't' }),
    (err) => err instanceof MeetingApiError && err.status === 409 && err.code === 'transcript-incomplete' && err.details.missingSegments === 2
  )
})

test('a network failure is a MeetingApiError with status 0, and an unreadable error body does not crash', async () => {
  await assert.rejects(
    () => recorder(new TypeError('Failed to fetch')).api.launch({ code: 'c' }),
    (err) => err instanceof MeetingApiError && err.status === 0 && err.code === 'network'
  )
  const html = recorder({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>' })
  await assert.rejects(
    () => html.api.launch({ code: 'c' }),
    (err) => err.status === 502 && err.code === 'request-error'
  )
})

test('launchAvailable reads the health block and is false, never an error, when it cannot tell', async () => {
  assert.equal(await recorder(json(200, { meetings: { launch: { enabled: true } } })).api.launchAvailable(), true)
  assert.equal(await recorder(json(200, { meetings: { launch: { enabled: false } } })).api.launchAvailable(), false)
  assert.equal(await recorder(json(200, { meetings: {} })).api.launchAvailable(), false, 'an older server has no launch block')
  assert.equal(await recorder(json(500, {})).api.launchAvailable(), false)
  assert.equal(await recorder(new TypeError('offline')).api.launchAvailable(), false)
})
