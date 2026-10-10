/**
 * The conversation on the Home screen: what has been said in this session, and sending a typed message.
 *
 * It owns no voice or network logic. A typed message goes through assistantController.submitText (the same
 * request path as a spoken one), and the thread is drawn from the events that path already emits
 * (turn:start, assistant:token, ai:response, turn:interrupt, error:recoverable). Because a spoken turn emits
 * the same events, voice-mode turns appear in the same thread with no extra wiring.
 *
 * Meeting commands are handled by `commands` (see ../commands/meetingCommands.js) before anything is sent
 * to the assistant; a handled command never reaches the backend.
 */

const OPEN = new Set(['thinking', 'streaming'])
export const ERROR_TEXT = 'Something went wrong, so there is no reply. Try again.'
export const EMPTY_REPLY_TEXT = 'No reply came back. Try again.'

let counter = 0
const defaultId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`

export function createChatController({
  assistantController,
  assistantClient,
  eventBus,
  commands = null,
  // Returns a reason string ('voice', 'meeting', ...) when a message to the assistant must not be sent now.
  isBlocked = () => null,
  // Stops whatever is in flight: the stream, and any speech. Falls back to the assistant controller.
  interrupt = null,
  newId = defaultId
} = {}) {
  let messages = []
  let busy = false
  let lastUserText = ''
  let skipNextUserBubble = false
  const listeners = new Set()

  function snapshot() {
    return Object.freeze({ messages: messages.map((m) => ({ ...m })), busy })
  }

  function emit() {
    const state = snapshot()
    for (const listener of listeners) listener(state)
  }

  function push(message) {
    const entry = { id: newId(), text: '', status: 'done', ...message }
    messages = [...messages, entry]
    return entry
  }

  function openAssistant() {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && OPEN.has(messages[i].status)) return messages[i]
      if (messages[i].role === 'user') return null
    }
    return null
  }

  function update(message, patch) {
    messages = messages.map((m) => (m === message || m.id === message.id ? { ...m, ...patch } : m))
  }

  function endTurn() {
    busy = false
  }

  // ---- events from the shared request path (typed and spoken turns alike) -------------------------------

  const offs = []
  if (eventBus?.on) {
    offs.push(
      eventBus.on('turn:start', (event) => {
        const text = String(event?.payload?.text ?? '')
        busy = true
        lastUserText = text
        if (skipNextUserBubble) skipNextUserBubble = false
        else push({ role: 'user', text })
        push({ role: 'assistant', status: 'thinking' })
        emit()
      }),
      eventBus.on('assistant:token', (event) => {
        const token = event?.payload?.token ?? ''
        const open = openAssistant()
        if (!token || !open) return
        update(open, { status: 'streaming', text: open.text + token })
        emit()
      }),
      eventBus.on('ai:response', (event) => {
        const open = openAssistant()
        const reply = event?.payload?.reply
        if (open) {
          if (typeof reply === 'string' && reply.trim()) update(open, { status: 'done', text: reply })
          else if (open.text.trim()) update(open, { status: 'done' })
          else update(open, { status: 'error', text: EMPTY_REPLY_TEXT, retryText: lastUserText })
        }
        endTurn()
        emit()
      }),
      eventBus.on('turn:interrupt', () => {
        const open = openAssistant()
        if (open) {
          if (open.text.trim()) update(open, { status: 'stopped' })
          else messages = messages.filter((m) => m.id !== open.id)
        }
        endTurn()
        emit()
      }),
      eventBus.on('error:recoverable', () => {
        const open = openAssistant()
        if (open) update(open, { status: 'error', text: ERROR_TEXT, retryText: lastUserText })
        endTurn()
        emit()
      }),
      // A meeting command heard by voice: the orchestrator answers it locally and tells the thread.
      eventBus.on('command:handled', (event) => {
        const { text = '', reply = '' } = event?.payload ?? {}
        push({ role: 'user', text })
        push({ role: 'assistant', text: reply })
        emit()
      })
    )
  }

  // ---- actions -------------------------------------------------------------------------------------------

  async function send(text) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) return { ok: false, reason: 'empty' }
    if (busy) return { ok: false, reason: 'busy' }

    // Meeting commands first: they must work even while a meeting blocks ordinary messages.
    if (commands) {
      let handled = null
      try {
        handled = await commands.handle(trimmed)
      } catch (err) {
        console.error('[chat] command failed', err)
        push({ role: 'user', text: trimmed })
        push({ role: 'assistant', status: 'error', text: 'That command did not work. Try again.' })
        emit()
        return { ok: false, reason: 'command-error' }
      }
      if (handled) {
        push({ role: 'user', text: trimmed })
        push({ role: 'assistant', text: handled.reply, tone: handled.tone })
        emit()
        return { ok: true, handled: true }
      }
    }

    const blocked = isBlocked()
    if (blocked) {
      push({ role: 'notice', text: blockedText(blocked) })
      emit()
      return { ok: false, reason: blocked }
    }

    busy = true
    emit()
    try {
      await assistantController.submitText(trimmed)
    } catch (err) {
      console.error('[chat] send failed', err)
      const open = openAssistant()
      if (open) update(open, { status: 'error', text: ERROR_TEXT, retryText: trimmed })
      else push({ role: 'assistant', status: 'error', text: ERROR_TEXT, retryText: trimmed })
    } finally {
      endTurn()
      emit()
    }
    return { ok: true }
  }

  function blockedText(reason) {
    if (reason === 'meeting') return 'A meeting is recording. Type "stop meeting" to end it, then ask again.'
    if (reason === 'voice') return 'Voice mode is on. End it to type a message.'
    return 'That cannot be sent right now.'
  }

  async function retry(messageId) {
    const failed = messages.find((m) => m.id === messageId)
    if (!failed || failed.status !== 'error' || !failed.retryText || busy) return { ok: false }
    messages = messages.filter((m) => m.id !== messageId)
    skipNextUserBubble = true
    emit()
    const result = await send(failed.retryText)
    skipNextUserBubble = false
    return result
  }

  async function cancel() {
    if (!busy) return false
    try {
      if (typeof interrupt === 'function') await interrupt()
      else await assistantController.interrupt()
    } catch (err) {
      console.warn('[chat] interrupt failed', err)
    }
    return true
  }

  /** A fresh conversation: a new server session (so the assistant forgets this one) and an empty thread. */
  async function newChat() {
    if (busy) await cancel()
    try {
      const session = await assistantClient.createSession({ client: 'browser', transport: 'http' })
      eventBus?.emit?.('session:created', session)
    } catch (err) {
      console.error('[chat] new conversation failed', err)
      push({ role: 'notice', text: 'Could not start a new conversation. Check the connection and try again.' })
      emit()
      return false
    }
    messages = []
    busy = false
    lastUserText = ''
    emit()
    return true
  }

  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send,
    retry,
    cancel,
    newChat,
    destroy() {
      for (const off of offs) off?.()
      listeners.clear()
    }
  }
}
