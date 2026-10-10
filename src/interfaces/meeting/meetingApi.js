/**
 * The browser's view of the meeting API. It can start a meeting, finish its own, and ask about its launch session:
 *   launch  - start a NEW meeting, with the launch code (X-Meeting-Launch-Code) typed by a person, OR with the
 *             launch session cookie the server set after such a code was accepted. The cookie is HttpOnly: this
 *             code never reads it, it only goes with the request.
 *   end     - finish ITS OWN meeting, with the meeting ticket it was handed (Bearer)
 * It never has, and the server never accepts from it, the admin token.
 */

const MEETINGS = '/api/v1/meetings'
const HEALTH = '/api/v1/health'

export class MeetingApiError extends Error {
  constructor(message, { status = 0, code = 'network', details = null } = {}) {
    super(message)
    this.name = 'MeetingApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

async function readJson(res) {
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export function createMeetingApi({ fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  async function request(url, init) {
    let res
    try {
      res = await fetchFn(url, init)
    } catch (err) {
      throw new MeetingApiError(err?.message || 'Network error', { status: 0, code: 'network' })
    }
    const body = await readJson(res)
    if (!res.ok) {
      throw new MeetingApiError(body.error || `Request failed (${res.status})`, {
        status: res.status,
        code: typeof body.code === 'string' ? body.code : 'request-error',
        details: body.details ?? null
      })
    }
    return body
  }

  return {
    /** Whether this server can start meetings from the browser (a launch code is configured). Never throws. */
    async launchAvailable() {
      try {
        const health = await request(HEALTH, { method: 'GET' })
        return health?.meetings?.launch?.enabled === true
      } catch {
        return false
      }
    },

    /**
     * Whether this browser may start a meeting without typing the code (the server set its launch session cookie
     * after a correct code). The server decides; the cookie is invisible to scripts. Never throws.
     * -> { available, authenticated }
     */
    async launchSession() {
      try {
        const body = await request(`${MEETINGS}/launch/session`, { method: 'GET', credentials: 'same-origin' })
        return { available: body?.available === true, authenticated: body?.authenticated === true }
      } catch {
        return { available: false, authenticated: false }
      }
    },

    /** Drop this browser's launch session. -> whether the server confirmed it. Never throws. */
    async forgetLaunchSession() {
      try {
        await request(`${MEETINGS}/launch/session`, { method: 'DELETE', credentials: 'same-origin' })
        return true
      } catch {
        return false
      }
    },

    /**
     * code: the launch code, or empty to rely on the launch session cookie.
     * idempotencyKey: the same key on a repeated attempt returns the SAME meeting instead of a second one.
     * -> { meetingId, status, ticket: { token, expiresAt }, reused?, ... }
     */
    launch({ code = '', title, idempotencyKey = '' }) {
      const headers = { 'Content-Type': 'application/json' }
      if (code) headers['X-Meeting-Launch-Code'] = code
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
      return request(`${MEETINGS}/launch`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify(title ? { title } : {})
      })
    },

    /**
     * The live state of THIS meeting's intelligence (the meeting's own ticket is the credential). With `since`, a
     * revision the caller already has, an unchanged answer is `{ unchanged: true, revision }` and nothing else.
     */
    intelligence({ meetingId, ticketToken, since = null }) {
      const query = Number.isInteger(since) ? `?since=${since}` : ''
      return request(`${MEETINGS}/${encodeURIComponent(meetingId)}/intelligence/live${query}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${ticketToken}` }
      })
    },

    /** Update now (waits a bounded time); for a closed meeting, (re)attempts the final record. */
    refreshIntelligence({ meetingId, ticketToken, final = false }) {
      return request(`${MEETINGS}/${encodeURIComponent(meetingId)}/intelligence/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticketToken}` },
        body: JSON.stringify(final ? { final: true } : {})
      })
    },

    /** -> the completed meeting with its integrity report; 409 while lines are missing or a recording is open. */
    end({ meetingId, ticketToken }) {
      return request(`${MEETINGS}/${encodeURIComponent(meetingId)}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticketToken}` },
        body: '{}'
      })
    }
  }
}
