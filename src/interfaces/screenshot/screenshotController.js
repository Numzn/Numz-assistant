import { CaptureError, describeCaptureError } from './nativeCapture.js'
import { ScreenshotApiError } from './screenshotApi.js'

/**
 * Screenshot Intelligence in the page, with no screen of its own: this decides what happens when a person takes, previews, analyses,
 * cancels, retries and deletes a screenshot. The picture is taken by the desktop app's native layer (nativeCapture.js), analysed by the
 * server in the background (screenshotApi.js), and what the model says becomes part of the CURRENT conversation (`onExchange`).
 *
 *   idle ─ capture ─▶ capturing ─▶ preview ─ analyse ─▶ uploading ─▶ analyzing ─▶ ready
 *    ▲                    │ error        │ discard                       │ cancel        └▶ failed ─ retry ─▶ analyzing
 *    └────────────────────┴──────────────┘                               └▶ cancelled ─ retry ─▶ analyzing
 *   unavailable: not in the desktop app (there is no native capture to ask)
 *
 * What the page keeps: the native layer's capture (held there, freed by `discard`), and - from the moment the picture is exported until the
 * panel is dismissed - the bytes that were sent, so a failed upload or an expired server copy can be retried without capturing again.
 * They live in memory only, and are dropped on dismiss, delete and when the page closes.
 *
 * `getConversationId()` is the conversation open now. A screenshot belongs to the conversation that was open when it was sent; if the
 * person has moved on by the time it is analysed, the result is saved there and the person is told so, not dropped into another thread.
 */

const POLL_MS = 800
const POLL_MAX_MS = 2500
const POLL_FAILURES = 4
const EXPORT_SIZES = [2048, 1400, 900] // the long side tried when a picture is too large for the server

