import { AcademicError, oneOf, textField } from './academicError.js'
import { contentWords } from '../intelligence/grounding.js'

/**
 * Lane 5, experience and learning memory: what has been learned about how THIS student learns a topic of THIS course, from what they
 * tell us, never from guesses about them. Only explicit feedback writes here (a helpful explanation, one that did not help, a correction,
 * a misunderstanding); an ordinary question and answer never does, so not every interaction becomes permanent memory.
 *
 * The rules are deterministic and deliberately cautious:
 *  - One bad moment is a hint, not a label: a first difficulty is `tentative` with low confidence; it becomes `needs_practice` only when
 *    it has been seen twice within 30 days. Two helpful explanations after a difficulty make it `improving`.
 *  - Confidence rises with repeated evidence and is capped; it is shown with where it came from (source), when it was created, last
 *    confirmed and last updated, and its course.
 *  - Evidence against a well-established memory (3+ observations, confidence 0.7+) does not silently overwrite it: the memory is marked
 *    `needs_reassessment` and the new event is kept beside it.
 *  - What the student corrects outranks what was inferred, and their explicit request in the current question outranks all of it
 *    (the response engine puts the current instruction first).
 *  - If the student turns adaptive learning off, nothing is recorded and nothing is used.
 */

const DAY = 86_400_000
const BASE = { difficulty: 0.35, misunderstanding: 0.45, helpful_explanation: 0.5, improvement: 0.5, correction: 0.7 }
const APPROACHES = ['step_by_step', 'example_first', 'concept_first', 'visual', 'simpler', 'deeper']
export const FEEDBACK_KINDS = Object.freeze(['helpful', 'not_helpful', 'correction', 'misunderstanding'])

const confidenceFor = (base, evidence) => Math.round(Math.min(0.95, base + 0.12 * (evidence - 1)) * 100) / 100
const established = (e) => e && e.evidenceCount >= 3 && e.confidence >= 0.7
const topicWords = (topic) => new Set(contentWords(topic))

