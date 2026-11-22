import { randomUUID } from 'node:crypto'
import { LEGACY_OWNER } from '../sessions/sessionService.js'
import { imageInfo } from './imageInfo.js'
import { buildAnalyzeMessages, buildFollowUpMessages, SCREENSHOT_QUESTION_LIMIT } from './screenshotPrompts.js'

/**
 * Screenshot Intelligence, the server side: a screenshot taken by the desktop app is attached to an ordinary assistant conversation,
 * looked at by the configured vision model (the same one the Smart Camera uses), and what was seen becomes part of that conversation.
 *
 *   attach(conversationId, picture, { question }, ctx)   check the picture and the person's limits, then analyse it in the background
 *   get(id, ctx)                                         where it stands: analyzing | ready | failed | cancelled
 *   cancel(id, ctx)                                      stop an analysis that is still running (nothing is written to the conversation)
 *   retry(id, ctx)                                       run a failed or cancelled analysis again on the picture still held
 *   ask(id, { question }, ctx)                           a follow-up that looks at the picture again (while it is still held)
 *   remove(id, { conversationId }, ctx)                  delete the attachment: the picture, and its messages in the conversation
 *
 * What is kept, and for how long (the Smart Camera's rule, applied here; nothing about screenshots is more permissive):
 *   - the picture: in memory only, never written to disk or to the saved conversation, dropped after `pictureKeptMs` (10 minutes by
 *     default), when it is deleted, when the conversation ends, or when the server restarts.
 *   - what the model said about it (its analysis, and any follow-up answers): saved in the conversation like any other message,
 *     marked `[Screenshot id=<id>]` so that deleting the attachment removes exactly those messages and the page can show a chip.
 *     It is therefore subject to the conversation's own privacy: private to its owner, shown in the person's history, deleted with
 *     the conversation. Follow-up questions typed in the normal chat box see the analysis through the conversation history;
 *     `ask` additionally lets the model look at the picture again while it is held.
 *   - logs carry ids, statuses and counts only: never a picture, a question or an answer, and never an upstream error's own words.
 *
 * Every screenshot belongs to the person who attached it (`ctx.owner`, the key the conversations use); another person's id is "not
 * found". Each model call counts against that person's usage and limits as a picture read (`vision_read`) or answer (`vision_answer`).
 *
 * `vision` is `{ configured, name, read({ messages, image, signal, onUsage }) -> string, answer?(...) -> string }` (see camera/vision.js).
 */

export const SCREENSHOT_LIMITS = Object.freeze({
  maxImageBytes: 6_000_000,
  maxPixels: 36_000_000, // 8K and a little more
  minSide: 8,
  pictureKeptMs: 10 * 60_000,
  recordKeptMs: 60 * 60_000,
  maxActivePerOwner: 2, // analyses running at once, per person
  maxActive: 4, // and in all
  maxHeldPerOwner: 10,
  maxAttempts: 5,
  maxAsks: 10,
  modelTimeoutMs: 45_000,
  maxAnalysisChars: 12_000
})

export class ScreenshotError extends Error {
  constructor(statusCode, code, message, { retryAfterSeconds = null } = {}) {
    super(message)
    this.name = 'ScreenshotError'
    this.statusCode = statusCode
    this.code = code
    this.expose = true
    if (retryAfterSeconds !== null) this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds))
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The marker that ties a conversation message to its screenshot. Page and store read it too (attachments.js, conversationRepository.js). */
export const screenshotMarker = (id, followUp = false) => `[Screenshot id=${id}${followUp ? ' follow-up' : ''}]`
export const screenshotMarkerPrefix = (id) => `[Screenshot id=${id}`

/** How a failure of the vision service is told to the person. */
function describeFailure(err) {
  if (err?.name === 'AbortError' && err?.cancelled) return { status: 'cancelled' }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return { code: 'timeout', message: 'The vision service took too long. Try again.', retryable: true }
  }
  const status = err?.statusCode ?? err?.status
  if (status === 401 || status === 403) return { code: 'vision-refused', message: 'The vision service refused the request (its key may be wrong). Ask whoever runs this server.', retryable: false }
  if (status === 429) return { code: 'vision-busy', message: 'The vision service is busy or over its limit. Try again in a minute.', retryable: true }
  if (status >= 500) return { code: 'vision-unavailable', message: 'The vision service is unavailable right now. Try again shortly.', retryable: true }
  if (status >= 400) return { code: 'vision-rejected', message: 'The vision service could not accept this picture.', retryable: false }
  return { code: 'vision-unreachable', message: 'The vision service could not be reached. Check the connection and try again.', retryable: true }
}

