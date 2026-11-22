import { randomUUID } from 'node:crypto'
import { AcademicError, oneOf, textField } from '../academic/academicError.js'

/**
 * Academic memory in the database (migration 8): a person's courses, their study sessions and what has been learned about how they
 * learn. Like the conversations, everything is reached through `forOwner(userId)`: every statement says `owner_user_id = ?`, so a row
 * that is not theirs does not exist for them (a read is null, a change changes nothing). The triggers of migration 8 back this up by
 * refusing a session or an experience that names someone else's course.
 *
 * The personal learning profile and the academic profile are not tables: they live in `ai_user_settings.settings_json` under their own
 * keys, validated here, so there is one place a person's preferences are kept (see `settings`).
 */

export const SESSION_TYPES = Object.freeze(['study', 'practice', 'restricted'])
export const SESSION_STATUSES = Object.freeze(['active', 'paused', 'ended'])
export const EXPERIENCE_KINDS = Object.freeze(['difficulty', 'correction', 'helpful_explanation', 'improvement', 'feedback'])
export const DIFFICULTIES = Object.freeze(['tentative', 'needs_practice', 'improving'])

export const WRITING_STYLES = Object.freeze(['natural_student_academic', 'concise', 'detailed'])
export const EXPLANATION_LEVELS = Object.freeze(['simple', 'clear_and_accessible', 'advanced'])
export const LEARNING_APPROACHES = Object.freeze(['step_by_step', 'example_first', 'concept_first', 'visual'])
export const STRUCTURE_PARTS = Object.freeze([
  'direct_introduction',
  'developed_explanation',
  'relevant_examples',
  'conclusion_when_appropriate',
  'common_misunderstandings',
  'check_understanding'
])

export const DEFAULT_SETTINGS = Object.freeze({
  learningProfile: Object.freeze({
    writingStyle: 'natural_student_academic',
    explanationLevel: 'clear_and_accessible',
    preferredStructure: Object.freeze(['direct_introduction', 'developed_explanation', 'relevant_examples', 'conclusion_when_appropriate']),
    learningApproach: 'step_by_step',
    language: 'en'
  }),
  academicProfile: Object.freeze({ institution: null, programme: null, academicYear: null, semester: null, verified: false }),
  adaptiveLearning: true
})

const iso = (ms) => new Date(ms).toISOString()
const flag = (value) => (value ? 1 : 0)

function courseOut(row) {
  return row && { id: row.id, code: row.code, title: row.title, institution: row.institution, programme: row.programme, academicYear: row.academic_year, semester: row.semester, verified: row.verified === 1, createdAt: row.created_at, updatedAt: row.updated_at }
}

function experienceOut(row) {
  return (
    row && {
      id: row.id,
      courseId: row.course_id,
      topic: row.topic,
      kind: row.kind,
      difficulty: row.difficulty,
      observedIssue: row.observed_issue,
      helpfulExplanation: row.helpful_explanation,
      confidence: row.confidence,
      evidenceCount: row.evidence_count,
      status: row.status,
      source: row.source,
      retention: row.retention,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastConfirmedAt: row.last_confirmed_at,
      lastReviewedAt: row.last_reviewed_at
    }
  )
}

function sessionOut(row) {
  return (
    row && {
      id: row.id,
      courseId: row.course_id,
      sessionType: row.session_type,
      status: row.status,
      activeTopic: row.active_topic,
      captureEnabled: row.capture_enabled === 1,
      autoAnswer: row.auto_answer === 1,
      useResearch: row.use_research === 1,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      endReason: row.end_reason,
      lastActivityAt: row.last_activity_at,
      expiresAt: row.expires_at
    }
  )
}

