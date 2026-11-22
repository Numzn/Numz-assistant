import { randomUUID } from 'node:crypto'
import { AcademicError, textField } from './academicError.js'
import { classifyTask } from './questionUnderstanding.js'
import { enforce } from './integrity.js'
import { buildMessages, sourcesBlock, verifyCitations } from './responseEngine.js'
import { deriveQuery } from './researchService.js'

/**
 * Answering a question inside a study session: the one pipeline every academic answer goes through, in a fixed order that puts the
 * application's controls BEFORE the model:
 *
 *   1  the session is open and its declared type allows answering          (integrity.js: a restricted session ends here)
 *   2  the question has a course (or the person is asked which)
 *   3  a screen that says it is an examination makes the person confirm what kind of session this is (it never switches the type)
 *   4  evidence: the course's materials (course-isolated), then research if the session wants it
 *   5  memory: the learning profile and the few learning notes that matter to this topic (nothing if adaptive learning is off)
 *   6  the person's own daily allowance of answers (and the emergency stop)
 *   7  the model, with an explicit system message
 *   8  the citations are verified and the source list is built from our records
 *   9  the exchange is added to the conversation the person has open (their ordinary NUMZ AI conversation)
 *
 * Conceptual explanations (`explainConcept`) are the one thing a restricted session may ask for: a named concept, never a pasted question.
 */

const MODEL_TIMEOUT_MS = 60_000
const MAX_QUESTION = 2000

const withDeadline = (run, ms) => {
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(Object.assign(new Error('The model did not answer in time'), { name: 'TimeoutError' }))
    }, ms)
  })
  return Promise.race([Promise.resolve().then(() => run(controller.signal)), deadline]).finally(() => clearTimeout(timer))
}

/** A concept is a short phrase. A pasted question (long, with options, or asking something at length) is refused in a restricted session. */
export function looksLikeQuestion(text) {
  const t = String(text ?? '').trim()
  const words = t.split(/\s+/).filter(Boolean).length
  return words > 12 || t.length > 120 || /^\s*[A-Da-d][).]\s+\S/m.test(t) || /\n/.test(t) || (/\?\s*$/.test(t) && words > 8) || /\b(calculate|solve|work out)\b.*\d/i.test(t)
}

