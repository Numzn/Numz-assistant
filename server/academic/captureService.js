import { createHash, randomUUID } from 'node:crypto'
import { AcademicError } from './academicError.js'
import { enforce } from './integrity.js'
import { resolveContext } from './contextResolver.js'
import { buildReadMessages, classifyTask, judgeReading, parseAcademicReading, readingSignals } from './questionUnderstanding.js'
import { findKnownQuestion, identityText } from '../camera/questionIdentity.js'
import { imageInfo } from '../screenshots/imageInfo.js'

/**
 * Hybrid screen reading for a study session. The LOCAL half is the desktop app's: it takes a still at a modest rate, notices a meaningful
 * change on the machine, and sends a picture only when the screen has changed and settled. This is the CLOUD half: it checks that the
 * person's session allows it, reads the picture with the vision model, and turns what it saw into questions the person can be offered.
 *
 * It enforces, in this order and before any model is asked: the integrity gate (a restricted, paused, ended or expired session reads
 * nothing), the session's own capture switch, the picture's kind and size, a minimum gap between reads, a cap per session, the same
 * picture twice, one read at a time, and the person's daily allowance of study reads (`academic_read`). The picture is read once and dropped;
 * only a picture with a diagram is kept (in memory, two minutes) so the answer can look at the figure.
 *
 * What a capture yields is held in the session's memory only: questions with an id, the course they seem to belong to, and what they are.
 */

