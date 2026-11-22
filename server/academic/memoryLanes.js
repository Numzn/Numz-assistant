import { AcademicError, textField } from './academicError.js'
import { DEFAULT_SETTINGS, DIFFICULTIES } from '../persistence/academicRepository.js'

/**
 * The six memory lanes of Academic Intelligence, as ONE place that knows where each lives. It stores nothing of its own: it is a facade over
 * the stores that already exist, so there is no second memory system to disagree with them.
 *
 *   lane             where it lives                                            owner / retention
 *   profile          ai_user_settings.settings_json  (learningProfile)         the person; until they change or reset it
 *   academic         ai_user_settings (academicProfile) + academic_courses     the person; until they change it
 *   knowledge        academic_documents / academic_chunks (knowledgeRepository) the person, per course; until deleted
 *   conversation     assistant_conversations / assistant_messages (history)    the person; until they delete it (the existing routes)
 *   experience       learning_experiences                                      the person, per course; until deleted or corrected
 *   session          academic_sessions + what the session manager holds        the person; ends with the session, rows purged after N days
 *
 * `forOwner(userId)` is the only way in. A person's memory is never reachable through anyone else's id, and deleting a lane or a course
 * deletes exactly that person's rows.
 */

export const LANES = Object.freeze(['profile', 'academic', 'knowledge', 'conversation', 'experience', 'session'])

