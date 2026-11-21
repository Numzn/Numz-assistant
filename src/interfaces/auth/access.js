import { withBase } from '../../core/apiPaths.js'

/**
 * Access to the assistant, client side. Two ways in, and the server says which one it uses:
 *
 *   mode 'broker'  each person signs in with their own Google account (through NUMZLAB): the page offers "Continue with Google", which
 *                  is an ordinary link to the server's sign-in route. The page never sees a password, a code or a token; the session
 *                  is an HttpOnly cookie it cannot read. It does receive a per-session CSRF token, which it attaches to every
 *                  state-changing request to its own API (installCsrfHeader).
 *   mode 'code'    the one shared access code (the fallback), typed once and exchanged for a cookie.
 *
 * This file holds the API calls, a watcher that notices when the server refuses an assistant request, the CSRF header, and a DOM-free
 * controller for the sign-in card. The card itself is in accessGateView.js.
 */

const AUTH = withBase('/api/v1/assistant/auth')
const API = withBase('/api/')

export class AccessError extends Error {
  constructor(message, { status = 0, code = 'network' } = {}) {
    super(message)
    this.name = 'AccessError'
    this.status = status
    this.code = code
  }
}

export function createAccessApi({ fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  let csrf = ''

  async function request(path, init) {
    let res
    try {
      res = await fetchFn(`${AUTH}${path}`, { credentials: 'same-origin', ...init })
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
    if (path === '/status') csrf = typeof body.csrf === 'string' ? body.csrf : ''
    return body
  }

  return {
    /** -> { mode, required, authenticated, misconfigured, user?, csrf?, reason?, loginUrl? } */
    status: () => request('/status', { method: 'GET' }),
    login: (code) =>
      request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }),
    async logout() {
      await request('/logout', { method: 'POST', ...(csrf ? { headers: { 'X-CSRF-Token': csrf } } : {}) })
      return true
    },
    /** The per-session CSRF token (broker mode), or ''. */
    csrfToken: () => csrf
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
  return pathname.startsWith(withBase('/api/v1/assistant')) && !pathname.startsWith(AUTH)
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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** True for the app's own API (same origin, under the base path): the only place the CSRF token is ever sent. */
function isOwnApi(url) {
  try {
    const here = new URL(globalThis.location?.href ?? 'http://placeholder.invalid/')
    const target = new URL(String(url), here)
    return target.origin === here.origin && target.pathname.startsWith(API)
  } catch {
    return false
  }
}

/**
 * Adds the session's CSRF token (`getToken()`, from the status answer) to every state-changing request to the app's OWN API, and to
 * nothing else: not to another origin, not to a read. The server refuses a change without it. Returns a function that undoes it.
 */
export function installCsrfHeader(target, getToken, whenReady = null) {
  const raw = target.fetch
  const original = raw.bind(target)
  target.fetch = async (input, init) => {
    try {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      const method = String(init?.method ?? (input && typeof input === 'object' ? input.method : undefined) ?? 'GET').toUpperCase()
      if (!SAFE_METHODS.has(method) && isOwnApi(url)) {
        // A change asked for before the page has learned its token waits for it (briefly) instead of being refused.
        if (!getToken() && whenReady) await Promise.race([Promise.resolve(whenReady()).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4000))])
        const token = getToken()
        if (token) {
          const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input?.headers : undefined))
          headers.set('x-csrf-token', token)
          return original(input, { ...init, headers })
        }
      }
    } catch {
      /* never break a request over a header */
    }
    return original(input, init)
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

const NOTICES = {
  denied: 'That Google account is not approved for NUMZ AI. Ask the administrator, or try a different account.',
  failed: 'Signing in did not finish. Please try again.',
  unavailable: 'NUMZ AI could not reach the sign-in service. Try again in a moment.',
  'session-expired': 'Your session ended. Sign in again to carry on.',
  'access-revoked': 'Your access to NUMZ AI has ended. Ask the administrator if that is a mistake.',
  'identity-unavailable': 'NUMZ AI cannot confirm your access right now. Try again shortly.'
}

/** The words for why a person is being asked to sign in: from the return address (?auth=…) or the server's reason. */
export function describeNotice(code) {
  return NOTICES[code] ?? ''
}

function authParam(search) {
  try {
    return new URLSearchParams(search).get('auth') ?? ''
  } catch {
    return ''
  }
}

/** Takes ?auth=… out of the address bar once it has been read, so a reload does not repeat the message. */
function forgetAuthParam() {
  try {
    const url = new URL(globalThis.location.href)
    if (!url.searchParams.has('auth')) return
    url.searchParams.delete('auth')
    globalThis.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    /* no address bar to tidy */
  }
}

/**
 * Phases: 'unknown' | 'open' (signed in, or no code needed) | 'needed' | 'misconfigured' | 'unlocking'.
 * `mode` is 'broker' | 'code' once the server has said. `notice` is why a sign-in is being asked for (broker mode), `error` is the message
 * under the code box (code mode). A refusal seen mid-session calls require().
 */
export function createAccessController({ api, onUnlocked = () => {}, search = () => globalThis.location?.search ?? '', tidy = forgetAuthParam } = {}) {
  let state = { phase: 'unknown', error: '', canLock: false, mode: 'code', user: null, notice: '', loginUrl: '' }
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

    /** Asks the server whether sign-in is needed. Never throws: if it cannot be reached the app is left alone. */
    async start() {
      try {
        const status = await api.status()
        if (status.mode === 'broker') {
          const fromAddress = authParam(search())
          tidy()
          if (status.authenticated) {
            set({ phase: 'open', mode: 'broker', user: status.user ?? null, canLock: true, notice: '', loginUrl: status.loginUrl ?? '' })
          } else {
            set({ phase: 'needed', mode: 'broker', user: null, canLock: false, notice: describeNotice(fromAddress) || describeNotice(status.reason), loginUrl: status.loginUrl ?? '' })
          }
          return
        }
        if (status.misconfigured) set({ phase: 'misconfigured', mode: 'code', error: describeLoginError({ status: 503 }), canLock: false })
        else if (status.required && !status.authenticated) set({ phase: 'needed', mode: 'code', error: '', canLock: false })
        else set({ phase: 'open', mode: 'code', canLock: Boolean(status.required && status.authenticated) })
      } catch {
        set({ phase: 'open', canLock: false })
      }
    },

    /** A request was refused: ask for sign-in (once; repeated refusals do not reset what the user is doing). */
    require() {
      if (state.phase === 'needed' || state.phase === 'unlocking' || state.phase === 'misconfigured') return
      set({ phase: 'needed', error: '', canLock: false, user: null })
      if (state.mode === 'broker') {
        // Learn WHY (session ended, access removed) so the card can say so.
        api
          .status()
          .then((status) => {
            if (!status.authenticated && state.phase === 'needed') set({ notice: describeNotice(status.reason), loginUrl: status.loginUrl ?? state.loginUrl })
          })
          .catch(() => {})
      }
    },

    async submit(code) {
      const typed = String(code ?? '').trim()
      if (state.mode === 'broker' || state.phase === 'unlocking' || state.phase === 'misconfigured') return false
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

    /** Signs this device out (broker mode: only this session; the shared code mode: the cookie). */
    async lock() {
      try {
        await api.logout()
      } finally {
        onUnlocked() // the page reloads, which asks for sign-in again
      }
    }
  }
}