export function createScreenshotService({ vision, sessions, now = Date.now, logger = console, newId = randomUUID, limits = {} } = {}) {
  const cap = { ...SCREENSHOT_LIMITS, ...limits }
  const items = new Map() // `${owner}\0${id}` -> item (an id is only ever looked up inside its owner's own space)
  const keyOf = (owner, id) => `${owner}\u0000${id}`

  const log = (message) => logger.info(`[screenshot] ${message}`)
  const ownerOf = (ctx) => ctx?.owner ?? LEGACY_OWNER
  const viewOf = (owner) => (typeof sessions.forOwner === 'function' ? sessions.forOwner(owner) : sessions)

  function dropPicture(item) {
    item.picture = null
  }

  function sweep() {
    const t = now()
    for (const [key, item] of items) {
      if (item.picture && item.picture.expiresAt <= t) dropPicture(item)
      if (item.status !== 'analyzing' && t - item.updatedAt > cap.recordKeptMs) items.delete(key)
    }
  }

  function find(id, owner) {
    sweep()
    const item = typeof id === 'string' ? items.get(keyOf(owner, id)) : null
    if (!item) throw new ScreenshotError(404, 'screenshot-not-found', 'That screenshot is no longer here.')
    return item
  }

  function publicView(item) {
    const t = now()
    return {
      id: item.id,
      conversationId: item.conversationId,
      status: item.status,
      ...(item.status === 'ready' ? { analysis: item.analysis } : {}),
      ...(item.status === 'failed' && item.error ? { error: { code: item.error.code, message: item.error.message }, retryable: item.error.retryable === true && item.attempts < cap.maxAttempts && Boolean(item.picture) } : {}),
      ...(item.status === 'cancelled' ? { retryable: Boolean(item.picture) && item.attempts < cap.maxAttempts } : {}),
      pictureKept: Boolean(item.picture),
      ...(item.picture ? { pictureKeptSeconds: Math.max(0, Math.round((item.picture.expiresAt - t) / 1000)) } : {}),
      width: item.width,
      height: item.height,
      asks: item.asks
    }
  }

  /** The two model calls differ only in prompt and in which port method answers. */
  function callVision(kind, { messages, image, signal }, ctx, conversationId) {
    const call = ctx.meter?.begin(ctx.identity, kind, { requestId: ctx.requestId, conversationId })
    return { call, run: (callSignal) => (kind === 'vision_answer' && typeof vision.answer === 'function' ? vision.answer : vision.read).call(vision, { messages, image, signal: callSignal, onUsage: call?.usage }) }
  }

  async function withDeadline(run, cancelSignal) {
    const controller = new AbortController()
    const signal = cancelSignal ? AbortSignal.any([controller.signal, cancelSignal]) : controller.signal
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(Object.assign(new Error('The vision service did not answer in time'), { name: 'TimeoutError' }))
      }, cap.modelTimeoutMs)
    })
    const cancelled = new Promise((_, reject) => {
      cancelSignal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', cancelled: true })), { once: true })
    })
    try {
      return await Promise.race([Promise.resolve().then(() => run(signal)), deadline, cancelled])
    } finally {
      clearTimeout(timer)
    }
  }

  const cleanAnswer = (raw) => (typeof raw === 'string' ? raw.trim().slice(0, cap.maxAnalysisChars) : '')

  function questionFrom(value) {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value !== 'string') throw new ScreenshotError(400, 'invalid-question', `The question must be text, at most ${SCREENSHOT_QUESTION_LIMIT} characters.`)
    const text = value.trim()
    if (text.length > SCREENSHOT_QUESTION_LIMIT) throw new ScreenshotError(400, 'invalid-question', `The question must be at most ${SCREENSHOT_QUESTION_LIMIT} characters.`)
    return text
  }

  function activeCount(owner = null) {
    let n = 0
    for (const item of items.values()) if (item.status === 'analyzing' && (!owner || item.owner === owner)) n++
    return n
  }

  function requireCapacity(owner) {
    if (activeCount(owner) >= cap.maxActivePerOwner) throw new ScreenshotError(429, 'screenshot-busy', 'Your last screenshot is still being analysed. Wait for it, or cancel it.', { retryAfterSeconds: 3 })
    if (activeCount() >= cap.maxActive) throw new ScreenshotError(503, 'screenshot-busy', 'The screenshot service is busy. Try again in a moment.', { retryAfterSeconds: 3 })
  }

  /** Starts (or restarts) the background analysis of an item. The person's limits are checked here, before anything is sent. */
  function start(item, ctx) {
    const { call, run } = callVision('vision_read', { messages: buildAnalyzeMessages({ question: item.question }), image: { bytes: item.picture.bytes, mimeType: item.picture.mimeType } }, ctx, item.conversationId)
    const controller = new AbortController()
    item.status = 'analyzing'
    item.error = null
    item.abort = controller
    item.attempts++
    item.updatedAt = now()
    void (async () => {
      let raw
      try {
        raw = await withDeadline((signal) => run(signal), controller.signal)
        call?.finish({ images: 1, provider: vision?.name })
      } catch (err) {
        call?.fail(err)
        item.abort = null
        if (items.get(keyOf(item.owner, item.id)) !== item) return // deleted while running
        const verdict = err?.cancelled || controller.signal.aborted ? { status: 'cancelled' } : describeFailure(err)
        item.updatedAt = now()
        if (verdict.status === 'cancelled') {
          item.status = 'cancelled'
          log(`${item.id} cancelled`)
        } else {
          item.status = 'failed'
          item.error = verdict
          log(`${item.id} failed (${verdict.code})`)
        }
        return
      }
      item.abort = null
      if (items.get(keyOf(item.owner, item.id)) !== item || controller.signal.aborted) return
      const analysis = cleanAnswer(raw)
      item.updatedAt = now()
      if (!analysis) {
        item.status = 'failed'
        item.error = { code: 'empty-analysis', message: 'The vision service sent back nothing to show. Try again.', retryable: true }
        log(`${item.id} failed (empty-analysis)`)
        return
      }
      try {
        const view = viewOf(item.owner)
        view.appendMessage(item.conversationId, { role: 'user', content: `${item.question ? `${item.question}\n` : ''}${screenshotMarker(item.id)}` })
        view.appendMessage(item.conversationId, { role: 'assistant', content: analysis })
      } catch (err) {
        item.status = 'failed'
        item.error = { code: 'conversation-gone', message: 'The conversation this screenshot belonged to has ended.', retryable: false }
        log(`${item.id} failed (conversation-gone: ${err?.statusCode ?? err?.name ?? 'error'})`)
        return
      }
      item.analysis = analysis
      item.status = 'ready'
      log(`${item.id} ready`)
    })()
  }

  async function attach(conversationId, picture, { question, id: wantedId } = {}, ctx = {}) {
    const owner = ownerOf(ctx)
    sweep()
    const bytes = picture?.bytes
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new ScreenshotError(400, 'invalid-image', 'That is not a picture that can be analysed.')
    if (bytes.length > cap.maxImageBytes) throw new ScreenshotError(413, 'image-too-large', `That screenshot is too large (more than ${Math.round(cap.maxImageBytes / 1_000_000)} MB). Capture a smaller area, or a window.`)
    const info = imageInfo(bytes)
    if (!info) throw new ScreenshotError(400, 'invalid-image', 'Only PNG, JPEG and WebP screenshots can be analysed, and this one could not be read.')
    if (info.width < cap.minSide || info.height < cap.minSide) throw new ScreenshotError(400, 'invalid-image', 'That screenshot is too small to contain anything to read.')
    if (info.width * info.height > cap.maxPixels) throw new ScreenshotError(413, 'image-too-large', 'That screenshot has too many pixels. Capture a smaller area, or a window.')
    const typed = questionFrom(question)
    // The page may choose the id (a UUID) so that it can cancel or delete a screenshot whose upload answer it never saw (a dropped
    // connection). Sending the same id again is "duplicate-id": the screenshot is already here, look it up.
    if (wantedId !== undefined && wantedId !== null && wantedId !== '' && (typeof wantedId !== 'string' || !UUID.test(wantedId))) {
      throw new ScreenshotError(400, 'invalid-id', 'That is not a screenshot id.')
    }
    if (wantedId && items.has(keyOf(owner, wantedId))) throw new ScreenshotError(409, 'duplicate-id', 'That screenshot is already here.')

    if (!vision?.configured) throw new ScreenshotError(503, 'vision-not-configured', 'Reading pictures is not set up on this server yet.')
    const view = viewOf(owner)
    if (typeof conversationId !== 'string' || !UUID.test(conversationId) || !view.getSession(conversationId)) {
      throw new ScreenshotError(404, 'conversation-not-found', 'That conversation is no longer open. Start a new chat and capture again.')
    }
    requireCapacity(owner)

    // Hold only so many pictures per person: the oldest goes first.
    const mine = [...items.values()].filter((item) => item.owner === owner && item.picture).sort((a, b) => a.createdAt - b.createdAt)
    while (mine.length >= cap.maxHeldPerOwner) dropPicture(mine.shift())

    const t = now()
    const item = {
      id: wantedId || newId(),
      owner,
      conversationId,
      question: typed,
      status: 'analyzing',
      picture: { bytes: Buffer.from(bytes), mimeType: info.mimeType, expiresAt: t + cap.pictureKeptMs },
      width: info.width,
      height: info.height,
      analysis: '',
      error: null,
      abort: null,
      attempts: 0,
      asks: 0,
      createdAt: t,
      updatedAt: t
    }
    items.set(keyOf(owner, item.id), item)
    try {
      start(item, ctx) // throws when one of the person's limits is reached: then nothing was kept
    } catch (err) {
      items.delete(keyOf(owner, item.id))
      throw err
    }
    log(`${item.id} attached (${info.mimeType.slice(6)} ${info.width}x${info.height}, ${bytes.length} bytes)`)
    return publicView(item)
  }

  function get(id, ctx = {}) {
    return publicView(find(id, ownerOf(ctx)))
  }

  function cancel(id, ctx = {}) {
    const item = find(id, ownerOf(ctx))
    if (item.status === 'analyzing') {
      item.abort?.abort()
      item.status = 'cancelled' // at once: the person pressed Cancel, and nothing the model says after this is written anywhere
      item.updatedAt = now()
      log(`${item.id} cancelled`)
    }
    return publicView(item)
  }

  function retry(id, ctx = {}) {
    const item = find(id, ownerOf(ctx))
    if (item.status === 'analyzing') return publicView(item)
    if (item.status === 'ready') throw new ScreenshotError(409, 'already-analysed', 'That screenshot has already been analysed.')
    if (!item.picture) throw new ScreenshotError(410, 'picture-expired', 'The picture is no longer kept. Capture it again.')
    if (item.attempts >= cap.maxAttempts) throw new ScreenshotError(429, 'too-many-attempts', 'That screenshot has been tried too many times. Capture it again.')
    requireCapacity(item.owner)
    item.picture.expiresAt = now() + cap.pictureKeptMs
    start(item, ctx)
    return publicView(item)
  }

  async function ask(id, { question } = {}, ctx = {}) {
    const item = find(id, ownerOf(ctx))
    const typed = questionFrom(question)
    if (!typed) throw new ScreenshotError(400, 'invalid-question', 'Type a question about the screenshot.')
    if (item.status !== 'ready') throw new ScreenshotError(409, 'not-analysed', 'That screenshot has not been analysed yet.')
    if (!item.picture) throw new ScreenshotError(410, 'picture-expired', 'The picture is no longer kept, but its analysis is still part of this conversation: ask in the chat below.')
    if (item.asks >= cap.maxAsks) throw new ScreenshotError(429, 'too-many-questions', 'That screenshot has had as many follow-up questions as allowed. Ask in the chat below.')
    if (item.asking) throw new ScreenshotError(409, 'screenshot-busy', 'The last question about this screenshot is still being answered.')
    requireCapacity(item.owner)

    const { call, run } = callVision('vision_answer', { messages: buildFollowUpMessages({ question: typed, earlier: item.analysis }), image: { bytes: item.picture.bytes, mimeType: item.picture.mimeType } }, ctx, item.conversationId)
    item.asking = true
    item.picture.expiresAt = now() + cap.pictureKeptMs
    let reply
    try {
      reply = cleanAnswer(await withDeadline((signal) => run(signal)))
      call?.finish({ images: 1, provider: vision?.name })
    } catch (err) {
      call?.fail(err)
      const verdict = describeFailure(err)
      log(`${item.id} follow-up failed (${verdict.code ?? 'error'})`)
      throw new ScreenshotError(502, verdict.code ?? 'answer-failed', verdict.message ?? 'The question could not be answered just now. Try again.')
    } finally {
      item.asking = false
    }
    if (items.get(keyOf(item.owner, item.id)) !== item) throw new ScreenshotError(404, 'screenshot-not-found', 'That screenshot was deleted while the question was being answered.')
    if (!reply) throw new ScreenshotError(502, 'empty-analysis', 'The vision service sent back nothing to show. Try again.')
    try {
      const view = viewOf(item.owner)
      view.appendMessage(item.conversationId, { role: 'user', content: `${typed}\n${screenshotMarker(item.id, true)}` })
      view.appendMessage(item.conversationId, { role: 'assistant', content: reply })
    } catch {
      throw new ScreenshotError(404, 'conversation-not-found', 'The conversation this screenshot belonged to has ended.')
    }
    item.asks++
    item.updatedAt = now()
    log(`${item.id} follow-up answered`)
    return { id: item.id, question: typed, answer: reply, asks: item.asks }
  }

  /**
   * Deletes the attachment: stops a running analysis, drops the picture, and removes the screenshot's messages from the conversation.
   * Works for an id this server no longer knows (it restarted, or the record expired) when the page names the conversation: the
   * messages are found by their marker. Idempotent. Only ever touches this person's own conversation.
   */
  function remove(id, { conversationId } = {}, ctx = {}) {
    const owner = ownerOf(ctx)
    if (typeof id !== 'string' || !UUID.test(id)) throw new ScreenshotError(400, 'invalid-id', 'That is not a screenshot id.')
    const mine = items.get(keyOf(owner, id)) ?? null
    const conversation = mine?.conversationId ?? (typeof conversationId === 'string' && UUID.test(conversationId) ? conversationId : null)
    if (mine) {
      mine.abort?.abort()
      dropPicture(mine)
      items.delete(keyOf(owner, id))
    }
    let removed = 0
    if (conversation) {
      try {
        removed = viewOf(owner).removeScreenshot(conversation, screenshotMarkerPrefix(id))
      } catch (err) {
        logger.error(`[screenshot] ${id} could not be removed from the conversation (${err?.name ?? 'error'})`)
        throw new ScreenshotError(500, 'delete-failed', 'The screenshot could not be removed from the conversation. Try again.')
      }
    }
    log(`${id} deleted (${removed} message(s))`)
    return { removed }
  }

  /** The conversation ended or was deleted: drop the pictures that belonged to it. */
  function forgetConversation(conversationId, ctx = {}) {
    const owner = ownerOf(ctx)
    for (const [key, item] of items) {
      if (item.owner === owner && item.conversationId === conversationId) {
        item.abort?.abort()
        dropPicture(item)
        items.delete(key)
      }
    }
  }

  /** Every picture of a person's conversations is dropped (they deleted all of them). */
  function forgetOwner(ctx = {}) {
    const owner = ownerOf(ctx)
    for (const [key, item] of items) {
      if (item.owner === owner) {
        item.abort?.abort()
        dropPicture(item)
        items.delete(key)
      }
    }
  }

  return {
    attach,
    get,
    cancel,
    retry,
    ask,
    remove,
    forgetConversation,
    forgetOwner,
    sweep,
    limits: Object.freeze({ ...cap }),
    /** For tests: pictures held in memory right now. */
    _heldPictures() {
      let n = 0
      for (const item of items.values()) if (item.picture) n++
      return n
    }
  }
}
