import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * NUMZ AI's side of the NUMZLAB sign-in broker (numzlab-auth, /auth/broker/*). NUMZLAB proves who a person is with Google and says whether
 * they are approved; this module turns that into a statement NUMZ AI can trust, WITHOUT sharing any cookie or session with NUMZLAB:
 *
 *   1. the person is sent to NUMZLAB (authorizeUrl) with a one-time state and a PKCE challenge;
 *   2. they come back with a short-lived single-use code, which only THIS server (it knows the client secret) can exchange (exchange);
 *   3. the answer is a statement signed with the client secret: the issuer, audience, expiry, one-time id, status and role are all checked;
 *   4. later, lookupUser() asks NUMZLAB whether that person is still approved, which is how suspension and removal are noticed.
 *
 * A broker that cannot be reached is reported as unavailable, never as "approved".
 */

const b64u = (buffer) => Buffer.from(buffer).toString('base64url')
const SUB = /^[0-9a-f]{12}$/

export class BrokerUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrokerUnavailable'
  }
}

export class BrokerRefused extends Error {
  constructor(message, { code = 'refused' } = {}) {
    super(message)
    this.name = 'BrokerRefused'
    this.code = code
  }
}

export function pkcePair() {
  const verifier = b64u(randomBytes(32))
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }
}

const equal = (a, b) => {
  const x = createHash('sha256').update(String(a)).digest()
  const y = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(x, y)
}

export function createBrokerClient({
  brokerUrl, // the back channel: http://host.docker.internal:18792
  authorizeBase, // where the person is sent: https://lab.numz.site
  clientId,
  clientSecret,
  redirectUri, // exactly as registered with NUMZLAB
  fetchFn = (...args) => globalThis.fetch(...args),
  clock = Date.now,
  timeoutMs = 5000
}) {
  if (!brokerUrl || !authorizeBase || !clientId || !redirectUri || typeof clientSecret !== 'string' || clientSecret.length < 32) {
    throw new Error('The sign-in broker needs its address, client id, a client secret of at least 32 characters and the redirect address')
  }
  const back = brokerUrl.replace(/\/+$/, '')
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  const stateKey = createHmac('sha256', clientSecret).update('numz-ai-oauth-state-v1').digest()
  const seen = new Map() // jti -> expiry (seconds): a statement is accepted once

  const mac = (body) => createHmac('sha256', stateKey).update(body).digest('hex')

  /** The short-lived record of one sign-in attempt, kept in a cookie: sealed so it can be neither read into anything useful nor changed. */
  function sealState(payload) {
    const body = b64u(JSON.stringify(payload))
    return `${body}.${mac(body)}`
  }

  function openState(value) {
    if (typeof value !== 'string') return null
    const parts = value.split('.')
    if (parts.length !== 2 || !/^[0-9a-f]{64}$/.test(parts[1]) || !equal(mac(parts[0]), parts[1])) return null
    try {
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
      return payload && typeof payload.exp === 'number' && payload.exp * 1000 > clock() ? payload : null
    } catch {
      return null
    }
  }

  async function call(path, init = {}) {
    let res
    try {
      res = await fetchFn(`${back}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    } catch {
      throw new BrokerUnavailable('The sign-in service could not be reached')
    }
    let body = null
    try {
      body = JSON.parse(await res.text())
    } catch {
      /* an answer that is not JSON is handled by status below */
    }
    return { status: res.status, body }
  }

  function verifyAssertion(assertion) {
    const parts = typeof assertion === 'string' ? assertion.split('.') : []
    if (parts.length !== 2) throw new BrokerRefused('not a statement', { code: 'malformed' })
    const expected = b64u(createHmac('sha256', clientSecret).update(parts[0]).digest())
    if (!equal(parts[1], expected)) throw new BrokerRefused('bad signature', { code: 'signature' })
    let claims
    try {
      claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    } catch {
      throw new BrokerRefused('unreadable', { code: 'malformed' })
    }
    const now = Math.floor(clock() / 1000)
    if (claims.iss !== 'numzlab-auth') throw new BrokerRefused('wrong issuer', { code: 'issuer' })
    if (claims.aud !== clientId) throw new BrokerRefused('wrong audience', { code: 'audience' })
    if (!Number.isFinite(claims.exp) || claims.exp <= now) throw new BrokerRefused('expired', { code: 'expired' })
    if (!Number.isFinite(claims.iat) || claims.iat > now + 60) throw new BrokerRefused('issued in the future', { code: 'clock' })
    if (typeof claims.sub !== 'string' || !SUB.test(claims.sub)) throw new BrokerRefused('no stable user id', { code: 'subject' })
    if (claims.status !== 'active') throw new BrokerRefused('not active', { code: 'status' })
    if (!Array.isArray(claims.permissions) || !claims.permissions.includes('ai.use')) throw new BrokerRefused('not allowed to use NUMZ AI', { code: 'permission' })
    if (typeof claims.email !== 'string' || !claims.email || typeof claims.role !== 'string') throw new BrokerRefused('incomplete', { code: 'malformed' })
    if (typeof claims.jti !== 'string' || !claims.jti) throw new BrokerRefused('no id', { code: 'malformed' })
    for (const [id, until] of seen) if (until <= now) seen.delete(id)
    if (seen.has(claims.jti)) throw new BrokerRefused('already used', { code: 'replay' })
    seen.set(claims.jti, claims.exp)
    return claims
  }

  return {
    clientId,
    redirectUri,
    sealState,
    openState,
    verifyAssertion,

    authorizeUrl({ state, challenge }) {
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
      return `${authorizeBase.replace(/\/+$/, '')}/auth/broker/authorize?${query}`
    },

    /** Swap the code for the signed statement and check it. Throws BrokerRefused (the code or statement is no good) or BrokerUnavailable. */
    async exchange({ code, verifier }) {
      const { status, body } = await call('/auth/broker/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier })
      })
      if (status === 400) throw new BrokerRefused('the code was refused', { code: 'grant' })
      if (status === 401 || status === 403 || status === 404) throw new BrokerUnavailable(`the sign-in service refused this server (${status}): check the client secret`)
      if (status !== 200 || typeof body?.assertion !== 'string') throw new BrokerUnavailable(`the sign-in service answered ${status}`)
      return verifyAssertion(body.assertion)
    },

    /** Is this person still approved, and as what? -> { status, role, permissions } ; status 'removed' when NUMZLAB does not know them. */
    async lookupUser(sub) {
      if (typeof sub !== 'string' || !SUB.test(sub)) return { status: 'removed', role: null, permissions: [] }
      const { status, body } = await call(`/auth/broker/user/${sub}`, { method: 'GET', headers: { Authorization: basic } })
      if (status === 404) return { status: 'removed', role: null, permissions: [] }
      if (status !== 200 || typeof body?.status !== 'string') throw new BrokerUnavailable(`the sign-in service answered ${status}`)
      return { status: body.status, role: body.role ?? null, permissions: Array.isArray(body.permissions) ? body.permissions : [] }
    }
  }
}
