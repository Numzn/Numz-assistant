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

export function createKnowledgeService({ knowledge, meetingService = null }) {
  if (!knowledge) throw new Error('the knowledge repository is required')

  function forOwner(userId) {
    const mine = knowledge.forOwner(userId)

    return {
      userId,

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

  return { forOwner }
}
