import { randomUUID } from 'node:crypto'
import { CameraError } from './cameraError.js'
import { parseAnswer, parseReading, toMarkdown } from './cameraModelOutput.js'
import { buildAnswerMessages, buildReadMessages } from './cameraPrompts.js'
import { findKnownQuestion, identityText, sameQuestion, validateReading } from './questionIdentity.js'

/**
 * The server side of the Smart Camera: what is read from a picture, what counts as a question already seen, what is
 * asked of the models, and what is kept.
 *
 *   read(sessionId, picture)      a picture -> the question in it (a vision model reads it; it is NOT answered)
 *   answer(sessionId, { ... })    a question read earlier (optionally with the person's corrected wording) -> an answer
 *   clear(sessionId)              forget the session and delete what was saved of it
 *
 * Two calls, not one, so that "review before answering" can stop between them.
 *
 * What is kept, and for how long:
 *   - the picture: never, with one exception. A question that depends on a figure keeps its picture in memory for two
 *     minutes so a vision model can see the figure when it is answered. It is dropped once answered or expired.
 *   - the text of the questions of a session, and their answers: in memory for the session (30 minutes idle at most),
 *     and each answered question is also saved as an ordinary assistant conversation (id = the session id) so it shows
 *     up in the history and can be deleted there. `clear` removes both.
 *   - logs carry ids, statuses and counts only: never a picture, a question or an answer, and never an upstream error's
 *     message (which can echo what was sent).
 *
 * `vision` is `{ configured, read({ messages, image, signal }) -> string, answer?({ messages, image, signal }) -> string }`.
 * `answerEngine` is `(messages, { signal }) -> string` (the configured text model, normally DeepSeek).
 */

export const CAMERA_LIMITS = Object.freeze({
  maxReads: 100, // pictures read per session
  maxImageBytes: 1_500_000,
  minReadIntervalMs: 2000,
  maxActiveSessions: 20,
  sessionIdleMs: 30 * 60_000,
  pictureKeptMs: 2 * 60_000,
  maxConcurrentReads: 2,
  modelTimeoutMs: 40_000,
  maxQuestionChars: 2000
})

const FIGURE_NOTE = 'This question refers to a figure or table that could not be seen, so the answer may be incomplete.'

