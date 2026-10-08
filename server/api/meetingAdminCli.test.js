import assert from 'node:assert/strict'
import test from 'node:test'
import { runMeetingAdmin } from '../../scripts/lib/meetingAdmin.js'

const TOKEN = 'operator-admin-token-'.padEnd(40, 'q')
const ID = '00000000-0000-4000-8000-000000000042'

/** Records every request and answers from a script of [status, body]. */
function harness(...script) {
  const calls = []
  const lines = { out: [], err: [] }
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options })
    const [status, body] = script.shift() ?? [200, {}]
    return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
  }
  const run = (argv, env = { MEETING_API_TOKEN: TOKEN }) =>
    runMeetingAdmin({ argv, env, fetchImpl, out: (m) => lines.out.push(m), err: (m) => lines.err.push(m) })
  return { run, calls, lines }
}

test('create posts the title, authenticates with the admin token, and prints the ticket the live client needs', async () => {
  const { run, calls, lines } = harness([201, { meetingId: ID, status: 'CREATED', ticket: { token: 'ticket-for-the-client', expiresAt: 'x' } }])
  assert.equal(await run(['create', 'Weekly', 'sync'], { MEETING_API_TOKEN: TOKEN, MEETING_API_URL: 'http://127.0.0.1:3103/' }), 0)
  assert.equal(calls[0].url, 'http://127.0.0.1:3103/api/v1/meetings')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(JSON.parse(calls[0].body), { metadata: { title: 'Weekly sync' } })
  assert.match(lines.out[0], /ticket-for-the-client/)
})

test('the admin token is never printed, not even when the API refuses or is unreachable', async () => {
  const refused = harness([401, { error: 'Valid credentials are required', code: 'auth-required' }])
  assert.equal(await refused.run(['show', ID]), 1)
  assert.match(refused.lines.err.join('\n'), /401 auth-required/)

  const unreachable = { calls: [], lines: { out: [], err: [] } }
  const code = await runMeetingAdmin({
    argv: ['start', ID],
    env: { MEETING_API_TOKEN: TOKEN },
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    },
    out: (m) => unreachable.lines.out.push(m),
    err: (m) => unreachable.lines.err.push(m)
  })
  assert.equal(code, 1)
  assert.match(unreachable.lines.err[0], /ECONNREFUSED/)
  for (const text of [...refused.lines.out, ...refused.lines.err, ...unreachable.lines.out, ...unreachable.lines.err]) {
    assert.equal(text.includes(TOKEN), false)
  }
})

test('each command maps to the documented route', async () => {
  const cases = [
    [['start', ID], 'POST', `/${ID}/start`],
    [['ticket', ID], 'POST', `/${ID}/ticket`],
    [['end', ID], 'POST', `/${ID}/end`],
    [['cancel', ID, 'wrong', 'room'], 'POST', `/${ID}/cancel`],
    [['fail', ID], 'POST', `/${ID}/fail`],
    [['transcript', ID], 'GET', `/${ID}/transcript`]
  ]
  for (const [argv, method, path] of cases) {
    const { run, calls } = harness([200, {}])
    assert.equal(await run(argv), 0, argv.join(' '))
    assert.equal(calls[0].method, method)
    assert.equal(calls[0].url, `http://127.0.0.1:3103/api/v1/meetings${path}`)
  }
  const { run, calls } = harness([200, {}])
  await run(['cancel', ID, 'wrong', 'room'])
  assert.deepEqual(JSON.parse(calls[0].body), { reason: 'wrong room' })
})

test('show combines the meeting, its sessions and the integrity report without dumping the transcript', async () => {
  const { run, calls, lines } = harness(
    [200, { meetingId: ID, status: 'LIVE' }],
    [200, { meetingId: ID, speechSessions: [{ speechSessionId: 's1', committedSegments: 2, storedSegments: 2 }] }],
    [200, { meetingId: ID, segments: [{ text: 'secret words' }, { text: 'more' }], integrity: { complete: true, verified: true } }]
  )
  assert.equal(await run(['show', ID]), 0)
  assert.equal(calls.length, 3)
  const shown = JSON.parse(lines.out[0])
  assert.equal(shown.segmentCount, 2)
  assert.deepEqual(shown.integrity, { complete: true, verified: true })
  assert.equal(lines.out[0].includes('secret words'), false)
})

test('a refusal prints the machine code and the details an operator can act on, and exits 1', async () => {
  const { run, lines } = harness([409, { error: 'The transcript is incomplete', code: 'transcript-incomplete', details: { missingSegments: 1 } }])
  assert.equal(await run(['end', ID]), 1)
  assert.match(lines.err[0], /409 transcript-incomplete/)
  assert.match(lines.err[1], /"missingSegments": 1/)
})

test('usage and configuration mistakes exit 2 before any request is made', async () => {
  for (const [argv, env, words] of [
    [[], { MEETING_API_TOKEN: TOKEN }, /a command is required/],
    [['nonsense'], { MEETING_API_TOKEN: TOKEN }, /unknown command/],
    [['start', 'not-a-uuid'], { MEETING_API_TOKEN: TOKEN }, /UUID/],
    [['create'], {}, /MEETING_API_TOKEN is not set/]
  ]) {
    const { run, calls, lines } = harness()
    assert.equal(await run(argv, env), 2, JSON.stringify(argv))
    assert.equal(calls.length, 0)
    assert.match(lines.err[0], words)
  }
})
