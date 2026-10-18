/**
 * The chrome around the conversation: the sidebar (recent conversations, and the drawer it becomes on small
 * screens), the online dot in the header, and the model label by the composer. Everything shown comes from the
 * server or the browser; nothing is invented.
 *
 * createRecentConversations is DOM-free (and tested); createSidebar only turns its state into DOM and clicks
 * into calls, the same split as chatController / chatView.
 */

const RECENT_LIMIT = 15

export function createRecentConversations({ api, chat, getActiveId = () => null, limit = RECENT_LIMIT } = {}) {
  let status = 'loading' // loading | ready | empty | off (history is turned off on the server) | locked | error
  let items = []
  const listeners = new Set()

  let shownActiveId = null
  const snapshot = () => Object.freeze({ status, items, activeId: getActiveId() })
  const emit = () => {
    const state = snapshot()
    shownActiveId = state.activeId
    listeners.forEach((listener) => listener(state))
  }

  async function refresh() {
    try {
      const result = await api.list({ limit })
      if (!result?.enabled) {
        status = 'off'
        items = []
      } else {
        items = result.conversations ?? []
        status = items.length ? 'ready' : 'empty'
      }
    } catch (err) {
      // The access-code card is already on screen for a 401; any other failure keeps the list we had.
      status = err?.status === 401 ? 'locked' : 'error'
    }
    emit()
  }

  /** Opens a saved conversation in the chat (the same call the ?conversation= link uses). */
  async function open(id) {
    try {
      await chat.open(await api.get(id))
      emit()
      return { ok: true }
    } catch (err) {
      const reason = err?.status === 401 ? 'locked' : err?.code === 'not-found' ? 'not-found' : 'error'
      if (reason === 'not-found') await refresh()
      return { ok: false, reason }
    }
  }

  // A turn that just finished is saved by the server: it appears here (or moves to the top).
  let wasBusy = false
  const unsubscribe = chat?.subscribe?.((state) => {
    if (wasBusy && !state.busy && state.messages.length > 0) refresh()
    else if (getActiveId() !== shownActiveId) emit() // another conversation was opened, or a new chat began
    wasBusy = state.busy
  })

  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    open,
    destroy() {
      unsubscribe?.()
      listeners.clear()
    }
  }
}

const STATUS_TEXT = {
  loading: 'Loading…',
  empty: 'Nothing saved yet. Conversations appear here once you have chatted.',
  error: 'Could not load your conversations.'
}

export function createSidebar({ recent, doc = document, onProblem = () => {} } = {}) {
  const $ = (id) => {
    const element = doc.getElementById(id)
    if (!element) throw new Error(`Sidebar: missing #${id}`)
    return element
  }
  const body = doc.body
  const section = $('recent')
  const list = $('recentList')
  const statusEl = $('recentStatus')
  const historyLink = $('historyLink')
  const toggle = $('sidebarToggle')
  const closeButton = $('sidebarClose')
  const scrim = $('sidebarScrim')
  const newChatButton = $('newChatButton')

  function render({ status, items, activeId }) {
    section.hidden = status === 'off' || status === 'locked'
    historyLink.hidden = !(status === 'ready' || status === 'empty')
    statusEl.textContent = STATUS_TEXT[status] ?? ''
    list.replaceChildren(
      ...items.map((conversation) => {
        const li = doc.createElement('li')
        const button = doc.createElement('button')
        button.type = 'button'
        button.className = 'recent-item'
        button.dataset.id = conversation.id
        button.textContent = conversation.title || 'Untitled conversation'
        button.title = button.textContent
        if (conversation.id === activeId) button.setAttribute('aria-current', 'true')
        li.append(button)
        return li
      })
    )
  }

  const isOpen = () => body.dataset.sidebar === 'open'

  function setOpen(open, { restoreFocus = true } = {}) {
    body.dataset.sidebar = open ? 'open' : 'closed'
    toggle.setAttribute('aria-expanded', String(open))
    if (open) newChatButton.focus({ preventScroll: true })
    else if (restoreFocus && doc.activeElement && $('sidebar').contains(doc.activeElement)) toggle.focus({ preventScroll: true })
  }

  list.addEventListener('click', async (event) => {
    const button = event.target.closest?.('.recent-item')
    if (!button) return
    const result = await recent.open(button.dataset.id)
    if (result.ok) setOpen(false, { restoreFocus: false })
    else if (result.reason === 'not-found') onProblem('That conversation no longer exists.')
    else if (result.reason === 'error') onProblem('That conversation could not be opened. Check the connection and try again.')
  })
  toggle.addEventListener('click', () => setOpen(!isOpen()))
  closeButton.addEventListener('click', () => setOpen(false))
  scrim.addEventListener('click', () => setOpen(false))
  newChatButton.addEventListener('click', () => setOpen(false, { restoreFocus: false }))
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) setOpen(false)
  })

  body.dataset.sidebar = 'closed'
  const unsubscribe = recent.subscribe(render)
  render(recent.getState())
  recent.refresh()

  return { destroy: unsubscribe }
}

/** The dot beside the breadcrumb follows the browser's own idea of being online. */
export function watchOnline({ dot, win = globalThis }) {
  const update = () => {
    const online = win.navigator?.onLine !== false
    dot.dataset.online = String(online)
    dot.setAttribute('aria-label', online ? 'Online' : 'Offline')
  }
  win.addEventListener?.('online', update)
  win.addEventListener?.('offline', update)
  update()
}

/** The model the server says it is using, or null (not configured, unreachable, or an answer we do not know). */
export async function loadModelLabel({ fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  try {
    const res = await fetchFn('/api/v1/health', { method: 'GET' })
    if (!res.ok) return null
    const health = await res.json()
    const model = typeof health?.aiModel === 'string' ? health.aiModel.trim() : ''
    return health?.aiConfigured === true && model ? model : null
  } catch {
    return null
  }
}