function pictureKind(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function createCameraService({ vision, answerEngine, sessions, now = Date.now, logger = console, newId = randomUUID, limits = {} } = {}) {
  const cap = { ...CAMERA_LIMITS, ...limits }
  const active = new Map() // sessionId -> { id, createdAt, lastUsedAt, lastReadAt, reads, busy, known: [{questionId, identity}], questions: Map }
  let readsInFlight = 0

  const log = (message) => logger.info(`[camera] ${message}`)

  function dropPicture(entry) {
    entry.picture = null
  }

  function sweep() {
    const t = now()
    for (const [id, session] of active) {
      if (t - session.lastUsedAt > cap.sessionIdleMs && !session.busy) {
        active.delete(id)
        sessions.forget(id)
        log(`session ${id} expired`)
        continue
      }
      for (const entry of session.questions.values()) if (entry.picture && entry.picture.expiresAt <= t) dropPicture(entry)
    }
  }

  function find(sessionId) {
    sweep()
    const session = active.get(sessionId)
    if (!session) throw new CameraError(404, 'session-not-found', 'This camera session has ended. Start it again.')
    session.lastUsedAt = now()
    return session
  }

  function requireStill(session) {
    // the session may have been cleared or have expired while a model was thinking
    if (active.get(session.id) !== session) throw new CameraError(404, 'session-not-found', 'This camera session has ended. Start it again.')
  }

  /**
   * Runs one model call with a deadline. The call is handed an AbortSignal and is also raced against the clock, because
   * the shared text-model entry point takes no signal: a provider that hangs must not hang the page.
   */
  function withDeadline(run) {
    const controller = new AbortController()
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(Object.assign(new Error('The model did not answer in time'), { name: 'TimeoutError' }))
      }, cap.modelTimeoutMs)
    })
    return Promise.race([Promise.resolve().then(() => run(controller.signal)), deadline]).finally(() => clearTimeout(timer))
  }

  async function createSession() {
    sweep()
    while (active.size >= cap.maxActiveSessions) {
      let idlest = null
      for (const session of active.values()) if (!idlest || session.lastUsedAt < idlest.lastUsedAt) idlest = session
      active.delete(idlest.id)
      sessions.forget(idlest.id)
      log(`session ${idlest.id} dropped: too many sessions`)
    }
    const conversation = sessions.createSession({ source: 'camera' })
    const t = now()
    active.set(conversation.id, { id: conversation.id, createdAt: t, lastUsedAt: t, lastReadAt: null, reads: 0, busy: false, known: [], questions: new Map() })
    log(`session ${conversation.id} started`)
    return { sessionId: conversation.id, visionConfigured: Boolean(vision?.configured), limits: { maxReads: cap.maxReads, maxImageBytes: cap.maxImageBytes } }
  }

  async function read(sessionId, picture) {
    const session = find(sessionId)

    const bytes = picture?.bytes
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new CameraError(400, 'invalid-image', 'That is not a picture the camera can read.')
    if (bytes.length > cap.maxImageBytes) throw new CameraError(413, 'image-too-large', 'That picture is too large. Try again.')
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const mimeType = pictureKind(buffer)
    if (!mimeType) throw new CameraError(400, 'invalid-image', 'Only JPEG, PNG and WebP pictures can be read.')

    if (!vision?.configured) throw new CameraError(503, 'vision-not-configured', 'Reading pictures is not set up on this server yet.')
    if (session.busy) throw new CameraError(409, 'camera-busy', 'The last picture is still being read.')
    if (session.reads >= cap.maxReads) throw new CameraError(429, 'session-limit', 'This session has read as many pictures as it is allowed. Start a new session.')
    const t = now()
    if (session.lastReadAt !== null && t - session.lastReadAt < cap.minReadIntervalMs) {
      throw new CameraError(429, 'camera-rate-limited', 'Pictures are coming too fast.', { retryAfterSeconds: (cap.minReadIntervalMs - (t - session.lastReadAt)) / 1000 })
    }
    if (readsInFlight >= cap.maxConcurrentReads) throw new CameraError(503, 'camera-busy', 'The camera service is busy. Try again in a moment.', { retryAfterSeconds: 2 })

    session.busy = true
    session.lastReadAt = t
    session.reads++
    readsInFlight++
    let raw
    try {
      raw = await withDeadline((signal) => vision.read({ messages: buildReadMessages(), image: { bytes: buffer, mimeType }, signal }))
    } catch (err) {
      log(`session ${session.id} read failed (${err?.statusCode ?? err?.status ?? err?.name ?? 'error'})`)
      throw new CameraError(502, 'read-failed', 'The picture could not be read just now. Try again.')
    } finally {
      session.busy = false
      readsInFlight--
    }
    requireStill(session)

    const parsed = parseReading(raw)
    if (!parsed.ok) {
      log(`session ${session.id} read: unclear (not in the expected format)`)
      return { status: 'unclear', reason: 'The picture could not be understood. Hold the camera steady and a little closer.' }
    }
    const { reading } = parsed
    const verdict = validateReading(reading)
    if (!verdict.ok) {
      log(`session ${session.id} read: ${verdict.status}`)
      return verdict.status === 'not-a-question' ? { status: 'not-a-question', reason: verdict.reason } : { status: 'unclear', reason: verdict.reason }
    }

    const identity = identityText(reading)
    const known = findKnownQuestion(identity, session.known)
    if (known) {
      const entry = session.questions.get(known.questionId)
      log(`session ${session.id} read: duplicate of ${known.questionId}`)
      return { status: 'duplicate', questionId: known.questionId, answer: entry?.answer ?? null, ...(entry?.markdown ? { markdown: entry.markdown } : {}) }
    }

    const questionId = newId()
    const entry = {
      questionId,
      text: reading.text,
      options: reading.options,
      type: reading.type,
      subject: reading.subject,
      hasDiagram: reading.hasDiagram,
      picture: reading.hasDiagram ? { bytes: buffer, mimeType, expiresAt: now() + cap.pictureKeptMs } : null,
      answer: null,
      markdown: '',
      answeredText: null,
      pending: null
    }
    session.questions.set(questionId, entry)
    session.known.push({ questionId, identity })
    log(`session ${session.id} read: new question ${questionId}`)
    return {
      status: 'new',
      questionId,
      question: { text: reading.text, options: reading.options, type: reading.type, subject: reading.subject, confidence: reading.confidence, hasDiagram: reading.hasDiagram }
    }
  }

  function editedText(value) {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || !value.trim() || value.length > cap.maxQuestionChars) {
      throw new CameraError(400, 'invalid-question', 'The question must be some text, at most 2000 characters.')
    }
    return value.trim()
  }

  async function ask(entry, text) {
    const messages = buildAnswerMessages({ text, options: entry.options, type: entry.type, subject: entry.subject })
    const seesFigure = entry.hasDiagram && entry.picture && typeof vision?.answer === 'function'
    const raw = await withDeadline((signal) =>
      seesFigure
        ? vision.answer({ messages, image: { bytes: entry.picture.bytes, mimeType: entry.picture.mimeType }, signal })
        : answerEngine(messages, { signal })
    )
    const { answer } = parseAnswer(raw)
    if (entry.hasDiagram && !seesFigure) {
      // Nobody looked at the figure the question depends on: never claim to be sure.
      if (answer.confidence === 'high') answer.confidence = 'medium'
      answer.uncertainty = answer.uncertainty ? `${answer.uncertainty} ${FIGURE_NOTE}` : FIGURE_NOTE
    }
    return answer
  }

  async function answer(sessionId, { questionId, text } = {}) {
    const session = find(sessionId)
    const entry = session.questions.get(questionId)
    if (!entry) throw new CameraError(404, 'question-not-found', 'That question is no longer in this session. Point the camera at it again.')
    const corrected = editedText(text)
    const asked = corrected ?? entry.text

    if (entry.pending) {
      if (entry.pendingText !== asked) throw new CameraError(409, 'camera-busy', 'That question is still being answered.')
      const shared = await entry.pending
      return { ...shared, cached: true }
    }
    if (entry.answer && entry.answeredText === asked) return { status: 'answered', questionId, answer: entry.answer, markdown: entry.markdown, cached: true }

    entry.pendingText = asked
    entry.pending = (async () => {
      let result
      try {
        result = await ask(entry, asked)
      } catch (err) {
        log(`session ${session.id} answer failed (${err?.statusCode ?? err?.status ?? err?.name ?? 'error'})`)
        throw new CameraError(502, 'answer-failed', 'An answer could not be worked out just now. Try again.')
      }
      requireStill(session)
      const markdown = toMarkdown(result)
      entry.answer = result
      entry.markdown = markdown
      entry.answeredText = asked
      dropPicture(entry) // answered: the picture has done its job
      if (corrected && !sameQuestion(corrected, entry.text)) session.known.push({ questionId, identity: identityText({ text: corrected, options: entry.options }) })
      save(session, asked, entry, markdown)
      log(`session ${session.id} answered ${questionId} (${result.confidence})`)
      return { status: 'answered', questionId, answer: result, markdown }
    })()
    try {
      return await entry.pending
    } finally {
      entry.pending = null
      entry.pendingText = null
    }
  }

  function save(session, asked, entry, markdown) {
    const options = entry.options.map((option, i) => `${option.label || String.fromCharCode(65 + i)}) ${option.text}`)
    sessions.appendMessage(session.id, { role: 'user', content: [asked, ...options].join('\n') })
    sessions.appendMessage(session.id, { role: 'assistant', content: markdown })
  }

  async function clear(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return true
    active.delete(sessionId)
    sessions.forget(sessionId)
    try {
      sessions.getHistory()?.remove(sessionId)
    } catch (err) {
      logger.error(`[camera] session ${sessionId} could not be cleared from the saved history (${err?.name ?? 'error'})`)
      throw new CameraError(500, 'clear-failed', 'The saved history could not be cleared. Try again.')
    }
    log(`session ${sessionId} cleared`)
    return true
  }

  return {
    createSession,
    read,
    answer,
    clear,
    sweep,
    /** The limits in force (the routes size their body parser from these). */
    limits: Object.freeze({ ...cap }),
    /** For tests: how many pictures are being held in memory right now. */
    _retainedPictures() {
      let count = 0
      for (const session of active.values()) for (const entry of session.questions.values()) if (entry.picture) count++
      return count
    }
  }
}
