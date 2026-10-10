/**
 * Draws the Home conversation and runs the composer. All behaviour lives in chatController.js; this file only
 * turns its state into DOM and key presses into calls. Text is always set with textContent, never as HTML.
 */

const NEAR_BOTTOM_PX = 96
const NOTICE_MS = 9000

export function createChatView({ chat, doc = document, onVoiceMode = null, autofocus = true } = {}) {
  const $ = (id) => {
    const element = doc.getElementById(id)
    if (!element) throw new Error(`Chat view: missing #${id}`)
    return element
  }
  const body = doc.body
  const main = $('chatMain')
  const thread = $('thread')
  const form = $('composer')
  const input = $('composerInput')
  const sendButton = $('sendButton')
  const stopButton = $('stopButton')
  const voiceButton = $('voiceModeButton')
  const newChatButton = $('newChatButton')
  const notice = $('composerNotice')

  const items = new Map() // message id -> <li>
  let composing = false
  let noticeTimer = null
  let stickToBottom = true

  function nearBottom() {
    return main.scrollHeight - main.scrollTop - main.clientHeight < NEAR_BOTTOM_PX
  }

  function scrollToBottom() {
    main.scrollTop = main.scrollHeight
  }

  function createItem(message) {
    const li = doc.createElement('li')
    li.className = 'msg'
    li.dataset.id = message.id
    li.dataset.role = message.role
    return li
  }

  function ensure(li, className, tag = 'div') {
    let child = li.querySelector(`.${className}`)
    if (!child) {
      child = doc.createElement(tag)
      child.className = className
      li.append(child)
    }
    return child
  }

  function patchItem(li, message) {
    li.dataset.status = message.status
    if (message.role === 'user') {
      ensure(li, 'bubble').textContent = message.text
      return
    }
    if (message.role === 'notice') {
      li.textContent = message.text
      return
    }

    const bodyEl = ensure(li, 'body')
    bodyEl.textContent = message.status === 'thinking' ? 'Thinking…' : message.text

    const meta = li.querySelector('.meta')
    if (message.status === 'stopped') ensure(li, 'meta', 'span').textContent = 'Stopped'
    else meta?.remove()

    const retry = li.querySelector('.retry')
    if (message.status === 'error' && message.retryText) {
      if (!retry) {
        const button = doc.createElement('button')
        button.type = 'button'
        button.className = 'pill retry'
        button.textContent = 'Try again'
        button.addEventListener('click', () => chat.retry(li.dataset.id))
        li.append(button)
      }
    } else {
      retry?.remove()
    }
  }

  function renderThread(state) {
    const wanted = new Set(state.messages.map((message) => message.id))
    for (const [id, li] of items) {
      if (!wanted.has(id)) {
        li.remove()
        items.delete(id)
      }
    }
    let previous = null
    for (const message of state.messages) {
      let li = items.get(message.id)
      if (!li) {
        li = createItem(message)
        items.set(message.id, li)
      }
      patchItem(li, message)
      // A new item is not in the thread yet, so its previousSibling (null) must not be mistaken for "first".
      if (li.parentNode !== thread || li.previousSibling !== previous) {
        thread.insertBefore(li, previous ? previous.nextSibling : thread.firstChild)
      }
      previous = li
    }
  }

  function renderControls(state) {
    stopButton.hidden = !state.busy
    sendButton.hidden = state.busy
    sendButton.disabled = !input.value.trim()
  }

  function render(state) {
    const wasNearBottom = stickToBottom || nearBottom()
    body.dataset.hasMessages = state.messages.length > 0 ? 'true' : 'false'
    renderThread(state)
    renderControls(state)
    if (wasNearBottom) scrollToBottom()
  }

  function autosize() {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`
    sendButton.disabled = !input.value.trim() || chat.getState().busy
  }

  function clearNotice() {
    clearTimeout(noticeTimer)
    notice.hidden = true
    notice.textContent = ''
  }

  function notify(text) {
    clearTimeout(noticeTimer)
    notice.textContent = text
    notice.hidden = !text
    if (text) noticeTimer = setTimeout(clearNotice, NOTICE_MS)
  }

  async function submit() {
    const text = input.value
    if (!text.trim()) return
    clearNotice()
    input.value = ''
    autosize()
    stickToBottom = true
    const result = await chat.send(text)
    stickToBottom = nearBottom()
    // A refusal (busy, voice mode, a meeting) keeps what was typed, so nothing is lost.
    if (!result.ok && ['busy', 'meeting', 'voice'].includes(result.reason) && !input.value) {
      input.value = text
      autosize()
    }
  }

  input.addEventListener('input', () => {
    if (!notice.hidden) clearNotice()
    autosize()
  })
  input.addEventListener('compositionstart', () => (composing = true))
  input.addEventListener('compositionend', () => (composing = false))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape' && chat.getState().busy) {
      event.preventDefault()
      chat.cancel()
    }
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })
  stopButton.addEventListener('click', () => chat.cancel())
  newChatButton.addEventListener('click', async () => {
    clearNotice()
    const started = await chat.newChat()
    if (started) {
      input.value = ''
      autosize()
      input.focus()
    }
  })
  voiceButton.addEventListener('click', () => onVoiceMode?.())
  main.addEventListener('scroll', () => (stickToBottom = nearBottom()), { passive: true })

  const unsubscribe = chat.subscribe(render)
  render(chat.getState())
  autosize()
  if (autofocus && globalThis.matchMedia?.('(pointer: fine)')?.matches) input.focus({ preventScroll: true })

  return {
    notify,
    clearNotice,
    focusInput: () => input.focus({ preventScroll: true }),
    /** Shows or hides the voice button; `title` says why it is unavailable. */
    setVoiceButton({ available, disabled = false, title = 'Start voice mode' }) {
      voiceButton.hidden = !available
      voiceButton.disabled = disabled
      voiceButton.title = title
      voiceButton.setAttribute('aria-label', title)
    },
    destroy() {
      unsubscribe()
      clearNotice()
    }
  }
}
