import { ACCEPT, checkRoom, formatSize, readTextFile } from './attachments.js'
import { renderMarkdown } from './markdownView.js'

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
  const attachButton = $('attachButton')
  const attachInput = $('attachInput')
  const chipsEl = $('composerChips')
  attachInput.accept = ACCEPT

  const items = new Map() // message id -> <li>
  const rendered = new WeakMap() // reply body -> the text last drawn into it
  let composing = false
  let noticeTimer = null
  let stickToBottom = true
  let files = [] // attached, read and checked: { name, size, text }

  function chip(file, removable) {
    const element = doc.createElement('span')
    element.className = 'chip'
    const name = doc.createElement('span')
    name.className = 'name'
    name.textContent = file.name
    const size = doc.createElement('span')
    size.className = 'size'
    size.textContent = formatSize(file.size)
    element.append(name, size)
    if (removable) {
      const remove = doc.createElement('button')
      remove.type = 'button'
      remove.className = 'remove'
      remove.textContent = '×'
      remove.setAttribute('aria-label', `Remove ${file.name}`)
      remove.addEventListener('click', () => {
        files = files.filter((candidate) => candidate !== file)
        renderChips()
        input.focus({ preventScroll: true })
      })
      element.append(remove)
    }
    return element
  }

  function renderChips() {
    chipsEl.replaceChildren(...files.map((file) => chip(file, true)))
    chipsEl.hidden = files.length === 0
    autosize()
  }

  async function addFiles(list) {
    clearNotice()
    const problems = []
    for (const candidate of Array.from(list ?? [])) {
      try {
        const read = await readTextFile(candidate)
        checkRoom(files, read)
        files = [...files, read]
      } catch (err) {
        problems.push(err?.message || `${candidate?.name ?? 'That file'} could not be attached.`)
      }
    }
    renderChips()
    if (problems.length) notify(problems.join(' '))
  }

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
      const bubble = ensure(li, 'bubble')
      bubble.textContent = message.text
      bubble.hidden = !message.text
      const attached = message.attachments ?? []
      const list = li.querySelector('.files')
      if (attached.length) ensure(li, 'files').replaceChildren(...attached.map((file) => chip(file, false)))
      else list?.remove()
      return
    }
    if (message.role === 'notice') {
      li.textContent = message.text
      return
    }

    const bodyEl = ensure(li, 'body')
    if (message.status === 'thinking') {
      bodyEl.textContent = 'Thinking…'
      rendered.delete(bodyEl)
    } else if (message.status === 'error') {
      bodyEl.textContent = message.text
      rendered.delete(bodyEl)
    } else if (rendered.get(bodyEl) !== message.text) {
      // A reply (finished, still arriving, or stopped) is drawn as Markdown, only when its text changed.
      renderMarkdown(bodyEl, message.text, doc)
      rendered.set(bodyEl, message.text)
    }

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
    sendButton.disabled = (!input.value.trim() && files.length === 0) || chat.getState().busy
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
    const attachments = files
    if (!text.trim() && attachments.length === 0) return
    clearNotice()
    input.value = ''
    files = []
    renderChips()
    stickToBottom = true
    const result = await chat.send(text, { attachments })
    stickToBottom = nearBottom()
    // A refusal (busy, voice mode, a meeting) keeps what was typed and attached, so nothing is lost.
    if (!result.ok && ['busy', 'meeting', 'voice'].includes(result.reason) && !input.value && files.length === 0) {
      input.value = text
      files = attachments
      renderChips()
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
  attachButton.addEventListener('click', () => attachInput.click())
  attachInput.addEventListener('change', async () => {
    await addFiles(attachInput.files)
    attachInput.value = '' // the same file can be chosen again after removing it
  })
  form.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    event.preventDefault()
    form.classList.add('dragging')
  })
  form.addEventListener('dragleave', () => form.classList.remove('dragging'))
  form.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return
    event.preventDefault()
    form.classList.remove('dragging')
    addFiles(event.dataTransfer.files)
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