export function createAnswerService({ generate, knowledgeService, lanes, sessionManager, researchService = null, conversations, courses, now = Date.now, newId = randomUUID, audit = () => {}, logger = console }) {
  if (typeof generate !== 'function') throw new Error('a model call is required')

  function forOwner(userId) {
    const sessions = sessionManager.forOwner(userId)
    const memory = lanes.forOwner(userId)
    const knowledge = knowledgeService.forOwner(userId)
    const research = researchService?.forOwner(userId) ?? null
    const note = (event, detail) => audit(event, { userId, detail })

    function appendToConversation(conversationId, userText, assistantText) {
      if (!conversationId) return false
      const view = conversations.forOwner(userId)
      if (!view.getSession(conversationId)) throw new AcademicError(404, 'conversation-not-found', 'That conversation is no longer open. Start a new chat and ask again.')
      view.appendMessage(conversationId, { role: 'user', content: userText })
      view.appendMessage(conversationId, { role: 'assistant', content: assistantText })
      return true
    }

    /** Runs the pipeline for an entry (a recognised question held in the session, or one typed). */
    async function run({ session, entry, mode, courseId, courseTitle, conversationId, style, instruction, useResearch, ctx }) {
      const profile = memory.getProfile().learningProfile
      const topic = entry.topic || session.activeTopic || ''
      const retrieval = courseId ? knowledge.retrieve({ courseId, query: entry.text, topic }) : { passages: [], crossCourse: false, reason: null }
      let works = []
      let researchNote = null
      if (useResearch && research && mode !== 'conceptual') {
        try {
          works = (await research.search({ query: deriveQuery(topic, entry.text), limit: 3 })).works
        } catch (err) {
          if (!(err instanceof AcademicError)) throw err
          researchNote = { code: err.code, message: err.message }
        }
      }
      const experiences = memory.relevantExperiences({ courseId, topic })
      const picture = entry.captureId ? sessions.runtime(session.id).captures.get(entry.captureId)?.picture : null
      const related = entry.segmentId ? sessions.runtime(session.id).ledger?.relatedTo(entry.segmentId) ?? [] : []
      const figureNote = entry.hasDiagram && !picture ? 'The question refers to a figure or table that could not be shown: say that part of the answer may be incomplete.' : ''
      const messages = buildMessages({ mode, task: entry.task, question: entry, marks: entry.marks, instructions: entry.instructions, courseTitle, topic, passages: retrieval.passages, research: works, crossCourseReason: retrieval.reason, instruction, experiences, profile, style, figureNote, related })

      const call = ctx.meter?.begin(ctx.identity, 'academic_answer', { requestId: ctx.requestId, conversationId })
      let raw
      try {
        raw = await withDeadline((signal) => generate(messages, { signal, onUsage: call?.usage }), MODEL_TIMEOUT_MS)
        call?.finish()
      } catch (err) {
        call?.fail(err)
        logger.warn?.(`[academic] answer failed (${err?.statusCode ?? err?.status ?? err?.name ?? 'error'})`)
        throw new AcademicError(502, 'answer-failed', 'An answer could not be worked out just now. Try again.')
      }
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (!text) throw new AcademicError(502, 'answer-failed', 'The assistant sent back nothing to show. Try again.')

      const labels = [...retrieval.passages.map((p) => p.label), ...works.map((w) => w.label)]
      const checked = verifyCitations(text, labels)
      const sources = sourcesBlock(checked.cited, retrieval.passages, works)
      const markdown = sources ? `${checked.text}\n\n${sources}` : checked.text
      const citedCourse = checked.cited.filter((l) => l.startsWith('S')).length
      const citedResearch = checked.cited.filter((l) => l.startsWith('R')).length
      const grounding = citedCourse && citedResearch ? 'both' : citedCourse ? 'course' : citedResearch ? 'research' : 'general'
      return {
        markdown,
        grounding,
        sources: checked.cited.map((label) => {
          const p = retrieval.passages.find((x) => x.label === label)
          const r = works.find((x) => x.label === label)
          return p ? { label, kind: 'course', title: p.title, version: p.version, section: p.headingPath, where: p.locator, crossCourse: p.crossCourse } : { label, kind: 'research', title: r.title, authors: r.authors, year: r.year, doi: r.doi, url: r.url, verified: r.verified }
        }),
        evidence: { course: retrieval.passages.length, research: works.length, crossCourse: retrieval.crossCourse, learningNotes: experiences.length },
        flags: { droppedCitations: checked.dropped, uncitedDespiteEvidence: labels.length > 0 && checked.cited.length === 0, researchUnavailable: researchNote, figureMissing: Boolean(figureNote) },
        approach: style ?? profile.learningApproach,
        topic
      }
    }

    function resolveCourse(session, entry, explicitCourseId) {
      if (explicitCourseId) {
        const course = courses(userId).get(explicitCourseId)
        if (!course) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
        return { courseId: course.id, title: course.title, clarification: null }
      }
      const context = entry.contextSnapshot
      const id = context?.courseId ?? session.courseId ?? null
      if (id) return { courseId: id, title: courses(userId).get(id)?.title ?? '', clarification: null }
      if (context?.needsClarification) return { courseId: null, title: '', clarification: context.candidates }
      return { courseId: null, title: '', clarification: null }
    }

    const service = {
      /**
       * Answer a question recognised from the screen (`questionId`) or typed by the person (`text`).
       * @returns {Promise<object>} { status: 'answered', answerId, questionId, markdown, grounding, sources, evidence, flags, ... }
       *   or { status: 'confirm-required', signals } or { status: 'needs-course', candidates }
       */
      async answer({ sessionId, questionId = null, text = null, conversationId = null, courseId = null, topic = null, style = null, instruction = null, confirmPractice = false, useResearch = null }, ctx = {}) {
        const session = sessions.requireOpen(sessionId)
        const verdict = enforce({ session, action: 'answer', now: now() })
        if (style !== null && !['simpler', 'deeper'].includes(style)) throw new AcademicError(400, 'invalid-input', 'style must be simpler or deeper.')
        const runtime = sessions.runtime(sessionId)
        let entry
        if (questionId) {
          entry = runtime.questions.get(String(questionId))
          if (!entry) throw new AcademicError(404, 'question-not-found', 'That question is no longer in this session. Read the screen again.')
        } else {
          const typed = textField(text, 'text', { max: MAX_QUESTION, required: true })
          entry = { id: newId(), text: typed, options: [], marks: null, type: 'other', hasDiagram: false, task: classifyTask({ text: typed }), subject: '', topic: textField(topic, 'topic', { max: 120 }) ?? '', contentKind: 'typed', instructions: '', contextSnapshot: null, signals: [], confirmedPractice: false, answer: null, createdAt: now() }
          runtime.questions.set(entry.id, entry)
        }
        const course = resolveCourse(session, entry, courseId)
        if (course.clarification) return { status: 'needs-course', questionId: entry.id, candidates: course.clarification, message: 'Which course is this question from?' }

        if (entry.signals.length > 0 && !entry.confirmedPractice) {
          if (confirmPractice !== true) {
            note('academic.integrity_flag', { sessionId, questionId: entry.id, signals: entry.signals })
            return { status: 'confirm-required', questionId: entry.id, signals: entry.signals, message: 'This screen looks like it may be a formal assessment. If it is one that does not allow help, do not continue: end this session and start a restricted one. If this is practice, confirm it and NUMZ AI will carry on.' }
          }
          entry.confirmedPractice = true
          note('academic.integrity_confirm', { sessionId, questionId: entry.id, signals: entry.signals })
        }

        sessions.touch(sessionId)
        const result = await run({ session, entry, mode: verdict.mode, courseId: course.courseId, courseTitle: course.title, conversationId, style, instruction: textField(instruction, 'instruction', { max: 500 }), useResearch: useResearch ?? session.useResearch, ctx })
        const answerId = newId()
        entry.answer = { answerId, grounding: result.grounding, approach: result.approach, topic: result.topic, courseId: course.courseId }
        const shown = entry.options?.length ? `${entry.text}\n${entry.options.map((o) => `${o.label}) ${o.text}`).join('\n')}` : entry.text
        const saved = appendToConversation(conversationId, shown, result.markdown)
        note('academic.answer', { sessionId, questionId: entry.id, grounding: result.grounding, course: result.evidence.course, research: result.evidence.research, style })
        return { status: 'answered', answerId, questionId: entry.id, courseId: course.courseId, task: entry.task, savedToConversation: saved, ...result }
      },

      /**
       * Teaching a concept in general terms. This is what a restricted session may ask for. In a restricted session the concept must be a
       * short phrase: a pasted question is refused, because answering it would be answering the assessment.
       */
      async explainConcept({ sessionId, concept, conversationId = null, courseId = null, style = null }, ctx = {}) {
        const session = sessions.requireOpen(sessionId)
        const verdict = enforce({ session, action: 'explain_concept', now: now() })
        const phrase = textField(concept, 'concept', { max: 200, required: true })
        if (session.sessionType === 'restricted' && looksLikeQuestion(phrase)) {
          note('academic.integrity_refused', { sessionId, why: 'concept-looks-like-a-question' })
          throw new AcademicError(400, 'concept-looks-like-question', 'In a restricted session, name the concept you want explained (for example "second normal form") instead of pasting a question.')
        }
        if (style !== null && !['simpler', 'deeper'].includes(style)) throw new AcademicError(400, 'invalid-input', 'style must be simpler or deeper.')
        const course = resolveCourse(session, {}, courseId)
        sessions.touch(sessionId)
        const entry = { id: newId(), text: `Explain the concept: ${phrase}`, options: [], marks: null, type: 'other', hasDiagram: false, task: 'explain', subject: '', topic: phrase, contentKind: 'concept', instructions: '', contextSnapshot: null, signals: [], answer: null }
        const result = await run({ session, entry, mode: session.sessionType === 'restricted' ? 'conceptual' : verdict.mode, courseId: course.courseId, courseTitle: course.title, conversationId, style, instruction: null, useResearch: false, ctx })
        const answerId = newId()
        const saved = appendToConversation(conversationId, `Explain the concept: ${phrase}`, result.markdown)
        note('academic.concept', { sessionId, grounding: result.grounding, restricted: session.sessionType === 'restricted' })
        return { status: 'answered', answerId, courseId: course.courseId, task: 'explain', savedToConversation: saved, ...result }
      }
    }
    return service
  }

  return { forOwner }
}
