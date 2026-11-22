import assert from 'node:assert/strict'
import test from 'node:test'
import { AcademicError } from './academicError.js'
import { createAnswerService, looksLikeQuestion } from './answerService.js'
import { createCaptureService } from './captureService.js'
import { createKnowledgeService } from './knowledgeService.js'
import { createMemoryLaneManager } from './memoryLanes.js'
import { createSessionManager } from './sessionManager.js'
import { createKnowledgeRepository } from '../persistence/knowledgeRepository.js'
import { createSessionService } from '../sessions/sessionService.js'
import { createConversationRepository } from '../persistence/conversationRepository.js'
import { fakeVision, png, quiet, reading, rig } from './testSupport.js'

const NOTES = '# Normalisation\n\n## Third normal form\n\nA table is in third normal form when every non-key attribute depends on the key, the whole key and nothing but the key.'

function setup({ research = null } = {}) {
  const t = rig()
  const knowledge = createKnowledgeRepository(t.database)
  const knowledgeService = createKnowledgeService({ knowledge })
  const sessions = createSessionManager({ academic: t.academic, clock: () => t.clock.t, ttlMs: 3_600_000, audit: t.audit })
  const lanes = createMemoryLaneManager({ academic: t.academic, knowledge, sessionManager: sessions, audit: t.audit, clock: () => t.clock.t })
  const store = createConversationRepository(t.database)
  const conversations = createSessionService({ store, logger: quiet })
  const vision = fakeVision()
  vision.state.reply = async () => reading()
  const captures = createCaptureService({ vision, sessionManager: sessions, courses: (u) => t.academic.forOwner(u).courses, now: () => t.clock.t, logger: quiet, limits: { minReadIntervalMs: 0 } })
  const calls = []
  const model = { reply: 'Third normal form means every attribute depends on the key [S1]. This is also in [S9].' }
  const generate = async (messages, opts) => {
    calls.push({ messages, opts })
    if (typeof model.reply === 'function') return model.reply(messages)
    return model.reply
  }
  const answers = createAnswerService({ generate, knowledgeService, lanes, sessionManager: sessions, researchService: research, conversations, courses: (u) => t.academic.forOwner(u).courses, now: () => t.clock.t, audit: t.audit, logger: quiet })
  const alice = answers.forOwner(t.who.alice)
  const course = lanes.forOwner(t.who.alice).createCourse({ title: 'Database Systems' })
  knowledge.forOwner(t.who.alice).addDocument({ courseId: course.id, title: 'Lecture 3', text: NOTES })
  const conversation = conversations.forOwner(t.who.alice).createSession({}).id
  const ctx = { identity: { ownerKey: t.who.alice }, requestId: 'r1' }
  return { ...t, knowledge, sessions, lanes, store, conversations, vision, captures, calls, model, alice, course, conversation, ctx, aliceSessions: sessions.forOwner(t.who.alice), aliceLanes: lanes.forOwner(t.who.alice), aliceCaptures: captures.forOwner(t.who.alice) }
}
const startStudy = (t, over = {}) => t.aliceSessions.start({ type: 'study', courseId: t.course.id, captureEnabled: true, ...over })

test('a typed question is answered from the course materials, the citations are checked, and the exchange joins the person\'s conversation', async () => {
  const t = setup()
  const s = startStudy(t)
  const result = await t.alice.answer({ sessionId: s.id, text: 'What is third normal form?', conversationId: t.conversation }, t.ctx)
  assert.equal(result.status, 'answered')
  assert.equal(result.grounding, 'course')
  assert.equal(result.task, 'explain')
  assert.deepEqual(result.sources.map((x) => [x.label, x.kind, x.title, x.section]), [['S1', 'course', 'Lecture 3', 'Normalisation > Third normal form']])
  assert.match(result.markdown, /every attribute depends on the key \[S1\]\./)
  assert.doesNotMatch(result.markdown, /\[S9\]/, 'a citation the model invented is removed')
  assert.deepEqual(result.flags.droppedCitations, ['S9'])
  assert.match(result.markdown, /\*\*Sources\*\*\n- \[S1\] Lecture 3 — Normalisation > Third normal form/)
  assert.deepEqual([result.evidence.course, result.evidence.research], [1, 0])
  assert.equal(result.savedToConversation, true)
  const saved = t.store.forOwner(t.who.alice).get(t.conversation).messages
  assert.deepEqual(saved.map((m) => m.role), ['user', 'assistant'])
  assert.equal(saved[0].content, 'What is third normal form?')
  assert.equal(saved[1].content, result.markdown)
  // what the model was sent
  const [system, user] = t.calls[0].messages
  assert.equal(system.role, 'system')
  assert.match(user.content, /<question>\nWhat is third normal form\?\n<\/question>/)
  assert.match(user.content, /<source id="S1" title="Lecture 3" section="Normalisation > Third normal form"/)
})

