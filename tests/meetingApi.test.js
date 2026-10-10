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

test('launch with no code sends no launch-code header: the browser is relying on its launch session cookie', async () => {
  const { calls, api } = recorder(json(201, { meetingId: 'm1', ticket: { token: 't', expiresAt: 'x' } }))
  await api.launch({ code: '', title: 'Weekly', idempotencyKey: 'attempt-0123456789abcd' })
  const headers = calls[0].init.headers
  assert.equal(headers['X-Meeting-Launch-Code'], undefined, 'an empty code is not sent as an empty credential')
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers['Idempotency-Key'], 'attempt-0123456789abcd')
  assert.equal(calls[0].init.credentials, 'same-origin', 'the cookie is sent, and only to this origin')
})

test('launch without an idempotency key sends no such header', async () => {
  const { calls, api } = recorder(json(201, { meetingId: 'm1', ticket: { token: 't', expiresAt: 'x' } }))
  await api.launch({ code: 'c', title: '' })
  assert.equal(calls[0].init.headers['Idempotency-Key'], undefined)
})

test('launchSession reports what the server says and never throws', async () => {
  const yes = recorder(json(200, { available: true, authenticated: true }))
  assert.deepEqual(await yes.api.launchSession(), { available: true, authenticated: true })
  assert.equal(yes.calls[0].url, '/api/v1/meetings/launch/session')
  assert.equal(yes.calls[0].init.method, 'GET')

  const no = recorder(json(200, { available: true, authenticated: false }))
  assert.deepEqual(await no.api.launchSession(), { available: true, authenticated: false })

  const unreachable = recorder(new Error('offline'))
  assert.deepEqual(await unreachable.api.launchSession(), { available: false, authenticated: false })

  const broken = recorder(json(500, { error: 'boom', code: 'internal' }))
  assert.deepEqual(await broken.api.launchSession(), { available: false, authenticated: false })

  const odd = recorder(json(200, { authenticated: 'yes' }))
  assert.deepEqual(await odd.api.launchSession(), { available: false, authenticated: false }, 'only a real true counts')
})

test('forgetLaunchSession asks the server to drop the cookie and says whether it worked', async () => {
  const ok = recorder({ ok: true, status: 204, text: async () => '' })
  assert.equal(await ok.api.forgetLaunchSession(), true)
  assert.equal(ok.calls[0].url, '/api/v1/meetings/launch/session')
  assert.equal(ok.calls[0].init.method, 'DELETE')

  const down = recorder(new Error('offline'))
  assert.equal(await down.api.forgetLaunchSession(), false)
})
