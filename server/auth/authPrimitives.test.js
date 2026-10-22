import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFailureThrottle,
  createSignedSession,
  isHttps,
  readCookie,
  secretsEqual,
  sendAuthError,
  sessionCookieHeader
} from './authPrimitives.js'

const cookieOf = (cookie) => ({ headers: cookie === undefined ? {} : { cookie } })

test('readCookie finds a cookie by exact name among others, trims it, and keeps "=" inside the value', () => {
  assert.equal(readCookie(cookieOf('a=1; b=2; c=3'), 'b'), '2')
  assert.equal(readCookie(cookieOf('  b  =  two  '), 'b'), 'two')
  assert.equal(readCookie(cookieOf('token=a=b=c'), 'token'), 'a=b=c')
  assert.equal(readCookie(cookieOf('b='), 'b'), '', 'an empty value is a value')
  assert.equal(readCookie(cookieOf('dup=first; dup=second'), 'dup'), 'first', 'the first one wins')
})

test('readCookie does not match a name that is only part of another, and survives rubbish', () => {
  assert.equal(readCookie(cookieOf('xb=1; bx=2'), 'b'), null)
  assert.equal(readCookie(cookieOf('b'), 'b'), null, 'a name with no "=" is not a cookie')
  assert.equal(readCookie(cookieOf(''), 'b'), null)
  assert.equal(readCookie(cookieOf(undefined), 'b'), null)
  assert.equal(readCookie({ headers: { cookie: ['b=1'] } }, 'b'), null, 'only a string header is read')
  assert.equal(readCookie({}, 'b'), null)
})

test('isHttps believes the connection or the first value the proxy reports', () => {
  assert.equal(isHttps({ secure: true, headers: {} }), true)
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'https' } }), true)
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'HTTPS' } }), true)
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': ' https , http' } }), true)
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'http, https' } }), false, 'the first hop decides')
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'http' } }), false)
  assert.equal(isHttps({ headers: {} }), false)
  assert.equal(isHttps({}), false)
})

test('secretsEqual compares by value and is false for any difference, including length and type', () => {
  assert.equal(secretsEqual('correct horse', 'correct horse'), true)
  assert.equal(secretsEqual('correct horse', 'correct horsf'), false)
  assert.equal(secretsEqual('short', 'a much longer secret'), false)
  assert.equal(secretsEqual('', 'x'), false)
  assert.equal(secretsEqual(12345, '12345'), true, 'compared as text, as it always was')
})

test('sessionCookieHeader is HttpOnly and SameSite=Strict, Secure only over https', () => {
  const plain = sessionCookieHeader({ headers: {} }, { name: 'n', value: 'v', path: '/p', maxAge: 60 })
  assert.equal(plain, 'n=v; Path=/p; HttpOnly; SameSite=Strict; Max-Age=60')
  const secure = sessionCookieHeader({ headers: { 'x-forwarded-proto': 'https' } }, { name: 'n', value: '', path: '/', maxAge: 0 })
  assert.equal(secure, 'n=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure')
})

test('sendAuthError answers { error, code, requestId } with the status', () => {
  const sent = {}
  const res = {
    status(code) {
      sent.status = code
      return this
    },
    json(body) {
      sent.body = body
      return this
    }
  }
  sendAuthError(res, { id: 'req-1' }, 429, 'too-many-attempts', 'Slow down')
  assert.deepEqual(sent, { status: 429, body: { error: 'Slow down', code: 'too-many-attempts', requestId: 'req-1' } })
})

// ---- signed session --------------------------------------------------------------------------------------

function session({ key = Buffer.from('k'.repeat(32)), version = 'v1', ttlSeconds = 100, now = { s: 1000 } } = {}) {
  return { now, ...createSignedSession({ key, version, nowSeconds: () => now.s, ttlSeconds }) }
}

