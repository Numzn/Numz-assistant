import { AcademicError, textField } from '../academic/academicError.js'
import { FEEDBACK_KINDS } from '../academic/learningMemory.js'

/**
 * Answering, feedback, progress and research (added to /api/v1/assistant/academic):
 *
 *   POST /sessions/:id/questions/:qid/answer   { conversationId?, courseId?, style?: 'explain'|'simpler'|'deeper', instruction?, confirmPractice?, useResearch? }
 *   POST /sessions/:id/ask                     { text, topic?, ...the same }       a typed question
 *   POST /sessions/:id/concept                 { concept, conversationId?, courseId?, style? }   the one thing a restricted session may ask for
 *        -> { status: 'answered', answerId, markdown, grounding, sources, evidence, flags, ... }
 *           or { status: 'confirm-required', signals }   the screen looks like a formal assessment: the person says what this is
 *           or { status: 'needs-course', candidates }    which course is it from?
 *   POST /feedback        { kind: 'helpful'|'not_helpful'|'correction'|'misunderstanding'|'save_concept', courseId, topic, note?, approach?, text? }
 *   GET  /progress[?course=<id>]               what has been learned per topic, and what is worth reviewing
 *   POST /memory/experiences/:id/reviewed      the person went back over a topic
 *   GET  /research?q=                          verified scholarly sources (OpenAlex records confirmed with Crossref)
 *
 * The answer is added to the conversation named by `conversationId` (the person's own, open one) as an ordinary exchange.
 */

const MAX_NOTE_TEXT = 20_000

export function addAnswerRoutes(router, { wrap, body, audit }, { answerService, researchService, knowledge }) {
  const answers = (req) => answerService.forOwner(req.academic.userId)
  const ctxOf = (req) => ({ identity: req.identity, meter: req.meter, requestId: req.id })
  const options = (req) => {
    const b = body(req)
    return { conversationId: typeof b.conversationId === 'string' ? b.conversationId : null, courseId: typeof b.courseId === 'string' ? b.courseId : null, style: b.style ?? null, instruction: b.instruction ?? null, confirmPractice: b.confirmPractice === true, useResearch: typeof b.useResearch === 'boolean' ? b.useResearch : null }
  }

  router.post('/sessions/:id/questions/:qid/answer', wrap(async (req, res) => res.json(await answers(req).answer({ sessionId: req.params.id, questionId: req.params.qid, ...options(req) }, ctxOf(req)))))
  router.post('/sessions/:id/ask', wrap(async (req, res) => res.json(await answers(req).answer({ sessionId: req.params.id, text: body(req).text, topic: body(req).topic ?? null, ...options(req) }, ctxOf(req)))))
  router.post('/sessions/:id/concept', wrap(async (req, res) => res.json(await answers(req).explainConcept({ sessionId: req.params.id, concept: body(req).concept, conversationId: options(req).conversationId, courseId: options(req).courseId, style: options(req).style }, ctxOf(req)))))

  router.post(
    '/feedback',
    wrap((req, res) => {
      const b = body(req)
      if (b.kind === 'save_concept') {
        // The student explicitly keeps an explanation as course material: that is their act, so it does not depend on adaptive learning.
        const text = textField(b.text, 'text', { max: MAX_NOTE_TEXT, required: true })
        const topic = textField(b.topic, 'topic', { max: 120, required: true })
        const result = knowledge.forOwner(req.academic.userId).addDocument({ courseId: b.courseId, title: `Saved concept: ${topic}`, sourceType: 'notes', format: 'markdown', text })
        audit('academic.document_add', { userId: req.academic.userId, detail: { documentId: result.document.id, courseId: b.courseId, via: 'save_concept' } })
        return res.status(201).json({ recorded: true, saved: true, document: result.document })
      }
      if (!FEEDBACK_KINDS.includes(b.kind)) throw new AcademicError(400, 'invalid-input', `kind must be one of: ${[...FEEDBACK_KINDS, 'save_concept'].join(', ')}.`)
      res.json(req.lanes.recordFeedback({ kind: b.kind, courseId: typeof b.courseId === 'string' ? b.courseId : null, topic: b.topic, note: b.note ?? null, approach: b.approach ?? null }))
    })
  )

  router.get(
    '/progress',
    wrap((req, res) => {
      const course = typeof req.query.course === 'string' ? req.query.course : null
      if (course && !req.lanes.getCourse(course)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
      res.json(req.lanes.progress({ courseId: course }))
    })
  )
  router.post(
    '/memory/experiences/:id/reviewed',
    wrap((req, res) => {
      const saved = req.lanes.markReviewed(req.params.id)
      if (!saved) throw new AcademicError(404, 'memory-not-found', 'That memory does not exist.')
      res.json(saved)
    })
  )

  router.get(
    '/research',
    wrap(async (req, res) => {
      if (!researchService) throw new AcademicError(503, 'research-off', 'Research is switched off on this server.')
      const result = await researchService.forOwner(req.academic.userId).search({ query: typeof req.query.q === 'string' ? req.query.q : '', limit: Number.parseInt(req.query.limit ?? '3', 10) || 3 })
      audit('academic.research', { userId: req.academic.userId, detail: { works: result.works.length, verified: result.works.filter((w) => w.verified).length } })
      res.json(result)
    })
  )
}