export function createLearningMemory({ academic, userId, clock = Date.now, audit = () => {} }) {
  const mine = academic.forOwner(userId)
  const adaptive = () => mine.settings.get().adaptiveLearning !== false
  const iso = () => new Date(clock()).toISOString()

  function upsert({ courseId, topic, kind, difficulty = null, observedIssue = null, helpfulExplanation = null, base, source }) {
    const existing = mine.experiences.find({ courseId, topic, kind })
    if (!existing) {
      return mine.experiences.insert({ courseId, topic, kind, difficulty, observedIssue, helpfulExplanation, confidence: confidenceFor(base, 1), evidenceCount: 1, source })
    }
    const evidence = existing.evidenceCount + 1
    return mine.experiences.save({
      ...existing,
      observedIssue: observedIssue ?? existing.observedIssue,
      helpfulExplanation: helpfulExplanation ?? existing.helpfulExplanation,
      difficulty: difficulty ?? existing.difficulty,
      evidenceCount: evidence,
      confidence: confidenceFor(base, evidence),
      status: 'active',
      lastConfirmedAt: iso()
    })
  }

  return {
    adaptiveEnabled: adaptive,

    /**
     * @param {{ kind: 'helpful'|'not_helpful'|'correction'|'misunderstanding', courseId: string, topic: string, note?: string, approach?: string }} input
     * @returns {{ recorded: boolean, reason?: string, experience?: object }}
     */
    recordFeedback({ kind, courseId, topic, note = null, approach = null }) {
      oneOf(kind, 'kind', FEEDBACK_KINDS)
      if (!adaptive()) return { recorded: false, reason: 'adaptive-learning-off' }
      if (!courseId) return { recorded: false, reason: 'no-course' }
      if (!mine.courses.get(courseId)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
      const cleanTopic = textField(topic, 'topic', { max: 120, required: true })
      const cleanNote = textField(note, 'note', { max: 400 })
      const how = approach === null || approach === undefined ? null : oneOf(approach, 'approach', APPROACHES)
      const now = clock()
      const difficultyRow = mine.experiences.find({ courseId, topic: cleanTopic, kind: 'difficulty' })
      const improvementRow = mine.experiences.find({ courseId, topic: cleanTopic, kind: 'improvement' })
      let experience

      if (kind === 'helpful') {
        experience = upsert({ courseId, topic: cleanTopic, kind: 'helpful_explanation', helpfulExplanation: [how, cleanNote].filter(Boolean).join(': ') || 'explanation helped', base: BASE.helpful_explanation, source: 'feedback:helpful' })
        if (difficultyRow) {
          if (established(difficultyRow)) mine.experiences.save({ ...difficultyRow, status: 'needs_reassessment' }) // new evidence against a settled memory: look again, do not overwrite
          else {
            const improving = upsert({ courseId, topic: cleanTopic, kind: 'improvement', base: BASE.improvement, source: 'feedback:helpful' })
            if (improving.evidenceCount >= 2) mine.experiences.save({ ...mine.experiences.find({ courseId, topic: cleanTopic, kind: 'difficulty' }), difficulty: 'improving' })
          }
        }
      } else if (kind === 'correction') {
        experience = upsert({ courseId, topic: cleanTopic, kind: 'correction', observedIssue: cleanNote ?? 'the student corrected an answer', base: BASE.correction, source: 'feedback:correction' })
      } else {
        const base = kind === 'misunderstanding' ? BASE.misunderstanding : BASE.difficulty
        const recent = difficultyRow && now - Date.parse(difficultyRow.updatedAt) <= 30 * DAY
        if (improvementRow && established(improvementRow)) mine.experiences.save({ ...improvementRow, status: 'needs_reassessment' })
        experience = upsert({
          courseId,
          topic: cleanTopic,
          kind: 'difficulty',
          difficulty: difficultyRow && recent ? 'needs_practice' : difficultyRow?.difficulty === 'needs_practice' ? 'needs_practice' : 'tentative',
          observedIssue: cleanNote ?? (kind === 'misunderstanding' ? 'a misunderstanding was pointed out' : 'the explanation did not help'),
          base,
          source: `feedback:${kind}`
        })
      }
      audit('academic.memory_record', { userId, detail: { kind, courseId, experienceId: experience.id, evidence: experience.evidenceCount } })
      return { recorded: true, experience }
    },

    /** What to tell the model about this student and this topic: corrections first, then by confidence and recency; nothing when learning is off. */
    relevantExperiences({ courseId, topic = '', limit = 3 }) {
      if (!adaptive() || !courseId) return []
      const wanted = topicWords(topic)
      const rows = mine.experiences.list({ courseId, limit: 200 }).filter((e) => e.confidence >= 0.3)
      const related = rows.filter((e) => {
        if (wanted.size === 0) return false
        const words = topicWords(e.topic)
        return [...words].some((w) => wanted.has(w))
      })
      const rank = (e) => (e.kind === 'correction' ? 2 : 0) + e.confidence + Math.max(0, 1 - (clock() - Date.parse(e.updatedAt)) / (90 * DAY)) * 0.3
      return related.sort((a, b) => rank(b) - rank(a)).slice(0, limit)
    },

    /** Per topic: where the student is, what has helped, and what is worth reviewing next. Derived from lane 5 only. */
    progress({ courseId = null } = {}) {
      const rows = mine.experiences.list({ courseId, limit: 500 })
      const topics = new Map()
      for (const e of rows) {
        const key = `${e.courseId}\u0000${e.topic.toLowerCase()}`
        if (!topics.has(key)) topics.set(key, { courseId: e.courseId, topic: e.topic, difficulty: null, improving: false, helpful: [], corrections: 0, evidence: 0, confidence: 0, status: 'active', lastActivityAt: e.updatedAt, lastReviewedAt: null, experienceIds: [] })
        const t = topics.get(key)
        t.experienceIds.push(e.id)
        t.evidence += e.evidenceCount
        t.confidence = Math.max(t.confidence, e.confidence)
        if (e.status === 'needs_reassessment') t.status = 'needs_reassessment'
        if (e.updatedAt > t.lastActivityAt) t.lastActivityAt = e.updatedAt
        if (e.lastReviewedAt && (!t.lastReviewedAt || e.lastReviewedAt > t.lastReviewedAt)) t.lastReviewedAt = e.lastReviewedAt
        if (e.kind === 'difficulty') t.difficulty = e.difficulty
        if (e.kind === 'improvement' && e.evidenceCount >= 2) t.improving = true
        if (e.kind === 'helpful_explanation' && e.helpfulExplanation) t.helpful.push(e.helpfulExplanation)
        if (e.kind === 'correction') t.corrections += e.evidenceCount
      }
      const list = [...topics.values()].map((t) => ({ ...t, difficulty: t.improving && t.difficulty ? 'improving' : t.difficulty }))
      const review = list.filter((t) => t.difficulty === 'needs_practice' || t.status === 'needs_reassessment').sort((a, b) => (a.lastReviewedAt ?? '').localeCompare(b.lastReviewedAt ?? '') || a.lastActivityAt.localeCompare(b.lastActivityAt))
      return { adaptiveLearning: adaptive(), topics: list.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)), suggestedReview: review.slice(0, 5).map((t) => ({ courseId: t.courseId, topic: t.topic, why: t.status === 'needs_reassessment' ? 'what we noted about this topic may be out of date' : 'came up more than once as hard' })) }
    },

    /** The student went back over a topic: it is stamped as reviewed (it stops topping the review list). */
    markReviewed(experienceId) {
      const e = mine.experiences.get(experienceId)
      if (!e) return null
      return mine.experiences.save({ ...e, lastReviewedAt: iso() })
    }
  }
}
