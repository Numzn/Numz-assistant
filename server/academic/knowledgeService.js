import { AcademicError } from './academicError.js'

/**
 * Lane 3, knowledge: finding what a person's own course materials say about a question, and turning a finished lecture into course
 * material. It stores nothing itself (see persistence/knowledgeRepository.js); it decides WHICH courses a search may look in and labels
 * what comes back so an answer can cite it.
 *
 * Course isolation: a search looks in the course it is asked about and nowhere else. Another of the person's courses is searched only
 * when the caller names it AND gives a reason (the reason travels with the evidence, so the answer can say why it went there). Another
 * person's course is never searched: the repository drops any course id that is not theirs.
 */

const MIN_REASON = 8

export function createKnowledgeService({ knowledge, meetingService = null, pause } = {}) {
  if (!knowledge) throw new Error('the knowledge repository is required')

  // Large documents are cut and indexed one at a time, in the background, so that a batch of them does not compete with itself (or with
  // the rest of the server) for the one database connection and for memory. The queue holds ids only; the text is in the database.
  let tail = Promise.resolve()
  let waiting = 0
  const enqueue = (work) => {
    waiting += 1
    const run = tail.then(work, work).finally(() => (waiting -= 1))
    tail = run.catch(() => {})
    return run
  }

  function forOwner(userId) {
    const mine = knowledge.forOwner(userId)

    return {
      userId,

      /**
       * Cuts and indexes a stored document in the background (after the request that stored it has been answered). Documents are processed one
       * at a time in the order they were queued. `onSettled(document)` is called with the finished document ('ready' or 'failed').
       * -> a promise that settles when this one is done (callers do not need to wait for it)
       */
      process(documentId, { onSettled = null } = {}) {
        return enqueue(async () => {
          const document = await mine.processDocument(documentId, pause ? { pause } : {})
          try {
            onSettled?.(document)
          } catch {
            /* reporting must not stop the queue */
          }
          return document
        })
      },

      /** A failed document is queued again. -> the document, 'processing' again */
      retry(documentId, options = {}) {
        const document = mine.retryDocument(documentId)
        this.process(document.id, options)
        return document
      },

      /**
       * @returns {{ passages: object[], crossCourse: boolean, reason: string|null }}
       * Each passage: { label: 'S1', documentId, title, version, sourceType, headingPath, locator, text, courseId, crossCourse }.
       */
      retrieve({ courseId, query, topic = '', alsoCourseIds = [], reason = '', limit = 6 }) {
        const also = [...new Set((Array.isArray(alsoCourseIds) ? alsoCourseIds : []).map(String))].filter((id) => id && id !== String(courseId))
        const why = String(reason ?? '').trim()
        if (also.length > 0 && why.length < MIN_REASON) {
          throw new AcademicError(400, 'cross-course-needs-reason', 'Looking in another course needs a reason, so it can be explained in the answer.')
        }
        if (!courseId && also.length === 0) return { passages: [], crossCourse: false, reason: null }
        const ids = [...(courseId ? [String(courseId)] : []), ...also]
        const rows = mine.search({ courseIds: ids, query: `${topic} ${query}`, limit })
        const passages = rows.map((row, i) => ({
          label: `S${i + 1}`,
          documentId: row.documentId,
          title: row.title,
          version: row.version,
          sourceType: row.sourceType,
          headingPath: row.headingPath,
          locator: row.locator,
          text: row.text,
          courseId: row.courseId,
          crossCourse: row.courseId !== String(courseId)
        }))
        const crossCourse = passages.some((p) => p.crossCourse)
        return { passages, crossCourse, reason: crossCourse ? why : null }
      },

      /** The person's own finished lectures, newest first, for them to choose from. Never anyone else's, never an unowned one. */
      listLectures() {
        if (!meetingService?.listMeetingsOwnedBy) return []
        return meetingService
          .listMeetingsOwnedBy(userId, { limit: 100 })
          .filter((m) => m.status === 'COMPLETED')
          .map((m) => ({ meetingId: m.meetingId, title: m.metadata?.title ?? null, createdAt: m.createdAt, endedAt: m.endedAt }))
      },

      /** A finished lecture of the person's own becomes material for one of their courses (re-doing it replaces the earlier version). */
      ingestMeeting({ meetingId, courseId, title = null }) {
        if (!meetingService) throw new AcademicError(503, 'meetings-unavailable', 'Lectures cannot be added on this server.')
        const id = String(meetingId ?? '')
        let meeting = null
        try {
          meeting = meetingService.getMeeting(id)
        } catch {
          meeting = null
        }
        // Someone else's meeting, an unowned one and one that does not exist look the same: not found.
        if (!meeting || meetingService.getMeetingOwner(id) !== userId) throw new AcademicError(404, 'meeting-not-found', 'That meeting is not one of yours.')
        if (meeting.status !== 'COMPLETED') throw new AcademicError(409, 'meeting-not-finished', 'Only a finished lecture can be added to a course. End the meeting first.')
        const segments = meetingService.getTranscript(id)
        const name = (typeof title === 'string' && title.trim()) || meeting.metadata?.title || `Lecture ${String(meeting.createdAt).slice(0, 10)}`
        return mine.addTranscript({ courseId, title: name, sourceRef: `meeting:${id}`, segments })
      }
    }
  }

  return {
    forOwner,
    /** How many documents are waiting for, or in, the background processing (for tests and for the server's own log). */
    queued: () => waiting,
    /** Resolves when everything queued so far has been processed. */
    idle: () => tail.then(() => undefined)
  }
}
