import { randomUUID } from 'node:crypto'
import { AcademicError, textField } from './academicError.js'
import { analyseQuestion, extractOptions } from './questionAnalysis.js'
import { checkAnswer, reviewVerdict } from './answerCheck.js'
import { answerLabel, formatAnswers, normalizeAnswer } from './answerFormat.js'
import { detectSourceOnly } from './answerStyle.js'
import { enforce } from './integrity.js'
import { buildMessages, buildRepairMessages, buildReviewMessages, EXPLAINING_STYLES, sourcesBlock, stripCitations, takeNotes, verifyCitations } from './responseEngine.js'
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
 *   7  the question is analysed (kind, size, parts, instructions) and the model is asked, with an explicit system message; when the caller
 *      listens (`hooks.onEvent`) and the provider streams, the words are passed on as they arrive
 *   8  the answer is checked before it is final: always by rules (answerCheck.js), with one repair when a rule fails; a complex question is
 *      also read a second time by the model (a review that redoes any calculation). Checking never costs the person another answer of their
 *      daily allowance: it is part of the same metered call
 *   9  the citations are verified and the source list is built from our records
 *  10  the exchange is added to the conversation the person has open (their ordinary NUMZ AI conversation)
 *
 * The same question asked the same way twice (a double click, an automatic answer racing a button) is answered once: the second ask shares
 * the first's work, or gets its result back.
 *
 * Conceptual explanations (`explainConcept`) are the one thing a restricted session may ask for: a named concept, never a pasted question.
 */

const MODEL_TIMEOUT_MS = 60_000
const MAX_QUESTION = 2000

const withDeadline = (run, ms, outer = null) => {
  const controller = new AbortController()
  const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(Object.assign(new Error('The model did not answer in time'), { name: 'TimeoutError' }))
    }, ms)
  })
  return Promise.race([Promise.resolve().then(() => run(signal)), deadline]).finally(() => clearTimeout(timer))
}

/** Token counts of several model calls, reported once for the one metered call they belong to. */
function usageTotal() {
  const sum = { promptTokens: 0, completionTokens: 0, model: undefined, provider: undefined, any: false }
  return {
    add(u = {}) {
      sum.any = true
      if (Number.isFinite(u.promptTokens)) sum.promptTokens += u.promptTokens
      if (Number.isFinite(u.completionTokens)) sum.completionTokens += u.completionTokens
      sum.model = u.model ?? sum.model
      sum.provider = u.provider ?? sum.provider
    },
    report: () => (sum.any ? { promptTokens: sum.promptTokens, completionTokens: sum.completionTokens, model: sum.model, provider: sum.provider } : null)
  }
}

/** A concept is a short phrase. A pasted question (long, with options, or asking something at length) is refused in a restricted session. */
export function looksLikeQuestion(text) {
  const t = String(text ?? '').trim()
  const words = t.split(/\s+/).filter(Boolean).length
  return words > 12 || t.length > 120 || /^\s*[A-Da-d][).]\s+\S/m.test(t) || /\n/.test(t) || (/\?\s*$/.test(t) && words > 8) || /\b(calculate|solve|work out)\b.*\d/i.test(t)
}

