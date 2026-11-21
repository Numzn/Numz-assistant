import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import { BrokerRefused, BrokerUnavailable, createBrokerClient, pkcePair } from './brokerClient.js'

const SECRET = 'k'.repeat(43)
const SUB = 'a1b2c3d4e5f6'
let nowMs = Date.UTC(2026, 10, 21, 12, 0, 0)
const clock = () => nowMs
const nowS = () => Math.floor(nowMs / 1000)

const sign = (claims, secret = SECRET) => {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
const claims = (over = {}) => ({
  iss: 'numzlab-auth', aud: 'numz-ai', sub: SUB, email: 'a@example.com', name: 'A', role: 'viewer', permissions: ['ai.use'], status: 'active',
  iat: nowS(), exp: nowS() + 120, jti: `j-${Math.random()}`, ...over
})
const answer = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })

function client(fetchFn = async () => answer(500, {})) {
  return createBrokerClient({
    brokerUrl: 'http://back.test:18792/',
    authorizeBase: 'https://lab.test/',
    clientId: 'numz-ai',
    clientSecret: SECRET,
    redirectUri: 'https://lab.test/ai/auth/callback',
    fetchFn,
    clock
  })
}

test('it will not start without its address, client id, redirect address and a long secret', () => {
  const base = { brokerUrl: 'http://b', authorizeBase: 'https://l', clientId: 'numz-ai', clientSecret: SECRET, redirectUri: 'https://l/cb' }
  for (const missing of ['brokerUrl', 'authorizeBase', 'clientId', 'redirectUri']) assert.throws(() => createBrokerClient({ ...base, [missing]: '' }), /needs/, missing)
  assert.throws(() => createBrokerClient({ ...base, clientSecret: 'short' }), /needs/)
  assert.throws(() => createBrokerClient({ ...base, clientSecret: undefined }), /needs/)
  assert.doesNotThrow(() => createBrokerClient(base))
})

test('PKCE: the challenge is the S256 of the verifier, and every pair is new', () => {
  const a = pkcePair()
  assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('base64url'))
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43,128}$/)
  assert.notEqual(a.verifier, pkcePair().verifier)
})

test('the sign-in address names the client, the exact redirect address, the state and the S256 challenge, on the public address', () => {
  const url = new URL(client().authorizeUrl({ state: 'st'.repeat(10), challenge: 'ch'.repeat(22) }))
  assert.equal(`${url.origin}${url.pathname}`, 'https://lab.test/auth/broker/authorize')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: 'numz-ai',
    redirect_uri: 'https://lab.test/ai/auth/callback',
    response_type: 'code',
    state: 'st'.repeat(10),
    code_challenge: 'ch'.repeat(22),
    code_challenge_method: 'S256'
  })
})

test('the sign-in state is sealed: it round-trips, and cannot be altered, forged, expired or opened with another key', () => {
  const c = client()
  const sealed = c.sealState({ state: 's', verifier: 'v', next: '/ai/', exp: nowS() + 600 })
  assert.deepEqual(c.openState(sealed), { state: 's', verifier: 'v', next: '/ai/', exp: nowS() + 600 })
  const [body, mac] = sealed.split('.')
  const altered = Buffer.from(JSON.stringify({ state: 's', verifier: 'v', next: 'https://evil.example/', exp: nowS() + 600 })).toString('base64url')
  assert.equal(c.openState(`${altered}.${mac}`), null, 'a changed body keeps no valid seal')
  assert.equal(c.openState(`${body}.${'0'.repeat(64)}`), null)
  assert.equal(c.openState(`${body}.zz`), null)
  assert.equal(c.openState('nonsense'), null)
  assert.equal(c.openState(undefined), null)
  assert.equal(c.openState(c.sealState({ state: 's', exp: nowS() - 1 })), null, 'expired')
  const other = createBrokerClient({ brokerUrl: 'http://b', authorizeBase: 'https://l', clientId: 'numz-ai', clientSecret: 'z'.repeat(43), redirectUri: 'https://l/cb', clock })
  assert.equal(other.openState(sealed), null, 'another client secret, another seal')
})

test('a statement is accepted only if signed with the client secret, from numzlab-auth, for this client, fresh, active and allowed to use NUMZ AI', () => {
  const c = client()
  assert.equal(c.verifyAssertion(sign(claims())).sub, SUB)
  const refused = (value, code, label) => assert.throws(() => c.verifyAssertion(value), (err) => err instanceof BrokerRefused && err.code === code, label)
  refused(sign(claims(), 'x'.repeat(43)), 'signature', 'signed with another secret')
  refused(sign(claims({ iss: 'someone-else' })), 'issuer')
  refused(sign(claims({ aud: 'other-app' })), 'audience')
  refused(sign(claims({ exp: nowS() - 1 })), 'expired')
  refused(sign(claims({ iat: nowS() + 3600 })), 'clock')
  refused(sign(claims({ sub: 'user@example.com' })), 'subject')
  refused(sign(claims({ sub: 'A1B2C3D4E5F6' })), 'subject', 'upper case is not a user id')
  refused(sign(claims({ status: 'suspended' })), 'status')
  refused(sign(claims({ permissions: [] })), 'permission')
  refused(sign(claims({ permissions: 'ai.use' })), 'permission')
  refused(sign(claims({ email: '' })), 'malformed')
  refused(sign(claims({ jti: '' })), 'malformed')
  refused('not-a-statement', 'malformed')
  refused('a.b.c', 'malformed')
  // altering the payload after signing breaks the signature
  const good = sign(claims())
  const forged = `${Buffer.from(JSON.stringify(claims({ role: 'admin' }))).toString('base64url')}.${good.split('.')[1]}`
  refused(forged, 'signature')
})