test('a restricted session is stopped by the application BEFORE the model: no answer, no model call, with a conceptual offer', async () => {
  const t = setup()
  const s = t.aliceSessions.start({ type: 'restricted', courseId: t.course.id })
  await assert.rejects(t.alice.answer({ sessionId: s.id, text: 'What is third normal form?', conversationId: t.conversation }, t.ctx), (err) => err.code === 'restricted-assessment' && err.statusCode === 403 && err.details.offer === 'explain_concept')
  assert.equal(t.calls.length, 0)
  assert.equal(t.store.forOwner(t.who.alice).get(t.conversation), null, 'nothing was written either')
  assert.ok(t.audits.every((a) => a.event !== 'academic.answer'))
})

test('a paused, ended or missing session answers nothing', async () => {
  const t = setup()
  const s = startStudy(t)
  t.aliceSessions.pause(s.id)
  await assert.rejects(t.alice.answer({ sessionId: s.id, text: 'What is third normal form?' }, t.ctx), (err) => err.code === 'session-paused')
  t.aliceSessions.resume(s.id)
  t.aliceSessions.stop(s.id)
  await assert.rejects(t.alice.answer({ sessionId: s.id, text: 'What is third normal form?' }, t.ctx), (err) => err.code === 'session-ended')
  await assert.rejects(t.alice.answer({ sessionId: 'nope', text: 'What is third normal form?' }, t.ctx), (err) => err.code === 'session-not-found')
  assert.equal(t.calls.length, 0)
})

test('a recognised question from the screen is answered by its id; asking for it again with "simpler" changes how it is explained, not what is asked', async () => {
  const t = setup()
  const s = startStudy(t)
  const read = await t.aliceCaptures.read(s.id, { bytes: png() }, t.ctx)
  const qid = read.questions[0].id
  const first = await t.alice.answer({ sessionId: s.id, questionId: qid, conversationId: t.conversation }, t.ctx)
  assert.equal(first.questionId, qid)
  assert.equal(first.task, 'explain')
  assert.equal(first.courseId, t.course.id)
  const again = await t.alice.answer({ sessionId: s.id, questionId: qid, conversationId: t.conversation, style: 'simpler', instruction: 'explain it to me like I am new to this' }, t.ctx)
  assert.equal(again.approach, 'simpler')
  const last = t.calls.at(-1).messages
  assert.match(last[0].content, /SIMPLER explanation/)
  assert.match(last[1].content, /<student_note>\nexplain it to me like I am new to this\n<\/student_note>/)
  assert.match(last[1].content, /Explain third normal form with an example\./)
  await assert.rejects(t.alice.answer({ sessionId: s.id, questionId: 'no-such-question' }, t.ctx), (err) => err.code === 'question-not-found')
  await assert.rejects(t.alice.answer({ sessionId: s.id, questionId: qid, style: 'faster' }, t.ctx), (err) => err.code === 'invalid-input')
})