export function createAnswerService({ generate, stream = null, about = () => '', knowledgeService, lanes, sessionManager, researchService = null, conversations, courses, now = Date.now, newId = randomUUID, audit = () => {}, logger = console }) {
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

    /**
     * Runs the pipeline for an entry (a recognised question held in the session, or one typed).
     * `hooks.onEvent` (optional) hears { type: 'start' | 'delta' | 'checking' } while it works; `hooks.signal` stops the work.
     */
    async function run({ session, entry, mode, courseId, courseTitle, conversationId, style, instruction, useResearch, ctx, hooks = {} }) {
      const t0 = performance.now()
      const emit = (event) => {
        try {
          hooks.onEvent?.(event)
        } catch {
          /* a listener that fails never fails the answer */
        }
      }
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
      const analysis = analyseQuestion(entry, { related })
      // "Use only my notes", said in the note to the answer or in the question itself, means no general knowledge to fill a gap.
      const sourceOnly = detectSourceOnly(instruction, entry.text)
      const sourcesText = [...retrieval.passages.map((p) => p.text), ...works.map((w) => `${w.title ?? ''} ${w.abstract ?? ''} ${(w.authors ?? []).join(' ')} ${w.year ?? ''}`)].join(' ')
      const messages = buildMessages({ mode, task: analysis.task, analysis, sourceOnly, about: mode === 'conceptual' ? '' : about(userId), question: entry, marks: entry.marks, instructions: entry.instructions, courseTitle, topic, passages: retrieval.passages, research: works, crossCourseReason: retrieval.reason, instruction, experiences, profile, style, figureNote, related })
      const partKeys = analysis.parts.map((p) => p.key)
      const labels = partKeys.length >= 2 ? analysis.parts.map((p) => ({ key: p.key, label: answerLabel(p.key) })) : [{ key: analysis.ownLabel, label: answerLabel(analysis.ownLabel) }]
      const timings = { lookup: Math.round(performance.now() - t0) }

      const call = ctx.meter?.begin(ctx.identity, 'academic_answer', { requestId: ctx.requestId, conversationId })
      const used = usageTotal()
      const listening = typeof hooks.onEvent === 'function' && typeof stream === 'function'
      let modelCalls = 0
      const ask = async (msgs, { live = false } = {}) => {
        modelCalls++
        if (live && listening) {
          return withDeadline(async (signal) => {
            let text = ''
            for await (const chunk of stream(msgs, { signal, onUsage: used.add })) {
              if (chunk.type === 'token') {
                text += chunk.token
                emit({ type: 'delta', text: chunk.token })
              } else if (chunk.type === 'message') text = chunk.content
            }
            return text
          }, MODEL_TIMEOUT_MS, hooks.signal)
        }
        return withDeadline((signal) => generate(msgs, { signal, onUsage: used.add }), MODEL_TIMEOUT_MS, hooks.signal)
      }

      let finished = false
      const finishCall = () => {
        if (!call || finished) return
        finished = true
        const total = used.report()
        if (total) call.usage(total)
        call.finish()
      }
      let normalized
      const validation = { verdict: 'ok', issues: [], repaired: false, reviewed: false, calls: 1, level: analysis.review ? 'review' : 'rules' }
      try {
        emit({ type: 'start', task: analysis.task, complexity: analysis.complexity, parts: labels })
        const tModel = performance.now()
        const draft = await ask(messages, { live: true })
        timings.model = Math.round(performance.now() - tModel)
        if (!String(draft ?? '').trim()) {
          finishCall() // the model did answer (and was paid for): it answered with nothing
          throw new AcademicError(502, 'answer-failed', 'The assistant sent back nothing to show. Try again.')
        }

        const tCheck = performance.now()
        const examine = (text) => {
          const n = normalizeAnswer(text, partKeys)
          return { n, ...checkAnswer({ analysis, question: entry, parts: n.parts, sourcesText }) }
        }
        let current = examine(draft)
        if (current.issues.length) {
          // One repair: the draft goes back with exactly what was wrong with it. If the repair is no better, the draft stands (flagged).
          emit({ type: 'checking', stage: 'repair' })
          validation.issues = current.issues
          try {
            const fixed = examine(await ask(buildRepairMessages({ messages, draft, issues: current.issues })))
            validation.repaired = true
            if (fixed.issues.length <= current.issues.length && fixed.n.parts.some((p) => p.markdown.trim())) current = fixed
            validation.verdict = current.issues.length ? 'flagged' : 'repaired'
          } catch (err) {
            if (hooks.signal?.aborted) throw err
            validation.verdict = 'flagged'
          }
        }
        if (analysis.review && !current.issues.length && validation.verdict !== 'flagged') {
          // A complex question is read a second time: relevance, correctness (every calculation redone), completeness, clarity.
          emit({ type: 'checking', stage: 'review' })
          try {
            const verdict = reviewVerdict(await ask(buildReviewMessages({ request: messages[1].content, draft: formatAnswers(current.n.parts) })))
            validation.reviewed = true
            if (!verdict.ok) {
              const revised = examine(verdict.corrected)
              if (!revised.issues.length && revised.n.parts.some((p) => p.markdown.trim())) {
                current = revised
                validation.verdict = 'corrected'
              }
            }
          } catch (err) {
            if (hooks.signal?.aborted) throw err
            /* the second look is a bonus: the draft that passed the rules stands */
          }
        }
        validation.calls = modelCalls
        timings.check = Math.round(performance.now() - tCheck)
        normalized = current.n
        validation.issues = current.issues
        finishCall()
      } catch (err) {
        if (!finished) call?.fail(err)
        if (err instanceof AcademicError) throw err
        if (hooks.signal?.aborted && err?.name !== 'TimeoutError') throw err
        logger.warn?.(`[academic] answer failed (${err?.statusCode ?? err?.status ?? err?.name ?? 'error'})`)
        throw new AcademicError(502, 'answer-failed', 'An answer could not be worked out just now. Try again.')
      }

      const given = [...retrieval.passages.map((p) => p.label), ...works.map((w) => w.label)]
      const cited = []
      const dropped = []
      const notes = [] // what the answer says about its sources: shown beside it, not in it
      const parts = normalized.parts.map((p) => {
        const checked = verifyCitations(p.markdown, given)
        for (const l of checked.cited) if (!cited.includes(l)) cited.push(l)
        for (const l of checked.dropped) if (!dropped.includes(l)) dropped.push(l)
        // A question that is itself one part of a bigger one on the screen ("(b) Calculate ...") keeps that part's label on its answer.
        const own = normalized.parts.length === 1 && analysis.ownLabel ? analysis.ownLabel : p.key
        // The answer holds the plain answer only: the labels the model cited are taken out, and the sources they stood for are listed apart from it.
        const clean = takeNotes(stripCitations(checked.text))
        for (const n of clean.notes) if (!notes.includes(n)) notes.push(n)
        return { key: own, label: answerLabel(own), markdown: clean.text }
      })
      const sources = sourcesBlock(cited, retrieval.passages, works)
      const beside = [notes.length ? `**Note**\n${notes.join(' ')}` : '', sources].filter(Boolean).join('\n\n')
      const markdown = formatAnswers(parts, beside)
      const citedCourse = cited.filter((l) => l.startsWith('S')).length
      const citedResearch = cited.filter((l) => l.startsWith('R')).length
      const grounding = citedCourse && citedResearch ? 'both' : citedCourse ? 'course' : citedResearch ? 'research' : 'general'
      timings.total = Math.round(performance.now() - t0)
      return {
        markdown,
        parts,
        grounding,
        sources: cited.map((label) => {
          const p = retrieval.passages.find((x) => x.label === label)
          const r = works.find((x) => x.label === label)
          return p ? { label, kind: 'course', title: p.title, version: p.version, section: p.headingPath, where: p.locator, crossCourse: p.crossCourse } : { label, kind: 'research', title: r.title, authors: r.authors, year: r.year, doi: r.doi, url: r.url, verified: r.verified }
        }),
        evidence: { course: retrieval.passages.length, research: works.length, crossCourse: retrieval.crossCourse, learningNotes: experiences.length },
        flags: { droppedCitations: dropped, uncitedDespiteEvidence: given.length > 0 && cited.length === 0, researchUnavailable: researchNote, figureMissing: Boolean(figureNote) },
        approach: style ?? 'answer',
        topic,
        analysis: { task: analysis.task, complexity: analysis.complexity, format: analysis.format, parts: partKeys.length, count: analysis.count },
        validation: { verdict: validation.verdict, level: validation.level, repaired: validation.repaired, reviewed: validation.reviewed, calls: validation.calls, issues: validation.verdict === 'flagged' ? validation.issues : [] },
        timings
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
      async answer({ sessionId, questionId = null, text = null, conversationId = null, courseId = null, topic = null, style = null, instruction = null, confirmPractice = false, useResearch = null }, ctx = {}, hooks = {}) {
        const session = sessions.requireOpen(sessionId)
        const verdict = enforce({ session, action: 'answer', now: now() })
        if (style !== null && !EXPLAINING_STYLES.includes(style)) throw new AcademicError(400, 'invalid-input', 'style must be explain, simpler or deeper.')
        const runtime = sessions.runtime(sessionId)
        let entry
        if (questionId) {
          entry = runtime.questions.get(String(questionId))
          if (!entry) throw new AcademicError(404, 'question-not-found', 'That question is no longer in this session. Read the screen again.')
        } else {
          const typed = textField(text, 'text', { max: MAX_QUESTION, required: true })
          // A multiple-choice question typed with its options in the text ("… A) 3 B) 4") is a question with options, not one in four parts.
          const inline = extractOptions(typed)
          entry = { id: newId(), text: inline ? inline.stem : typed, options: inline ? inline.options : [], marks: null, type: inline ? 'multiple-choice' : 'other', hasDiagram: false, task: analyseQuestion({ text: typed }).task, subject: '', topic: textField(topic, 'topic', { max: 120 }) ?? '', contentKind: 'typed', instructions: '', contextSnapshot: null, signals: [], confirmedPractice: false, answer: null, createdAt: now() }
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

        // The same question, asked the same way, is answered once: an answer already given is handed back, one being worked on is shared.
        const key = JSON.stringify([entry.text, entry.options, style, instruction ?? null, course.courseId, useResearch ?? session.useResearch ?? false, conversationId])
        entry.results ??= new Map()
        if (!instruction && entry.results.has(key)) return { ...entry.results.get(key), cached: true }
        entry.working ??= new Map()
        if (entry.working.has(key)) return { ...(await entry.working.get(key)), cached: true }

        sessions.touch(sessionId)
        const work = (async () => {
          const result = await run({ session, entry, mode: verdict.mode, courseId: course.courseId, courseTitle: course.title, conversationId, style, instruction: textField(instruction, 'instruction', { max: 500 }), useResearch: useResearch ?? session.useResearch, ctx, hooks })
          const answerId = newId()
          entry.answer = { answerId, grounding: result.grounding, approach: result.approach, topic: result.topic, courseId: course.courseId }
          const shown = entry.options?.length ? `${entry.text}\n${entry.options.map((o) => `${o.label}) ${o.text}`).join('\n')}` : entry.text
          const saved = appendToConversation(conversationId, shown, result.markdown)
          note('academic.answer', { sessionId, questionId: entry.id, grounding: result.grounding, course: result.evidence.course, research: result.evidence.research, style })
          // what the card is labelled with: the kind the analysis found (a question of several parts is just that)
          return { status: 'answered', answerId, questionId: entry.id, courseId: course.courseId, task: result.analysis.parts >= 2 ? 'multi-part' : result.analysis.task, savedToConversation: saved, ...result }
        })()
        entry.working.set(key, work)
        try {
          const done = await work
          if (!instruction) entry.results.set(key, done)
          return done
        } finally {
          entry.working.delete(key)
        }
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
        if (style !== null && !EXPLAINING_STYLES.includes(style)) throw new AcademicError(400, 'invalid-input', 'style must be explain, simpler or deeper.')
        const course = resolveCourse(session, {}, courseId)
        sessions.touch(sessionId)
        const entry = { id: newId(), text: `Explain the concept: ${phrase}`, options: [], marks: null, type: 'other', hasDiagram: false, task: 'explain', subject: '', topic: phrase, contentKind: 'concept', instructions: '', contextSnapshot: null, signals: [], answer: null }
        const result = await run({ session, entry, mode: session.sessionType === 'restricted' ? 'conceptual' : verdict.mode, courseId: course.courseId, courseTitle: course.title, conversationId, style: style ?? 'explain', instruction: null, useResearch: false, ctx }) // a concept is asked for in order to be explained
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