/** Merges a patch into the person's settings, keeping only the keys and values this feature knows. Returns the whole, valid settings. */
export function mergeSettings(current, patch) {
  const base = { ...DEFAULT_SETTINGS, ...(current && typeof current === 'object' ? current : {}) }
  const next = {
    ...base,
    learningProfile: { ...DEFAULT_SETTINGS.learningProfile, ...(base.learningProfile ?? {}) },
    academicProfile: { ...DEFAULT_SETTINGS.academicProfile, ...(base.academicProfile ?? {}) }
  }
  if (!patch || typeof patch !== 'object') return next
  const lp = patch.learningProfile
  if (lp !== undefined) {
    if (!lp || typeof lp !== 'object') throw new AcademicError(400, 'invalid-input', 'learningProfile must be an object.')
    if ('writingStyle' in lp) next.learningProfile.writingStyle = oneOf(lp.writingStyle, 'writingStyle', WRITING_STYLES)
    if ('explanationLevel' in lp) next.learningProfile.explanationLevel = oneOf(lp.explanationLevel, 'explanationLevel', EXPLANATION_LEVELS)
    if ('learningApproach' in lp) next.learningProfile.learningApproach = oneOf(lp.learningApproach, 'learningApproach', LEARNING_APPROACHES)
    if ('language' in lp) next.learningProfile.language = textField(lp.language, 'language', { max: 16, required: true })
    if ('preferredStructure' in lp) {
      if (!Array.isArray(lp.preferredStructure) || lp.preferredStructure.length > STRUCTURE_PARTS.length) throw new AcademicError(400, 'invalid-input', 'preferredStructure must be a short list.')
      next.learningProfile.preferredStructure = [...new Set(lp.preferredStructure.map((part) => oneOf(part, 'preferredStructure', STRUCTURE_PARTS)))]
    }
  }
  const ap = patch.academicProfile
  if (ap !== undefined) {
    if (!ap || typeof ap !== 'object') throw new AcademicError(400, 'invalid-input', 'academicProfile must be an object.')
    for (const [key, field] of [['institution', 'institution'], ['programme', 'programme'], ['academicYear', 'academicYear'], ['semester', 'semester']]) {
      if (key in ap) next.academicProfile[key] = textField(ap[key], field, { max: 120 })
    }
    if ('verified' in ap) next.academicProfile.verified = ap.verified === true
  }
  if ('adaptiveLearning' in patch) {
    if (typeof patch.adaptiveLearning !== 'boolean') throw new AcademicError(400, 'invalid-input', 'adaptiveLearning must be true or false.')
    next.adaptiveLearning = patch.adaptiveLearning
  }
  return next
}