test('a minted token verifies until the second its expiry is reached, and not after', () => {
  const s = session()
  const { token, expires } = s.mint()
  assert.equal(expires, 1100)
  assert.match(token, /^v1\.1100\.[0-9a-f]{64}$/)
  assert.equal(s.verify(token), true)
  s.now.s = 1099
  assert.equal(s.verify(token), true)
  s.now.s = 1100
  assert.equal(s.verify(token), false)
})

test('a token verifies only under the same key and version', () => {
  const a = session()
  const { token } = a.mint()
  assert.equal(session({ key: Buffer.from('z'.repeat(32)) }).verify(token), false, 'another key')
  assert.equal(session({ version: 'v2' }).verify(token), false, 'another version')
})

test('anything that is not exactly version.integer.signature is refused', () => {
  const s = session()
  const [version, expires, signature] = s.mint().token.split('.')
  const flipped = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0')
  for (const bad of [
    `${version}.${expires}.${flipped}`,
    `${version}.${Number(expires) + 1}.${signature}`,
    `${version}.${expires}`,
    `${version}.${expires}.${signature}.extra`,
    `${version}.${expires}.${signature.slice(1)}`,
    `${version}.${expires}.${signature.toUpperCase()}`,
    `${version}. ${expires}.${signature}`,
    `${version}.0${expires}.${signature}`,
    `${version}.1e3.${signature}`,
    `${version}.${expires}.`,
    '',
    '..',
    'garbage'
  ]) {
    assert.equal(s.verify(bad), false, JSON.stringify(bad))
  }
  for (const notAString of [null, undefined, 123, {}, ['v1', 1, 2]]) assert.equal(s.verify(notAString), false)
})

test('a signature of the right length but made of multi-byte characters is refused, not thrown on', () => {
  // A Cookie header is bytes 0x80-0xFF as far as Node is concerned, so a client can send these. 64 of them are
  // 64 characters (the length of a real signature) but 128 bytes, which timingSafeEqual refuses to compare.
  const s = session()
  const [version, expires] = s.mint().token.split('.')
  for (const character of ['\u00e9', '\u00ff', '\u0080']) {
    assert.doesNotThrow(() => s.verify(`${version}.${expires}.${character.repeat(64)}`))
    assert.equal(s.verify(`${version}.${expires}.${character.repeat(64)}`), false)
  }
})

// ---- failure throttle ------------------------------------------------------------------------------------

function throttle({ limit = 3, windowMs = 1000 } = {}) {
  const clock = { ms: 0 }
  return { clock, ...createFailureThrottle({ limit, windowMs, clock: () => clock.ms }) }
}

test('the throttle locks at the limit, counts only failures it was told about, and unlocks as they age out', () => {
  const t = throttle()
  assert.equal(t.isLocked(), false)
  t.record()
  t.clock.ms = 100
  t.record()
  assert.equal(t.isLocked(), false, 'one short of the limit')
  t.clock.ms = 200
  t.record()
  assert.equal(t.isLocked(), true)
  t.clock.ms = 999
  assert.equal(t.isLocked(), true, 'the first failure still counts one millisecond early')
  t.clock.ms = 1000
  assert.equal(t.isLocked(), false, 'and stops counting exactly a window after it happened')
})

test('retryAfterSeconds counts from the oldest failure that still counts, rounds up, never below one', () => {
  const t = throttle({ limit: 2, windowMs: 60_000 })
  t.record()
  t.clock.ms = 10_000
  t.record()
  assert.equal(t.isLocked(), true)
  assert.equal(t.retryAfterSeconds(), 50)
  t.clock.ms = 10_500
  assert.equal(t.retryAfterSeconds(), 50, '49.5 s rounds up')
  t.clock.ms = 59_999
  assert.equal(t.isLocked(), true)
  assert.equal(t.retryAfterSeconds(), 1)
})

test('a throttle with no failures never locks, however long it is asked', () => {
  const t = throttle({ limit: 1 })
  for (let ms = 0; ms < 5000; ms += 500) {
    t.clock.ms = ms
    assert.equal(t.isLocked(), false)
  }
})