test('a statement can be used once', () => {
  const c = client()
  const statement = sign(claims({ jti: 'only-once' }))
  c.verifyAssertion(statement)
  assert.throws(() => c.verifyAssertion(statement), (err) => err.code === 'replay')
  nowMs += 200_000 // long after it expired, its id is forgotten: but it is expired anyway
  assert.throws(() => c.verifyAssertion(statement), (err) => err.code === 'expired')
  nowMs -= 200_000
})

test('exchanging a code sends the client credentials and the verifier to the back channel, and returns the checked statement', async () => {
  const seen = []
  const c = client(async (url, init) => {
    seen.push({ url, init })
    return answer(200, { assertion: sign(claims({ jti: 'x1' })), expires_in: 120 })
  })
  const result = await c.exchange({ code: 'c'.repeat(30), verifier: 'v'.repeat(43) })
  assert.equal(result.sub, SUB)
  assert.equal(seen[0].url, 'http://back.test:18792/auth/broker/token')
  assert.equal(seen[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    client_id: 'numz-ai', client_secret: SECRET, code: 'c'.repeat(30), redirect_uri: 'https://lab.test/ai/auth/callback', code_verifier: 'v'.repeat(43)
  })
  assert.equal(seen[0].init.redirect, 'manual')
})

test('what goes wrong with an exchange is told apart: a refused code, a refused server, an unreachable service, a bad answer', async () => {
  const run = (fetchFn) => client(fetchFn).exchange({ code: 'c'.repeat(30), verifier: 'v'.repeat(43) })
  await assert.rejects(run(async () => answer(400, { error: 'invalid_grant' })), (err) => err instanceof BrokerRefused && err.code === 'grant')
  for (const status of [401, 403, 404]) {
    await assert.rejects(run(async () => answer(status, {})), (err) => err instanceof BrokerUnavailable && /client secret/.test(err.message), `status ${status}`)
  }
  await assert.rejects(run(async () => answer(500, {})), BrokerUnavailable)
  await assert.rejects(run(async () => answer(200, 'not json')), BrokerUnavailable)
  await assert.rejects(run(async () => answer(200, { assertion: 5 })), BrokerUnavailable)
  await assert.rejects(run(async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:18792') }), (err) => err instanceof BrokerUnavailable && !/10\.0\.0\.1/.test(err.message))
  await assert.rejects(run(async () => answer(200, { assertion: sign(claims({ status: 'suspended' })) })), (err) => err instanceof BrokerRefused && err.code === 'status')
})

test('no error ever carries the client secret', async () => {
  const c = client(async () => { throw new Error(`boom ${SECRET}`) })
  await assert.rejects(c.exchange({ code: 'c'.repeat(30), verifier: 'v'.repeat(43) }), (err) => !err.message.includes(SECRET))
  await assert.rejects(c.lookupUser(SUB), (err) => !err.message.includes(SECRET))
})

test('asking whether a person is still approved: Basic credentials out, status and role back; unknown means removed; trouble means unavailable', async () => {
  const seen = []
  const c = client(async (url, init) => {
    seen.push({ url, init })
    if (url.endsWith('/user/ffffffffffff')) return answer(404, { error: 'not found' })
    if (url.endsWith('/user/eeeeeeeeeeee')) return answer(500, {})
    return answer(200, { sub: SUB, status: 'suspended', role: 'operator', permissions: [], updated: 1 })
  })
  assert.deepEqual(await c.lookupUser(SUB), { status: 'suspended', role: 'operator', permissions: [] })
  assert.equal(seen[0].url, `http://back.test:18792/auth/broker/user/${SUB}`)
  assert.equal(seen[0].init.headers.Authorization, `Basic ${Buffer.from(`numz-ai:${SECRET}`).toString('base64')}`)
  assert.deepEqual(await c.lookupUser('ffffffffffff'), { status: 'removed', role: null, permissions: [] })
  await assert.rejects(c.lookupUser('eeeeeeeeeeee'), BrokerUnavailable)
  const before = seen.length
  assert.deepEqual(await c.lookupUser('../../etc/passwd'), { status: 'removed', role: null, permissions: [] })
  assert.equal(seen.length, before, 'something that is not a user id never reaches the network')
})