export function createAcademicRepository(database, { clock = Date.now, newId = randomUUID } = {}) {
  const now = () => iso(clock())

  const q = {
    courses: database.prepare('SELECT * FROM academic_courses WHERE owner_user_id = ? ORDER BY title COLLATE NOCASE, created_at'),
    course: database.prepare('SELECT * FROM academic_courses WHERE id = ? AND owner_user_id = ?'),
    insertCourse: database.prepare(
      `INSERT INTO academic_courses (id, owner_user_id, code, title, institution, programme, academic_year, semester, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updateCourse: database.prepare(
      `UPDATE academic_courses SET code = ?, title = ?, institution = ?, programme = ?, academic_year = ?, semester = ?, verified = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ?`
    ),
    deleteCourse: database.prepare('DELETE FROM academic_courses WHERE id = ? AND owner_user_id = ?'),
    deleteCourses: database.prepare('DELETE FROM academic_courses WHERE owner_user_id = ?'),

    settings: database.prepare('SELECT settings_json FROM ai_user_settings WHERE user_id = ?'),
    saveSettings: database.prepare(
      `INSERT INTO ai_user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`
    ),

    experiences: database.prepare(
      `SELECT * FROM learning_experiences WHERE owner_user_id = ? AND (? IS NULL OR course_id = ?) AND (? IS NULL OR topic = ?)
        ORDER BY updated_at DESC, id LIMIT ?`
    ),
    experience: database.prepare('SELECT * FROM learning_experiences WHERE id = ? AND owner_user_id = ?'),
    findExperience: database.prepare('SELECT * FROM learning_experiences WHERE owner_user_id = ? AND course_id = ? AND topic = ? AND kind = ?'),
    insertExperience: database.prepare(
      `INSERT INTO learning_experiences (id, owner_user_id, course_id, topic, kind, difficulty, observed_issue, helpful_explanation, confidence,
         evidence_count, status, source, retention, created_at, updated_at, last_confirmed_at, last_reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    saveExperience: database.prepare(
      `UPDATE learning_experiences SET topic = ?, difficulty = ?, observed_issue = ?, helpful_explanation = ?, confidence = ?, evidence_count = ?,
         status = ?, updated_at = ?, last_confirmed_at = ?, last_reviewed_at = ?
        WHERE id = ? AND owner_user_id = ?`
    ),
    deleteExperience: database.prepare('DELETE FROM learning_experiences WHERE id = ? AND owner_user_id = ?'),
    deleteExperiencesOf: database.prepare('DELETE FROM learning_experiences WHERE owner_user_id = ? AND (? IS NULL OR course_id = ?)'),

    insertSession: database.prepare(
      `INSERT INTO academic_sessions (id, owner_user_id, course_id, session_type, status, active_topic, capture_enabled, auto_answer, use_research,
         started_at, last_activity_at, expires_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
    ),
    session: database.prepare('SELECT * FROM academic_sessions WHERE id = ? AND owner_user_id = ?'),
    currentSession: database.prepare(`SELECT * FROM academic_sessions WHERE owner_user_id = ? AND status IN ('active', 'paused') ORDER BY started_at DESC LIMIT 1`),
    recentSessions: database.prepare('SELECT * FROM academic_sessions WHERE owner_user_id = ? ORDER BY started_at DESC LIMIT ?'),
    saveSession: database.prepare(
      `UPDATE academic_sessions SET course_id = ?, status = ?, active_topic = ?, capture_enabled = ?, auto_answer = ?, use_research = ?,
         ended_at = ?, end_reason = ?, last_activity_at = ?, expires_at = ?
        WHERE id = ? AND owner_user_id = ?`
    ),
    endOpenSessions: database.prepare(
      `UPDATE academic_sessions SET status = 'ended', ended_at = ?, end_reason = ?, last_activity_at = ? WHERE owner_user_id = ? AND status IN ('active', 'paused')`
    ),
    deleteSessions: database.prepare('DELETE FROM academic_sessions WHERE owner_user_id = ? AND status = ?'),

    endAllOpen: database.prepare(`UPDATE academic_sessions SET status = 'ended', ended_at = ?, end_reason = ?, last_activity_at = ? WHERE status IN ('active', 'paused')`),
    expireIdle: database.prepare(`UPDATE academic_sessions SET status = 'ended', ended_at = ?, end_reason = 'expired', last_activity_at = ? WHERE status IN ('active', 'paused') AND expires_at < ?`),
    purgeOld: database.prepare(`DELETE FROM academic_sessions WHERE status = 'ended' AND ended_at < ?`)
  }

  function forOwner(userId) {
    if (typeof userId !== 'string' || !userId) throw new Error('forOwner needs a person')

    const settings = {
      /** The whole, valid settings (defaults filled in). */
      get() {
        const row = q.settings.get(userId)
        let stored = {}
        try {
          stored = row ? JSON.parse(row.settings_json) : {}
        } catch {
          stored = {} // a corrupt blob is treated as no preferences, never as an error for the person
        }
        return mergeSettings(stored, null)
      },
      update(patch) {
        const row = q.settings.get(userId)
        let stored = {}
        try {
          stored = row ? JSON.parse(row.settings_json) : {}
        } catch {
          stored = {}
        }
        // Other features may keep their own keys in this blob: only ours are validated and replaced.
        const merged = mergeSettings(stored, patch)
        const keep = stored && typeof stored === 'object' ? stored : {}
        q.saveSettings.run(userId, JSON.stringify({ ...keep, learningProfile: merged.learningProfile, academicProfile: merged.academicProfile, adaptiveLearning: merged.adaptiveLearning }), now())
        return merged
      },
      reset() {
        const row = q.settings.get(userId)
        let keep = {}
        try {
          keep = row ? JSON.parse(row.settings_json) : {}
        } catch {
          keep = {}
        }
        delete keep.learningProfile
        delete keep.academicProfile
        delete keep.adaptiveLearning
        q.saveSettings.run(userId, JSON.stringify(keep), now())
        return mergeSettings({}, null)
      }
    }

    const courses = {
      list: () => q.courses.all(userId).map(courseOut),
      get: (id) => courseOut(q.course.get(String(id), userId)) ?? null,
      create(input = {}) {
        const id = newId()
        const t = now()
        q.insertCourse.run(
          id, userId, textField(input.code, 'code', { max: 40 }), textField(input.title, 'title', { max: 160, required: true }),
          textField(input.institution, 'institution', { max: 120 }), textField(input.programme, 'programme', { max: 120 }),
          textField(input.academicYear, 'academicYear', { max: 40 }), textField(input.semester, 'semester', { max: 40 }), flag(input.verified === true), t, t
        )
        return courses.get(id)
      },
      update(id, patch = {}) {
        const existing = courses.get(id)
        if (!existing) return null
        const pick = (key, field, max) => (key in patch ? textField(patch[key], field, { max }) : existing[key])
        q.updateCourse.run(
          pick('code', 'code', 40), 'title' in patch ? textField(patch.title, 'title', { max: 160, required: true }) : existing.title, pick('institution', 'institution', 120),
          pick('programme', 'programme', 120), pick('academicYear', 'academicYear', 40), pick('semester', 'semester', 40),
          flag('verified' in patch ? patch.verified === true : existing.verified), now(), existing.id, userId
        )
        return courses.get(id)
      },
      /** Deletes the course, and with it its documents and experiences (foreign keys); sessions that named it just lose the course. */
      remove: (id) => q.deleteCourse.run(String(id), userId).changes > 0,
      removeAll: () => q.deleteCourses.run(userId).changes
    }

    const experiences = {
      list({ courseId = null, topic = null, limit = 200 } = {}) {
        return q.experiences.all(userId, courseId, courseId, topic, topic, Math.min(500, Math.max(1, limit))).map(experienceOut)
      },
      get: (id) => experienceOut(q.experience.get(String(id), userId)) ?? null,
      find: ({ courseId, topic, kind }) => experienceOut(q.findExperience.get(userId, courseId, topic, kind)) ?? null,
      /** Inserts a new experience row (the caller, learningMemory.js, decides confidence and difficulty). */
      insert({ courseId, topic, kind, difficulty = null, observedIssue = null, helpfulExplanation = null, confidence, evidenceCount = 1, status = 'active', source, retention = 'learning' }) {
        const id = newId()
        const t = now()
        q.insertExperience.run(
          id, userId, courseId, textField(topic, 'topic', { max: 120, required: true }), oneOf(kind, 'kind', EXPERIENCE_KINDS), oneOf(difficulty, 'difficulty', DIFFICULTIES, { required: false }),
          textField(observedIssue, 'observedIssue', { max: 400 }), textField(helpfulExplanation, 'helpfulExplanation', { max: 400 }), Math.min(1, Math.max(0, Number(confidence))),
          evidenceCount, status, textField(source, 'source', { max: 60, required: true }), retention, t, t, t, null
        )
        return experiences.get(id)
      },
      save(experience) {
        q.saveExperience.run(
          experience.topic, experience.difficulty ?? null, experience.observedIssue ?? null, experience.helpfulExplanation ?? null, experience.confidence,
          experience.evidenceCount, experience.status, now(), experience.lastConfirmedAt ?? null, experience.lastReviewedAt ?? null, experience.id, userId
        )
        return experiences.get(experience.id)
      },
      remove: (id) => q.deleteExperience.run(String(id), userId).changes > 0,
      removeFor: (courseId = null) => q.deleteExperiencesOf.run(userId, courseId, courseId).changes
    }

    const sessions = {
      insert({ courseId = null, sessionType, activeTopic = null, captureEnabled = false, autoAnswer = false, useResearch = false, ttlMs }) {
        const id = newId()
        const t = clock()
        q.insertSession.run(id, userId, courseId, oneOf(sessionType, 'sessionType', SESSION_TYPES), textField(activeTopic, 'topic', { max: 120 }), flag(captureEnabled), flag(autoAnswer), flag(useResearch), iso(t), iso(t), iso(t + ttlMs))
        return sessions.get(id)
      },
      get: (id) => sessionOut(q.session.get(String(id), userId)) ?? null,
      current: () => sessionOut(q.currentSession.get(userId)) ?? null,
      recent: (limit = 10) => q.recentSessions.all(userId, Math.min(50, Math.max(1, limit))).map(sessionOut),
      save(s) {
        q.saveSession.run(s.courseId ?? null, s.status, s.activeTopic ?? null, flag(s.captureEnabled), flag(s.autoAnswer), flag(s.useResearch), s.endedAt ?? null, s.endReason ?? null, s.lastActivityAt, s.expiresAt, s.id, userId)
        return sessions.get(s.id)
      },
      endOpen(reason) {
        const t = now()
        return q.endOpenSessions.run(t, reason, t, userId).changes
      },
      removeEnded: () => q.deleteSessions.run(userId, 'ended').changes
    }

    return { userId, settings, courses, experiences, sessions }
  }

  return {
    forOwner,
    /** At server start: no live connection or held picture survives a restart, so every open session is ended. */
    endAllOpenSessions(reason = 'server-restart') {
      const t = now()
      return q.endAllOpen.run(t, reason, t).changes
    },
    /** Housekeeping: sessions past their expiry end; ended sessions older than the retention are deleted. */
    maintain({ retentionDays = 14 } = {}) {
      const t = now()
      const expired = q.expireIdle.run(t, t, t).changes
      const purged = q.purgeOld.run(iso(clock() - retentionDays * 86_400_000)).changes
      return { expired, purged }
    }
  }
}
