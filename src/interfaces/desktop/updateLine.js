/**
 * The update line: in the NUMZ AI desktop app, a thin line at the top of the window that says a newer version is ready, and installs it when
 * the person says so. In a browser there is no desktop app, so there is no line and nothing here does anything.
 *
 * The app (Rust, `update.rs`) answers two questions for this page: is a newer version published (`app_update_check`), and install it
 * (`app_update_install`: downloaded, its signature checked against the app's own public key, installed, the new version started). The page
 * only decides when to ask and what to show:
 *
 *   idle ── newer version found ──▶ available ── "Update now" ──▶ installing ──▶ (the app closes and the new version opens)
 *     ▲                               │  └─ "Not now" ──▶ idle (this version is not offered again until the next start)   └─ failed ─ "Try again"
 *
 * Looking is quiet: no network, no reply or a refusal is not shown (a person who is offline has no update line). Only an install that was
 * asked for and failed says so. The first look is a little after the page opens, so that it never competes with what the person came to do.
 */

const FIRST_LOOK_MS = 15_000
const LOOK_EVERY_MS = 6 * 60 * 60_000
const DISMISSED = 'numz.update.dismissed'

function defaultInvoke() {
  const internals = globalThis.__TAURI_INTERNALS__
  return typeof internals?.invoke === 'function' ? (command, args) => internals.invoke(command, args) : null
}

function storageOf(storage) {
  try {
    return storage ?? globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/** What the person is told when installing failed (the app sends a code and a sentence; anything else gets a plain one). */
export function installFailure(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string' && typeof err.code === 'string') return err.message
  return 'The update could not be installed. Try again.'
}

export function createUpdateController({ invoke = defaultInvoke(), storage = null, setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = (id) => globalThis.clearTimeout(id), firstLookMs = FIRST_LOOK_MS, lookEveryMs = LOOK_EVERY_MS } = {}) {
  const available = typeof invoke === 'function'
  const listeners = new Set()
  let state = { phase: 'idle', current: '', version: '', notes: '', message: '' }
  let timer = null
  let started = false
  const memory = () => storageOf(storage)

  function set(patch) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }
  const dismissedVersion = () => {
    try {
      return memory()?.getItem(DISMISSED) ?? ''
    } catch {
      return ''
    }
  }

  /** Is a newer version published? Never throws and never shows anything when it cannot find out. */
  async function check() {
    if (!available || state.phase === 'installing') return state
    let found
    try {
      found = await invoke('app_update_check')
    } catch {
      return state
    }
    if (!found || typeof found.current !== 'string') return state
    if (!found.available || typeof found.version !== 'string' || !found.version) {
      if (state.phase === 'available') set({ phase: 'idle' })
      set({ current: found.current })
      return state
    }
    if (found.version === dismissedVersion()) return set({ current: found.current }), state
    set({ phase: 'available', current: found.current, version: found.version, notes: typeof found.notes === 'string' ? found.notes : '', message: '' })
    return state
  }

  /** The person pressed "Update now". On success the app closes and the new version opens, so nothing after this call is seen. */
  async function install() {
    if (!available || state.phase === 'installing' || !state.version) return state
    set({ phase: 'installing', message: '' })
    try {
      await invoke('app_update_install')
    } catch (err) {
      set({ phase: 'failed', message: installFailure(err) })
    }
    return state
  }

  /** "Not now": this version is not offered again until the app is started again. */
  function dismiss() {
    try {
      memory()?.setItem(DISMISSED, state.version)
    } catch {
      /* a convenience only */
    }
    set({ phase: 'idle', message: '' })
    return state
  }

  function schedule(ms) {
    timer = setTimer(async () => {
      await check()
      if (started) schedule(lookEveryMs)
    }, ms)
  }

  return {
    available,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    check,
    install,
    dismiss,
    /** Begin looking (a little after the page opens, then every few hours). Does nothing outside the desktop app. */
    start() {
      if (!available || started) return
      started = true
      schedule(firstLookMs)
    },
    stop() {
      started = false
      if (timer !== null) clearTimer(timer)
      timer = null
      listeners.clear()
    }
  }
}

/** Draws the line into `#updateLine`. Built with createElement and textContent: nothing from the app or the network is parsed as HTML. */
export function createUpdateView({ controller, doc = document } = {}) {
  const line = doc.getElementById('updateLine')
  if (!line || !controller?.available) return null

  const h = (tag, attrs = {}, ...children) => {
    const el = doc.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'text') el.textContent = value
      else if (key === 'class') el.className = value
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value)
      else el.setAttribute(key, String(value))
    }
    el.append(...children.filter(Boolean))
    return el
  }

  function render(state) {
    const show = state.phase !== 'idle'
    line.hidden = !show
    doc.body.dataset.update = show ? 'true' : 'false'
    if (!show) return line.replaceChildren()
    const text =
      state.phase === 'installing'
        ? 'Updating NUMZ AI… it will close and open again in a moment.'
        : state.phase === 'failed'
          ? state.message
          : `A new version of NUMZ AI is ready (${state.version}${state.current ? `, you have ${state.current}` : ''}).`
    const buttons =
      state.phase === 'installing'
        ? []
        : [h('button', { type: 'button', class: 'update-now', text: state.phase === 'failed' ? 'Try again' : 'Update now', onclick: () => controller.install() }), h('button', { type: 'button', class: 'update-later', text: 'Not now', onclick: () => controller.dismiss() })]
    line.replaceChildren(h('span', { class: 'update-text', text }), ...buttons)
  }

  controller.subscribe(render)
  render(controller.getState())
  return { render: () => render(controller.getState()) }
}