test('a screen that looks like an examination makes the person say what this is, once; it never switches the session itself', async () => {
  const t = setup()
  const s = startStudy(t)
  t.vision.state.reply = async () => reading({ assessmentIndicators: ['closed book', 'time remaining 40:00'] })
  const read = await t.aliceCaptures.read(s.id, { bytes: png() }, t.ctx)
  const qid = read.questions[0].id
  const asked = await t.alice.answer({ sessionId: s.id, questionId: qid }, t.ctx)
  assert.equal(asked.status, 'confirm-required')
  assert.deepEqual(asked.signals.sort(), ['closed-book', 'live-timer'])
  assert.match(asked.message, /end this session and start a restricted one/)
  assert.equal(t.calls.length, 0, 'the model was not asked')
  assert.equal(t.aliceSessions.get(s.id).sessionType, 'study', 'the type is unchanged')
  const confirmed = await t.alice.answer({ sessionId: s.id, questionId: qid, confirmPractice: true }, t.ctx)
  assert.equal(confirmed.status, 'answered')
  assert.ok(t.audits.some((a) => a.event === 'academic.integrity_flag'))
  assert.ok(t.audits.some((a) => a.event === 'academic.integrity_confirm' && a.detail.signals.includes('closed-book')))
  assert.equal((await t.alice.answer({ sessionId: s.id, questionId: qid }, t.ctx)).status, 'answered', 'confirmed once, not asked again')
})

test('which course? is asked when the screen does not say; with no course at all the answer says it is from general knowledge', async () => {
  const t = setup()
  t.aliceLanes.createCourse({ title: 'Computer Networks' })
  const s = t.aliceSessions.start({ type: 'study', captureEnabled: true })
  t.vision.state.reply = async () => reading({ subject: 'systems', topic: 'design' })
  const read = await t.aliceCaptures.read(s.id, { bytes: png() }, t.ctx)
  const asked = await t.alice.answer({ sessionId: s.id, questionId: read.questions[0].id }, t.ctx)
  assert.equal(asked.status, 'needs-course')
  assert.ok(asked.candidates.length > 0)
  assert.equal(t.calls.length, 0)
  const chosen = await t.alice.answer({ sessionId: s.id, questionId: read.questions[0].id, courseId: t.course.id }, t.ctx)
  assert.equal(chosen.status, 'answered')
  assert.equal(chosen.courseId, t.course.id)

  const loose = t.aliceSessions.start({ type: 'study' })
  t.model.reply = 'Plain explanation with no citations.'
  const general = await t.alice.answer({ sessionId: loose.id, text: 'What is a primary key?' }, t.ctx)
  assert.equal(general.grounding, 'general')
  assert.equal(general.courseId, null)
  assert.match(t.calls.at(-1).messages[0].content, /No course was identified/)
  await assert.rejects(t.alice.answer({ sessionId: loose.id, text: 'What is a key?', courseId: 'someone-elses' }, t.ctx), (err) => err.code === 'course-not-found')
})

test('what the student has been through is passed on as a gentle hint, only for this topic, and not at all when adaptive learning is off', async () => {
  const t = setup()
  t.aliceLanes.recordFeedback({ kind: 'misunderstanding', courseId: t.course.id, topic: 'third normal form', note: 'confuses it with 2NF' })
  t.aliceLanes.recordFeedback({ kind: 'not_helpful', courseId: t.course.id, topic: 'photosynthesis' })
  const s = startStudy(t)
  await t.alice.answer({ sessionId: s.id, text: 'Explain third normal form please.', topic: 'third normal form' }, t.ctx)
  const user = t.calls.at(-1).messages[1].content
  assert.match(user, /<learning_notes>\n- third normal form: confuses it with 2NF/)
  assert.doesNotMatch(user, /photosynthesis/)
  t.aliceLanes.updateProfile({ adaptiveLearning: false })
  await t.alice.answer({ sessionId: s.id, text: 'Explain third normal form again.', topic: 'third normal form' }, t.ctx)
  assert.doesNotMatch(t.calls.at(-1).messages[1].content, /learning_notes/)
})

test('the learning profile shapes the system message; the default is natural student-level writing', async () => {
  const t = setup()
  const s = startStudy(t)
  await t.alice.answer({ sessionId: s.id, text: 'Define a foreign key.' }, t.ctx)
  assert.match(t.calls.at(-1).messages[0].content, /natural, straightforward and clear/)
  t.aliceLanes.updateProfile({ learningProfile: { writingStyle: 'concise', learningApproach: 'example_first' } })
  await t.alice.answer({ sessionId: s.id, text: 'Define a primary key.' }, t.ctx)
  assert.match(t.calls.at(-1).messages[0].content, /shortest answer that is complete and correct/)
  assert.match(t.calls.at(-1).messages[0].content, /Start from a concrete example/)
})