export function createMemoryLaneManager({ academic, knowledge = null, conversations = null, sessionManager = null, audit = () => {} } = {}) {
  if (!academic) throw new Error('the academic repository is required')

  function forOwner(userId) {
    const mine = academic.forOwner(userId)
    const theirKnowledge = knowledge ? knowledge.forOwner(userId) : null
    const history = () => conversations?.forOwner?.(userId)?.getHistory?.() ?? null
    const note = (event, detail) => audit(event, { userId, detail })

    const manager = {
      userId,

      // ---- lanes 1 and 2: the profiles ---------------------------------------------------------------------------------
      getProfile: () => mine.settings.get(),
      updateProfile(patch) {
        const settings = mine.settings.update(patch)
        note('academic.profile_update', { keys: Object.keys(patch ?? {}).filter((key) => ['learningProfile', 'academicProfile', 'adaptiveLearning'].includes(key)) })
        return settings
      },
      adaptiveLearningEnabled: () => mine.settings.get().adaptiveLearning !== false,

      // ---- courses (lane 2) ------------------------------------------------------------------------------------------------
      listCourses: () => mine.courses.list(),
      getCourse: (id) => mine.courses.get(id),
      createCourse(input) {
        const course = mine.courses.create(input)
        note('academic.course_create', { courseId: course.id })
        return course
      },
      updateCourse(id, patch) {
        const course = mine.courses.update(id, patch)
        if (course) note('academic.course_update', { courseId: id })
        return course
      },
      /** The course and everything that is about it: its documents and the learning experiences recorded against it. */
      deleteCourse(id) {
        const course = mine.courses.get(id)
        if (!course) return false
        const documents = theirKnowledge ? theirKnowledge.countDocuments({ courseId: course.id }) : 0
        const experiences = mine.experiences.list({ courseId: course.id, limit: 500 }).length
        mine.courses.remove(course.id) // documents, chunks and experiences go with it (foreign keys)
        note('academic.course_delete', { courseId: course.id, documents, experiences })
        return true
      },

      // ---- lane 5: experience ----------------------------------------------------------------------------------------------
      listExperiences: (filter) => mine.experiences.list(filter),
      /** The person corrects a memory about themselves: it is then confirmed (by them), no longer in doubt, and at its most confident. */
      correctExperience(id, patch = {}) {
        const current = mine.experiences.get(id)
        if (!current) return null
        const next = { ...current }
        if ('topic' in patch) next.topic = textField(patch.topic, 'topic', { max: 120, required: true })
        if ('observedIssue' in patch) next.observedIssue = textField(patch.observedIssue, 'observedIssue', { max: 400 })
        if ('helpfulExplanation' in patch) next.helpfulExplanation = textField(patch.helpfulExplanation, 'helpfulExplanation', { max: 400 })
        if ('difficulty' in patch) {
          if (patch.difficulty !== null && !DIFFICULTIES.includes(patch.difficulty)) throw new AcademicError(400, 'invalid-input', `difficulty must be one of: ${DIFFICULTIES.join(', ')}.`)
          next.difficulty = patch.difficulty
        }
        next.status = 'active'
        next.confidence = 0.9
        next.lastConfirmedAt = new Date().toISOString()
        const saved = mine.experiences.save(next)
        note('academic.memory_correct', { experienceId: id })
        return saved
      },
      deleteExperience(id) {
        const removed = mine.experiences.remove(id)
        if (removed) note('academic.memory_delete', { lane: 'experience', experienceId: id })
        return removed
      },

      // ---- lane 6: the session ---------------------------------------------------------------------------------------------
      currentSession: () => mine.sessions.current(),

      // ---- the memory centre -------------------------------------------------------------------------------------------------
      /** What is stored about this person, lane by lane, for them to look at. Never anyone else's, never a picture, never a transcript. */
      inspect() {
        const settings = mine.settings.get()
        const list = history()?.list?.({ limit: 20 })?.conversations ?? []
        return {
          adaptiveLearning: settings.adaptiveLearning !== false,
          lanes: {
            profile: { learningProfile: settings.learningProfile },
            academic: { academicProfile: settings.academicProfile, courses: mine.courses.list() },
            knowledge: { documents: theirKnowledge ? theirKnowledge.listDocuments() : [] },
            conversation: { recent: list.map(({ id, title, updatedAt, messageCount }) => ({ id, title, updatedAt, messageCount })) },
            experience: { items: mine.experiences.list({ limit: 200 }) },
            session: { current: mine.sessions.current(), recent: mine.sessions.recent(10) }
          }
        }
      },

      /** Empties one lane (for one course, where that makes sense). Conversations are deleted through their own routes, as before. */
      deleteLane(lane, { courseId = null, confirmAll = false } = {}) {
        if (!LANES.includes(lane)) throw new AcademicError(400, 'invalid-input', `lane must be one of: ${LANES.join(', ')}.`)
        if (courseId && !mine.courses.get(courseId)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
        let removed = 0
        switch (lane) {
          case 'conversation':
            throw new AcademicError(400, 'use-conversations', 'Conversations are deleted from the conversation list, not here.')
          case 'profile':
            mine.settings.update({ learningProfile: DEFAULT_SETTINGS.learningProfile })
            removed = 1
            break
          case 'academic':
            if (!confirmAll) throw new AcademicError(400, 'confirm-required', 'Deleting the academic profile and every course needs confirm=all.')
            mine.settings.update({ academicProfile: DEFAULT_SETTINGS.academicProfile })
            removed = 1 + mine.courses.removeAll()
            break
          case 'knowledge':
            removed = theirKnowledge ? theirKnowledge.removeDocuments({ courseId }) : 0
            break
          case 'experience':
            removed = mine.experiences.removeFor(courseId)
            break
          case 'session':
            removed = mine.sessions.endOpen('cleared') + mine.sessions.removeEnded()
            sessionManager?.forOwner?.(userId)?.clearRuntime?.()
            break
          default:
            break
        }
        note('academic.memory_delete', { lane, courseId, removed })
        return { lane, removed }
      },

      /** Everything academic about this person, in one go (the conversations are kept: they have their own delete). */
      deleteEverything() {
        const result = {}
        for (const lane of ['experience', 'knowledge', 'session', 'profile']) result[lane] = manager.deleteLane(lane).removed
        result.academic = manager.deleteLane('academic', { confirmAll: true }).removed
        mine.settings.update({ adaptiveLearning: DEFAULT_SETTINGS.adaptiveLearning })
        return result
      },

      /** The person's academic notes, to keep. `documents: 'full'` includes the text of their own course materials. */
      exportAll({ documents = 'list' } = {}) {
        const settings = mine.settings.get()
        note('academic.export', { documents })
        return {
          exportedAt: new Date().toISOString(),
          learningProfile: settings.learningProfile,
          academicProfile: settings.academicProfile,
          adaptiveLearning: settings.adaptiveLearning !== false,
          courses: mine.courses.list(),
          experiences: mine.experiences.list({ limit: 500 }),
          documents: theirKnowledge ? (documents === 'full' ? theirKnowledge.exportDocuments() : theirKnowledge.listDocuments()) : []
        }
      }
    }
    return manager
  }

  return { forOwner }
}