export const CAPTURE_LIMITS = Object.freeze({
  maxImageBytes: 4_000_000,
  maxPixels: 36_000_000,
  minSide: 64,
  minReadIntervalMs: 8000,
  maxReadsPerSession: 80,
  diagramKeptMs: 2 * 60_000,
  modelTimeoutMs: 45_000
})

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function createCaptureService({ vision, sessionManager, courses, now = Date.now, newId = randomUUID, limits = {}, logger = console }) {
  const cap = { ...CAPTURE_LIMITS, ...limits }
  const log = (message) => logger.info?.(`[academic] ${message}`)

  function withDeadline(run) {
    const controller = new AbortController()
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(Object.assign(new Error('The vision service did not answer in time'), { name: 'TimeoutError' }))
      }, cap.modelTimeoutMs)
    })
    return Promise.race([Promise.resolve().then(() => run(controller.signal)), deadline]).finally(() => clearTimeout(timer))
  }

  function sweepPictures(runtime) {
    for (const entry of runtime.captures.values()) if (entry.picture && entry.picture.expiresAt <= now()) entry.picture = null
  }

  function forOwner(userId) {
    const sessions = sessionManager.forOwner(userId)
    const mine = courses(userId)

    return {
      /**
       * @returns {Promise<{ captureId, status: 'recognised'|'duplicate'|'no-question'|'not-academic'|'unclear', contentKind?, questions: object[], context: object, signals: string[] }>}
       */
      async read(sessionId, picture, ctx = {}) {
        const session = sessions.requireOpen(sessionId)
        enforce({ session, action: 'capture', now: now() })
        if (!session.captureEnabled) throw new AcademicError(409, 'capture-off', 'Screen reading is switched off for this session.')

        const bytes = picture?.bytes
        if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new AcademicError(400, 'invalid-image', 'That is not a picture that can be read.')
        if (bytes.length > cap.maxImageBytes) throw new AcademicError(413, 'image-too-large', 'That picture is too large.')
        const info = imageInfo(bytes)
        if (!info) throw new AcademicError(400, 'invalid-image', 'Only PNG, JPEG and WebP pictures can be read.')
        if (info.width < cap.minSide || info.height < cap.minSide || info.width * info.height > cap.maxPixels) throw new AcademicError(400, 'invalid-image', 'That picture is the wrong size to read.')
        if (!vision?.configured) throw new AcademicError(503, 'vision-not-configured', 'Reading pictures is not set up on this server yet.')

        const runtime = sessions.runtime(sessionId)
        sweepPictures(runtime)
        const t = now()
        const digest = sha(bytes)
        if (runtime.pictureHashes.has(digest)) return { captureId: runtime.pictureHashes.get(digest), status: 'duplicate', questions: [], context: null, signals: [], reason: 'That is the picture that was just read.' }
        if (runtime.busy) throw new AcademicError(409, 'capture-busy', 'The last screen is still being read.', { retryAfterSeconds: 2 })
        if (runtime.reads >= cap.maxReadsPerSession) throw new AcademicError(429, 'session-limit', 'This study session has read as many screens as it is allowed. Start a new session.')
        if (runtime.lastReadAt !== null && t - runtime.lastReadAt < cap.minReadIntervalMs) {
          throw new AcademicError(429, 'capture-rate-limited', 'Screens are coming too fast.', { retryAfterSeconds: (cap.minReadIntervalMs - (t - runtime.lastReadAt)) / 1000 })
        }

        // The person's own allowance (and the emergency stop) before the picture goes anywhere.
        const call = ctx.meter?.begin(ctx.identity, 'academic_read', { requestId: ctx.requestId })
        runtime.busy = true
        runtime.lastReadAt = t
        runtime.reads++
        let raw
        try {
          raw = await withDeadline((signal) => vision.read({ messages: buildReadMessages(), image: { bytes: Buffer.from(bytes), mimeType: info.mimeType }, signal, onUsage: call?.usage }))
          call?.finish({ images: 1, provider: vision?.name })
        } catch (err) {
          call?.fail(err)
          log(`session ${sessionId} read failed (${err?.statusCode ?? err?.status ?? err?.name ?? 'error'})`)
          throw new AcademicError(502, 'read-failed', 'The screen could not be read just now. It will be tried again when it changes.')
        } finally {
          runtime.busy = false
        }
        sessions.touch(sessionId)

        const parsed = parseAcademicReading(raw)
        const captureId = newId()
        runtime.pictureHashes.set(digest, captureId)
        if (!parsed.ok) return { captureId, status: 'unclear', questions: [], context: null, signals: [], reason: 'The screen could not be understood.' }
        const { reading } = parsed
        const verdict = judgeReading(reading)
        const context = resolveContext({ session, courses: mine.list(), reading })
        const signals = readingSignals(reading)
        if (verdict.status !== 'recognised') {
          runtime.captures.set(captureId, { id: captureId, status: verdict.status, picture: null })
          return { captureId, status: verdict.status, contentKind: reading.contentKind, questions: [], context, signals, reason: verdict.reason }
        }

        const questions = reading.questions.map((q) => {
          const identity = identityText(q)
          const known = findKnownQuestion(identity, runtime.known)
          if (known) return { id: known.questionId, duplicate: true, text: q.text, options: q.options, marks: q.marks, type: q.type, task: classifyTask(q), hasDiagram: q.hasDiagram }
          const id = newId()
          const entry = { id, captureId, text: q.text, options: q.options, marks: q.marks, type: q.type, hasDiagram: q.hasDiagram, task: classifyTask(q), subject: reading.subject, topic: reading.topic, contentKind: reading.contentKind, instructions: reading.instructions, contextSnapshot: context, signals, confirmedPractice: false, answer: null, createdAt: now() }
          runtime.questions.set(id, entry)
          runtime.known.push({ questionId: id, identity })
          return { id, duplicate: false, text: q.text, options: q.options, marks: q.marks, type: q.type, task: entry.task, hasDiagram: q.hasDiagram }
        })
        const keepsPicture = questions.some((q) => q.hasDiagram && !q.duplicate)
        runtime.captures.set(captureId, { id: captureId, status: 'recognised', picture: keepsPicture ? { bytes: Buffer.from(bytes), mimeType: info.mimeType, expiresAt: t + cap.diagramKeptMs } : null })
        log(`session ${sessionId} read: ${verdict.status}, ${questions.length} question(s)`)
        return { captureId, status: questions.every((q) => q.duplicate) ? 'duplicate' : 'recognised', contentKind: reading.contentKind, subject: reading.subject, topic: reading.topic, questions, context, signals, instructions: reading.instructions }
      },

      /** The questions recognised so far in the session (newest last), for the page to list. */
      questions(sessionId) {
        sessions.requireOpen(sessionId)
        const runtime = sessions.runtime(sessionId)
        return [...runtime.questions.values()].map((q) => ({ id: q.id, text: q.text, options: q.options, marks: q.marks, type: q.type, task: q.task, hasDiagram: q.hasDiagram, subject: q.subject, topic: q.topic, signals: q.signals, answered: Boolean(q.answer), createdAt: q.createdAt }))
      }
    }
  }

  return { forOwner }
}