test('research is used only when the session asks for it, is labelled and verified, and its failure never stops the answer', async () => {
  const work = { label: 'R1', title: 'A Relational Model of Data', authors: ['E. Codd'], year: 1970, venue: 'CACM', doi: '10.1145/362384.362685', abstract: 'Abstract.', verified: true, url: 'https://doi.org/10.1145/362384.362685' }
  const research = { forOwner: () => ({ search: async () => ({ works: [work], query: 'q' }) }) }
  const t = setup({ research })
  t.model.reply = 'The course says this [S1]. Codd introduced the model [R1].'
  const withResearch = startStudy(t, { useResearch: true })
  const r = await t.alice.answer({ sessionId: withResearch.id, text: 'What is third normal form?' }, t.ctx)
  assert.equal(r.grounding, 'both')
  assert.deepEqual(r.sources.map((x) => [x.label, x.kind, x.verified]), [['S1', 'course', undefined], ['R1', 'research', true]])
  assert.match(r.markdown, /\[R1\] E\. Codd \(1970\)\. A Relational Model of Data\. CACM\. https:\/\/doi\.org\/10\.1145\/362384\.362685/)
  assert.match(t.calls.at(-1).messages[1].content, /<source id="R1"[^>]*verified="yes"/)

  t.aliceSessions.stop(withResearch.id)
  const without = startStudy(t, { useResearch: false })
  const before = t.calls.length
  const n = await t.alice.answer({ sessionId: without.id, text: 'What is third normal form?' }, t.ctx)
  assert.equal(n.evidence.research, 0)
  assert.equal(t.calls.length, before + 1)
  assert.doesNotMatch(t.calls.at(-1).messages[1].content, /id="R1"/)
  const asked = await t.alice.answer({ sessionId: without.id, text: 'What is third normal form, really?', useResearch: true }, t.ctx)
  assert.equal(asked.evidence.research, 1, 'a single question can ask for research too')

  const failing = setup({ research: { forOwner: () => ({ search: async () => { throw new AcademicError(502, 'research-unavailable', 'Research sources could not be reached just now, so this answer uses your course materials and general knowledge only.') } }) } })
  failing.model.reply = 'From your materials [S1].'
  const survived = await failing.alice.answer({ sessionId: startStudy(failing, { useResearch: true }).id, text: 'What is third normal form?' }, failing.ctx)
  assert.equal(survived.status, 'answered', 'a research outage does not stop the answer')
  assert.equal(survived.grounding, 'course')
  assert.equal(survived.flags.researchUnavailable.code, 'research-unavailable')
  assert.match(survived.flags.researchUnavailable.message, /course materials and general knowledge only/)
})

test('the person\'s daily allowance and a failing or empty model are handled before and after the call', async () => {
  const t = setup()
  const s = startStudy(t)
  const refusing = { begin() { throw Object.assign(new Error('Daily allowance reached'), { name: 'AiLimitError', statusCode: 429, code: 'daily-limit' }) } }
  await assert.rejects(t.alice.answer({ sessionId: s.id, text: 'What is third normal form?' }, { ...t.ctx, meter: refusing }), (err) => err.name === 'AiLimitError')
  assert.equal(t.calls.length, 0)
  const outcomes = []
  const meter = { begin: (identity, kind) => ({ usage() {}, finish: () => outcomes.push(`${kind}:ok`), fail: () => outcomes.push(`${kind}:failed`) }) }
  t.model.reply = () => {
    throw Object.assign(new Error('boom'), { statusCode: 503 })
  }
  await assert.rejects(t.alice.answer({ sessionId: s.id, text: 'What is third normal form?' }, { ...t.ctx, meter }), (err) => err.code === 'answer-failed' && err.statusCode === 502)
  t.model.reply = '   '
  await assert.rejects(t.alice.answer({ sessionId: s.id, text: 'What is third normal form?' }, { ...t.ctx, meter }), (err) => err.code === 'answer-failed')
  t.model.reply = 'Fine [S1].'
  await t.alice.answer({ sessionId: s.id, text: 'What is third normal form?' }, { ...t.ctx, meter })
  assert.deepEqual(outcomes, ['academic_answer:failed', 'academic_answer:ok', 'academic_answer:ok'])
  assert.equal(t.store.forOwner(t.who.alice).get(t.conversation), null, 'nothing was written to a conversation for a failed answer')
})

