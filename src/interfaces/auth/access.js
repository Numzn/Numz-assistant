/**
 * Access to the assistant, client side: the API for the access-code login (the routes in
 * server/auth/assistantAuth.js), a watcher that notices when the server refuses an assistant request, and a
 * DOM-free controller for the unlock card. The browser never stores the code: it is sent once, and the server
 * answers with an HttpOnly session cookie that JavaScript cannot read.
 */

const BASE = '/api/v1/assistant/auth'

export class AccessError extends Error {
  constructor(message, { status = 0, code = 'network' } = {}) {
    super(message)
    this.name = 'AccessError'
    this.status = status
    this.code = code
  }
}

export function createAccessApi({ fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  async function request(path, init) {
    let res
    try {
      res = await fetchFn(`${BASE}${path}`, { credentials: 'same-origin', ...init })
    } catch (err) {
      throw new AccessError(err?.message || 'Network error', { status: 0, code: 'network' })
    }
    if (res.status === 204) return null
    const text = await res.text()
    let body = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = {}
    }
    if (!res.ok) throw new AccessError(body.error || `Request failed (${res.status})`, { status: res.status, code: body.code || 'request-error' })
    return body
  }

  return {
    /** -> { required, misconfigured, authenticated } */
    status: () => request('/status', { method: 'GET' }),
    login: (code) =>
      request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }),
    async logout() {
      await request('/logout', { method: 'POST' })
      return true
    }
  }
}

/** True for a refusal of an assistant request (not of the login itself, and not of any other API). */
export function isAssistantRefusal(url, status) {
  if (status !== 401) return false
  let pathname = ''
  try {
    pathname = new URL(String(url), 'http://placeholder.invalid').pathname
  } catch {
    return false
  }
  return pathname.startsWith('/api/v1/assistant') && !pathname.startsWith(`${BASE}`)
}

/**
 * Wraps target.fetch so `onRefused` is called whenever the server answers 401 to an assistant request (the login
 * has expired, or was never done). The response is passed through untouched. Returns a function that undoes it.
 */
export function watchForUnauthorized(target, onRefused) {
  const raw = target.fetch
  const original = raw.bind(target)
  target.fetch = async (input, init) => {
    const response = await original(input, init)
    try {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (isAssistantRefusal(url, response.status)) onRefused()
    } catch {
      /* watching must never break a request */
    }
    return response
  }
  return () => {
    target.fetch = raw
  }
}

export function describeLoginError(err) {
  if (err?.status === 401) return 'That is not the access code. Try again.'
  if (err?.status === 429) return 'Too many wrong codes. Wait a minute and try again.'
  if (err?.status === 503) return 'The access code is not set up correctly on the server. Ask whoever runs it to fix it.'
  return 'Could not reach the server. Check the connection and try again.'
}

/**
 * Phases: 'unknown' | 'open' (no code needed, or already unlocked) | 'needed' | 'misconfigured' | 'unlocking'.
 * `error` is the message under the code box. A refusal seen mid-session calls require().
 */
export function createAccessController({ api, onUnlocked = () => {} } = {}) {
  let state = { phase: 'unknown', error: '', canLock: false }
  const listeners = new Set()
  const set = (patch) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Asks the server whether a code is needed. Never throws: if it cannot be reached the app is left alone. */
    async start() {
      try {
        const status = await api.status()
        if (status.misconfigured) set({ phase: 'misconfigured', error: describeLoginError({ status: 503 }), canLock: false })
        else if (status.required && !status.authenticated) set({ phase: 'needed', error: '', canLock: false })
        else set({ phase: 'open', canLock: Boolean(status.required && status.authenticated) })
      } catch {
        set({ phase: 'open', canLock: false })
      }
    },

    /** A request was refused: ask for the code (once; repeated refusals do not reset what the user is doing). */
    require() {
      if (state.phase === 'needed' || state.phase === 'unlocking' || state.phase === 'misconfigured') return
      set({ phase: 'needed', error: '', canLock: false })
    },

    async submit(code) {
      const typed = String(code ?? '').trim()
      if (state.phase === 'unlocking' || state.phase === 'misconfigured') return false
      if (!typed) {
        set({ phase: 'needed', error: 'Type the access code.' })
        return false
      }
      set({ phase: 'unlocking', error: '' })
      try {
        await api.login(typed)
      } catch (err) {
        set({ phase: err?.status === 503 ? 'misconfigured' : 'needed', error: describeLoginError(err) })
        return false
      }
      set({ phase: 'open', error: '', canLock: true })
      onUnlocked()
      return true
    },

    async lock() {
      try {
        await api.logout()
      } finally {
        onUnlocked() // the page reloads, which asks for the code again
      }
    }
  }
}
