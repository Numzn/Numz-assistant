/**
 * The browser's view of the meeting API. It can do exactly two things, and holds only two credentials:
 *   launch  - start a NEW meeting, with the launch code (X-Meeting-Launch-Code)
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

    /** -> { meetingId, status, ticket: { token, expiresAt }, ... } */
    launch({ code, title }) {
      return request(`${MEETINGS}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Meeting-Launch-Code': code },
        body: JSON.stringify(title ? { title } : {})
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