test('the answer goes only into the person\'s own open conversation', async () => {
  const t = setup()
  const s = startStudy(t)
  const bobsConversation = t.conversations.forOwner(t.who.bob).createSession({}).id
  await assert.rejects(t.alice.answer({ sessionId: s.id, text: 'What is third normal form?', conversationId: bobsConversation }, t.ctx), (err) => err.code === 'conversation-not-found')
  const none = await t.alice.answer({ sessionId: s.id, text: 'What is third normal form?' }, t.ctx)
  assert.equal(none.savedToConversation, false, 'with no conversation named the answer is returned and not saved')
})

test('a restricted session can still be taught a concept, in general terms, but never given a pasted question', async () => {
  const t = setup()
  const s = t.aliceSessions.start({ type: 'restricted', courseId: t.course.id })
  const ok = await t.alice.explainConcept({ sessionId: s.id, concept: 'third normal form', conversationId: t.conversation }, t.ctx)
  assert.equal(ok.status, 'answered')
  const system = t.calls.at(-1).messages[0].content
  assert.match(system, /RESTRICTED assessment context/)
  assert.match(system, /Do NOT answer, solve or complete any specific question/)
  assert.equal(t.store.forOwner(t.who.alice).get(t.conversation).messages[0].content, 'Explain the concept: third normal form')
  for (const pasted of ['Explain why a table in 2NF may still fail 3NF and give a worked example with a schema of five attributes', 'What is the output of the following query?\nSELECT 1', 'A) key B) value C) row D) column', 'Calculate the total cost if 12 items cost 4.50 each plus 8 delivery']) {
    await assert.rejects(t.alice.explainConcept({ sessionId: s.id, concept: pasted }, t.ctx), (err) => err.code === 'concept-looks-like-question' && err.statusCode === 400, pasted.slice(0, 30))
  }
  assert.equal(t.calls.length, 1, 'the refused ones never reached the model')
  assert.ok(t.audits.some((a) => a.event === 'academic.integrity_refused'))
  assert.equal(looksLikeQuestion('second normal form'), false)
  assert.equal(looksLikeQuestion('ACID properties'), false)
  assert.equal(looksLikeQuestion('Why does 3NF matter?'), false)
  // in a study session the same call is an ordinary explanation, not the restricted wording
  const study = startStudy(t)
  await t.alice.explainConcept({ sessionId: study.id, concept: 'foreign keys' }, t.ctx)
  assert.doesNotMatch(t.calls.at(-1).messages[0].content, /RESTRICTED assessment context/)
})

test('typed questions and answers belong to one person: another cannot answer into their session', async () => {
  const t = setup()
  const s = startStudy(t)
  const bob = createAnswerService({ generate: async () => 'x', knowledgeService: createKnowledgeService({ knowledge: t.knowledge }), lanes: t.lanes, sessionManager: t.sessions, conversations: t.conversations, courses: (u) => t.academic.forOwner(u).courses, audit: t.audit, logger: quiet }).forOwner(t.who.bob)
  await assert.rejects(bob.answer({ sessionId: s.id, text: 'What is third normal form?' }, { identity: { ownerKey: t.who.bob } }), (err) => err.code === 'session-not-found')
  await assert.rejects(bob.explainConcept({ sessionId: s.id, concept: 'keys' }, { identity: { ownerKey: t.who.bob } }), (err) => err.code === 'session-not-found')
})

test('the audit trail says what kind of answer it was, never what was asked or said', async () => {
  const t = setup()
  const s = startStudy(t)
  await t.alice.answer({ sessionId: s.id, text: 'A very private question about my own coursework', conversationId: t.conversation }, t.ctx)
  const entry = t.audits.find((a) => a.event === 'academic.answer')
  assert.ok(entry && entry.detail.grounding && entry.userId === t.who.alice)
  assert.equal(JSON.stringify(t.audits).includes('private question'), false)
})