const initial = () => ({
  phase: 'idle', // 'unavailable' | 'idle' | 'capturing' | 'preview' | 'uploading' | 'analyzing' | 'ready' | 'failed' | 'cancelled'
  support: null,
  mode: 'screen',
  windows: [],
  windowsError: '',
  capture: null, // { captureId, width, height, preview }
  selection: null, // { x, y, width, height } in the capture's own pixels, or null for all of it
  question: '',
  shot: null, // the server's record: { id, conversationId, pictureKept, ... }
  analysis: '',
  error: null, // { code, message, retryable }
  message: '',
  tone: 'info',
  asking: false
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createScreenshotController({ native, api, getConversationId = () => null, onExchange = () => {}, onRemoved = () => {}, wait = delay, newId = () => globalThis.crypto.randomUUID() } = {}) {
  let state = initial()
  let held = null // { bytes, mimeType } what was exported and sent
  let runToken = 0 // bumped by anything that supersedes the current run (cancel, dismiss, a new capture): stale answers are ignored
  let uploadAbort = null
  let pendingId = null // the id chosen for the screenshot being sent: lets a lost answer be recovered, or the upload undone
  let pendingConversation = null
  const listeners = new Set()

  function set(patch) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  function describeApi(err) {
    if (err instanceof ScreenshotApiError) {
      if (err.status === 0) return { code: 'network', message: 'The server could not be reached. Check the connection and try again.', retryable: true }
      return { code: err.code, message: err.message, retryable: err.transient }
    }
    return { code: 'failed', message: 'Something went wrong. Try again.', retryable: true }
  }

  async function finishNative() {
    const id = state.capture?.captureId
    if (id) await native.discard(id)
  }

  // ---- support and windows ---------------------------------------------------------------------------------------

  async function init() {
    if (!native.available) {
      set({ phase: 'unavailable', message: describeCaptureError('unavailable'), tone: 'info' })
      return state
    }
    try {
      const support = await native.status()
      set({ support, message: support.note || '', tone: 'info' })
    } catch (err) {
      set({ support: null, message: err instanceof CaptureError ? err.message : describeCaptureError('capture-failed'), tone: 'warn' })
    }
    return state
  }

  async function loadWindows() {
    try {
      const windows = await native.listWindows()
      set({ windows, windowsError: windows.length ? '' : 'No other windows were found to capture.' })
    } catch (err) {
      set({ windows: [], windowsError: err instanceof CaptureError ? err.message : describeCaptureError('capture-failed') })
    }
  }

  // ---- capture and preview ---------------------------------------------------------------------------------------

  const busyPhases = new Set(['capturing', 'uploading', 'analyzing'])

  /** mode: 'screen' (the whole display), 'region' (the whole display, then a crop on the preview) or 'window'. */
  async function capture({ mode = 'screen', windowId = null } = {}) {
    if (!native.available) return set({ phase: 'unavailable', message: describeCaptureError('unavailable') })
    if (busyPhases.has(state.phase)) {
      return set({ message: state.phase === 'capturing' ? 'A capture is already in progress.' : 'Your last screenshot is still being analysed. Wait for it, or cancel it.', tone: 'warn' })
    }
    const token = ++runToken
    const previous = state.capture?.captureId // a preview that was never analysed is thrown away
    held = null
    set({ ...initial(), support: state.support, windows: state.windows, mode, phase: 'capturing', message: 'Capturing…' })
    if (previous) await native.discard(previous)
    if (token !== runToken) return state // cancelled while the old preview was being let go
    let taken
    try {
      taken = await native.capture({ mode: mode === 'window' ? 'window' : 'screen', windowId })
    } catch (err) {
      if (token !== runToken) return state
      const code = err instanceof CaptureError ? err.code : 'capture-failed'
      set({ ...initial(), support: state.support, windows: state.windows, mode, phase: 'idle', message: code === 'cancelled' ? '' : err instanceof CaptureError ? err.message : describeCaptureError('capture-failed'), tone: code === 'cancelled' ? 'info' : 'error' })
      return state
    }
    if (token !== runToken) {
      await native.discard(taken.captureId) // superseded while the picture was being taken
      return state
    }
    set({ phase: 'preview', capture: taken, selection: null, message: mode === 'region' ? 'Drag on the picture to choose the area, or use all of it.' : '', tone: 'info' })
    return state
  }

  function setSelection(rect) {
    if (state.phase !== 'preview' || !state.capture) return
    if (!rect) return set({ selection: null })
    const { width: W, height: H } = state.capture
    const x = Math.max(0, Math.min(W, Math.round(rect.x)))
    const y = Math.max(0, Math.min(H, Math.round(rect.y)))
    const width = Math.max(0, Math.min(W - x, Math.round(rect.width)))
    const height = Math.max(0, Math.min(H - y, Math.round(rect.height)))
    set({ selection: width >= 8 && height >= 8 ? { x, y, width, height } : null })
  }

  function setQuestion(text) {
    set({ question: String(text ?? '').slice(0, 1000) })
  }

  // ---- analysis ----------------------------------------------------------------------------------------------------

  async function exportForUpload(rect) {
    let lastError = null
    for (const maxSide of EXPORT_SIZES) {
      const out = await native.exportCapture({ captureId: state.capture.captureId, rect, maxSide })
      held = { bytes: out.bytes, mimeType: out.mimeType }
      try {
        return await sendHeld()
      } catch (err) {
        lastError = err
        if (!(err instanceof ScreenshotApiError && err.code === 'image-too-large')) throw err
      }
    }
    throw lastError
  }

  async function sendHeld() {
    const conversationId = getConversationId()
    if (!conversationId) throw new ScreenshotApiError('There is no conversation open to attach it to.', { status: 404, code: 'conversation-not-found' })
    pendingConversation = conversationId
    uploadAbort = new AbortController()
    try {
      return await api.attach(conversationId, held, { question: state.question, id: pendingId, signal: uploadAbort.signal })
    } catch (err) {
      // The server already has it (an earlier try got through, and only its answer was lost): carry on with that one.
      if (err instanceof ScreenshotApiError && err.code === 'duplicate-id') return await api.get(pendingId)
      throw err
    } finally {
      uploadAbort = null
    }
  }

  async function analyse() {
    if (state.phase !== 'preview' || !state.capture) return state
    const token = ++runToken
    pendingId = newId()
    set({ phase: 'uploading', error: null, message: 'Sending the screenshot…', tone: 'info' })
    let record
    try {
      record = await exportForUpload(state.selection)
    } catch (err) {
      if (token !== runToken) return state
      if (err?.name === 'AbortError') return state
      const problem = err instanceof CaptureError ? { code: err.code, message: err.message, retryable: err.code !== 'expired' } : describeApi(err)
      set({ phase: 'failed', error: problem, message: problem.message, tone: 'error' })
      return state
    }
    if (token !== runToken) {
      api.remove(record.id, record.conversationId).catch(() => {})
      return state
    }
    await finishNative() // the native layer's copy is no longer needed: what was sent is held here
    set({ phase: 'analyzing', shot: record, capture: { ...state.capture, captureId: '' }, message: 'Analysing the screenshot…', tone: 'info' })
    poll(token)
    return state
  }

  async function poll(token) {
    let failures = 0
    let interval = POLL_MS
    while (token === runToken && state.phase === 'analyzing') {
      await wait(interval)
      if (token !== runToken || state.phase !== 'analyzing') return
      let view
      try {
        view = await api.get(state.shot.id)
        failures = 0
      } catch (err) {
        if (token !== runToken) return
        if (err instanceof ScreenshotApiError && err.status === 404) {
          const problem = { code: 'screenshot-not-found', message: 'The server no longer has this screenshot. Capture it again.', retryable: false }
          return set({ phase: 'failed', error: problem, message: problem.message, tone: 'error' })
        }
        if (++failures >= POLL_FAILURES) {
          const problem = { code: 'network', message: 'Lost contact with the server while the screenshot was being analysed. Try again.', retryable: true }
          return set({ phase: 'failed', error: problem, message: problem.message, tone: 'error' })
        }
        continue
      }
      interval = Math.min(POLL_MAX_MS, Math.round(interval * 1.3))
      if (view.status === 'analyzing') continue
      return settle(view)
    }
  }

  function settle(view) {
    const shot = { ...state.shot, ...view }
    if (view.status === 'ready') {
      const here = getConversationId() === shot.conversationId
      set({ phase: 'ready', shot, analysis: view.analysis ?? '', message: here ? 'Added to the conversation.' : 'Added to the conversation you had open when you took it.', tone: 'ok' })
      if (here) onExchange({ kind: 'analysis', shotId: shot.id, question: state.question, analysis: view.analysis ?? '' })
    } else if (view.status === 'cancelled') {
      set({ phase: 'cancelled', shot, message: 'Cancelled.', tone: 'info' })
    } else {
      const problem = { code: view.error?.code ?? 'failed', message: view.error?.message ?? 'The screenshot could not be analysed.', retryable: view.retryable === true }
      set({ phase: 'failed', shot, error: problem, message: problem.message, tone: 'error' })
    }
  }

  async function cancel() {
    if (state.phase === 'capturing') {
      runToken++
      return set({ ...initial(), support: state.support, windows: state.windows, phase: 'idle' })
    }
    if (state.phase === 'uploading') {
      runToken++
      uploadAbort?.abort()
      set({ phase: 'cancelled', message: 'Cancelled.', tone: 'info', error: null })
      // The request may already have reached the server: undo it by the id the page chose (nothing is left in the conversation).
      if (pendingId) await api.remove(pendingId, pendingConversation ?? '').catch(() => {})
      return state
    }
    if (state.phase === 'analyzing' && state.shot) {
      runToken++
      set({ phase: 'cancelled', message: 'Cancelled.', tone: 'info' })
      try {
        await api.cancel(state.shot.id)
      } catch {
        /* the server drops it anyway when it expires; the page has moved on */
      }
      return state
    }
    return state
  }

  async function retry() {
    if (state.phase !== 'failed' && state.phase !== 'cancelled') return state
    if (state.error && state.error.retryable === false) return state
    const token = ++runToken
    // First choice: the server still holds the picture, so only the analysis is repeated.
    if (state.shot?.id) {
      set({ phase: 'analyzing', error: null, message: 'Analysing the screenshot…', tone: 'info' })
      try {
        const view = await api.retry(state.shot.id)
        if (token !== runToken) return state
        if (view.status === 'analyzing') {
          set({ shot: { ...state.shot, ...view } })
          poll(token)
          return state
        }
        settle(view)
        return state
      } catch (err) {
        if (token !== runToken) return state
        const gone = err instanceof ScreenshotApiError && (err.status === 410 || err.status === 404)
        if (!gone) {
          const problem = describeApi(err)
          set({ phase: 'failed', error: problem, message: problem.message, tone: 'error' })
          return state
        }
        // The server's copy is gone (expired, or the server restarted): send the held picture again.
      }
    }
    if (!held) {
      const problem = { code: 'expired', message: describeCaptureError('expired'), retryable: false }
      set({ phase: 'failed', error: problem, message: problem.message, tone: 'error' })
      return state
    }
    // A fresh screenshot: the old record (its picture already dropped, nothing of it in the conversation) is cleared first.
    if (state.shot?.id) await api.remove(state.shot.id, state.shot.conversationId).catch(() => {})
    if (token !== runToken) return state
    if (!pendingId || state.shot?.id) pendingId = newId()
    set({ phase: 'uploading', error: null, message: 'Sending the screenshot…', tone: 'info' })
    try {
      const record = await sendHeld()
      if (token !== runToken) {
        api.remove(record.id, record.conversationId).catch(() => {})
        return state
      }
      set({ phase: 'analyzing', shot: record, message: 'Analysing the screenshot…', tone: 'info' })
      poll(token)
    } catch (err) {
      if (token !== runToken || err?.name === 'AbortError') return state
      const problem = describeApi(err)
      set({ phase: 'failed', error: problem, message: problem.message, tone: 'error' })
    }
    return state
  }

  /** Delete: from the preview it only discards the capture; after analysis it removes the picture AND its messages from the conversation. */
  async function remove() {
    const shot = state.shot
    runToken++
    uploadAbort?.abort()
    await finishNative()
    held = null
    if (shot?.id) {
      try {
        await api.remove(shot.id, shot.conversationId)
      } catch (err) {
        const problem = describeApi(err)
        // The attachment is still there: say so, and keep the controls so the person can try again.
        return set({ phase: state.phase === 'analyzing' ? 'failed' : state.phase, error: { ...problem, retryable: state.error?.retryable ?? false }, message: 'The screenshot could not be deleted. Try again.', tone: 'error' })
      }
      onRemoved({ shotId: shot.id, conversationId: shot.conversationId })
    }
    set({ ...initial(), support: state.support, windows: state.windows, phase: 'idle' })
    return state
  }

  async function removeById(shotId, conversationId) {
    await api.remove(shotId, conversationId)
    onRemoved({ shotId, conversationId })
  }

  /** The person closes the panel: a preview is discarded; an analysis in flight is cancelled; what is already in the conversation stays. */
  async function dismiss() {
    if (state.phase === 'analyzing') await cancel()
    if (state.phase === 'uploading') await cancel()
    runToken++
    await finishNative()
    held = null
    set({ ...initial(), support: state.support, windows: state.windows, phase: native.available ? 'idle' : 'unavailable', message: native.available ? '' : describeCaptureError('unavailable') })
    return state
  }

  async function ask(question) {
    const text = String(question ?? '').trim()
    if (!text || state.phase !== 'ready' || !state.shot || state.asking) return null
    set({ asking: true, message: 'Looking at the screenshot again…', tone: 'info' })
    try {
      const reply = await api.ask(state.shot.id, text)
      set({ asking: false, message: 'Added to the conversation.', tone: 'ok' })
      if (getConversationId() === state.shot.conversationId) onExchange({ kind: 'follow-up', shotId: state.shot.id, question: text, analysis: reply.answer })
      return reply
    } catch (err) {
      const expired = err instanceof ScreenshotApiError && err.status === 410
      set({
        asking: false,
        shot: expired ? { ...state.shot, pictureKept: false } : state.shot,
        message: expired ? 'The picture is no longer kept. Its analysis is part of this conversation: ask in the chat below.' : describeApi(err).message,
        tone: expired ? 'warn' : 'error'
      })
      return null
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    init,
    loadWindows,
    capture,
    setSelection,
    setQuestion,
    analyse,
    cancel,
    retry,
    remove,
    removeById,
    dismiss,
    ask,
    /** Page is closing: free what the native layer holds. */
    async destroy() {
      runToken++
      uploadAbort?.abort()
      await finishNative()
      held = null
      listeners.clear()
    }
  }
}
