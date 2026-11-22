import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { fakeVision, png, reading, rig } from '../academic/testSupport.js'
import { createCaptureService } from '../academic/captureService.js'
import { createSessionManager } from '../academic/sessionManager.js'
import { addSessionRoutes } from '../routes/academicSessions.js'
import { addAnswerRoutes } from '../routes/academicAnswers.js'
import { createAnswerService } from '../academic/answerService.js'
import { createSessionService } from '../sessions/sessionService.js'
import { createConversationRepository } from '../persistence/conversationRepository.js'
import { createMemoryLaneManager } from '../academic/memoryLanes.js'
import { LEGACY_IDENTITY, personIdentity } from '../auth/identity.js'
import { errorHandler } from '../http/errorHandler.js'
import { createAcademicRouter } from '../routes/academic.js'
import { addKnowledgeRoutes } from '../routes/academicKnowledge.js'
import { createKnowledgeService } from '../academic/knowledgeService.js'
import { createKnowledgeRepository } from '../persistence/knowledgeRepository.js'

const quiet = { error() {}, warn() {}, info() {}, log() {} }

async function serve() {
  const t = rig()
  const knowledge = createKnowledgeRepository(t.database)
  const knowledgeService = createKnowledgeService({ knowledge })
  const vision = fakeVision()
  vision.state.reply = async () => reading()
  const sessionManager = createSessionManager({ academic: t.academic, clock: () => t.clock.t, audit: t.audit })
  const captureService = createCaptureService({ vision, sessionManager, courses: (userId) => t.academic.forOwner(userId).courses, now: () => t.clock.t, logger: quiet, limits: { minReadIntervalMs: 0 } })
  const lanes = createMemoryLaneManager({ academic: t.academic, knowledge, sessionManager, audit: t.audit, clock: () => t.clock.t })
  const conversations = createSessionService({ store: createConversationRepository(t.database), logger: quiet })
  const model = { calls: [], reply: 'Third normal form means no transitive dependency [S1].' }
  const research = { forOwner: () => ({ search: async () => ({ works: [{ label: 'R1', title: 'Codd', authors: ['E. Codd'], year: 1970, doi: '10.1145/362384.362685', verified: true, url: 'https://doi.org/10.1145/362384.362685', abstract: 'a' }], query: 'q' }) }) }
  const answerService = createAnswerService({ generate: async (messages) => { model.calls.push(messages); return model.reply }, knowledgeService, lanes, sessionManager, researchService: research, conversations, courses: (u) => t.academic.forOwner(u).courses, now: () => t.clock.t, audit: t.audit, logger: quiet })
  const identities = {
    alice: personIdentity({ id: t.who.alice, external_id: 'a', email: 'alice@example.com', name: 'alice', role: 'viewer' }, { ref: 'r', csrf: 'x' }),
    bob: personIdentity({ id: t.who.bob, external_id: 'b', email: 'bob@example.com', name: 'bob', role: 'viewer' }, { ref: 'r', csrf: 'x' }),
    legacy: LEGACY_IDENTITY
  }
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use((req, _res, next) => {
    const who = req.headers['x-test-user']
    if (who) req.identity = identities[who]
    next()
  })
  const gate = (req, res, next) => (req.identity ? next() : res.status(401).json({ error: 'sign in', code: 'session-required' }))
  app.use('/academic', gate, createAcademicRouter({ lanes, audit: t.audit, extend: [(router, helpers) => addKnowledgeRoutes(router, helpers, { knowledge, knowledgeService }), (router, helpers) => addSessionRoutes(router, helpers, { sessionManager, captureService }), (router, helpers) => addAnswerRoutes(router, helpers, { answerService, researchService: research, knowledge })] }))
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}/academic`
  const as = (who) => async (path, { method = 'GET', body, text: textBody, type, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(who ? { 'x-test-user': who } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(type ? { 'content-type': type } : {}) },
      body: raw ?? (textBody !== undefined ? textBody : body === undefined ? undefined : JSON.stringify(body))
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers }
  }
  return { t, vision, model, conversations, alice: as('alice'), bob: as('bob'), legacy: as('legacy'), nobody: as(''), close: () => new Promise((resolve) => server.close(resolve)) }
}

async function using(body) {
  const r = await serve()
  try {
    await body(r)
  } finally {
    await r.close()
  }
}

test('Academic Intelligence needs a person: a visitor is turned away, and so is the shared access code', async () => {
  await using(async (r) => {
    assert.equal((await r.nobody('/profile')).status, 401)
    const shared = await r.legacy('/profile')
    assert.equal(shared.status, 403)
    assert.equal(shared.json.code, 'sign-in-required')
    assert.equal((await r.legacy('/courses', { method: 'POST', body: { title: 'x' } })).status, 403)
  })
})

test('the profile: defaults, a validated change, and a refusal that names the problem', async () => {
  await using(async (r) => {
    const first = await r.alice('/profile')
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    assert.equal(first.json.learningProfile.writingStyle, 'natural_student_academic')
    const changed = await r.alice('/profile', { method: 'PUT', body: { learningProfile: { learningApproach: 'example_first' }, academicProfile: { institution: 'UNZA', semester: '1' } } })
    assert.equal(changed.json.learningProfile.learningApproach, 'example_first')
    assert.equal((await r.alice('/profile')).json.academicProfile.institution, 'UNZA')
    const bad = await r.alice('/profile', { method: 'PUT', body: { learningProfile: { writingStyle: 'robotic' } } })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.code, 'invalid-input')
    assert.match(bad.json.error, /writingStyle/)
    assert.equal((await r.bob('/profile')).json.academicProfile.institution, null, 'bob\'s profile is his own')
  })
})

test('courses: create, list, change, delete; another person can neither see nor touch them', async () => {
  await using(async (r) => {
    const made = await r.alice('/courses', { method: 'POST', body: { title: 'Computer Networks', code: 'CS301' } })
    assert.equal(made.status, 201)
    const id = made.json.id
    assert.equal((await r.alice('/courses')).json.courses.length, 1)
    assert.equal((await r.alice(`/courses/${id}`, { method: 'PATCH', body: { semester: '2', verified: true } })).json.verified, true)
    assert.equal((await r.alice('/courses', { method: 'POST', body: {} })).status, 400)
    assert.deepEqual((await r.bob('/courses')).json.courses, [])
    assert.equal((await r.bob(`/courses/${id}`, { method: 'PATCH', body: { title: 'hijacked' } })).status, 404)
    assert.equal((await r.bob(`/courses/${id}`, { method: 'DELETE' })).status, 404)
    assert.equal((await r.alice('/courses')).json.courses[0].title, 'Computer Networks')
    assert.equal((await r.alice(`/courses/${id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await r.alice(`/courses/${id}`, { method: 'DELETE' })).status, 404)
  })
})

test('the memory centre: inspect, export, empty a lane, correct or delete one memory, delete everything - each only for the caller', async () => {
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'DB' } })).json
    const bobCourse = (await r.bob('/courses', { method: 'POST', body: { title: 'Bob course' } })).json
    const mine = r.t.academic.forOwner(r.t.who.alice)
    const e = mine.experiences.insert({ courseId: course.id, topic: 'joins', kind: 'difficulty', difficulty: 'needs_practice', confidence: 0.5, source: 'feedback' })
    r.t.academic.forOwner(r.t.who.bob).experiences.insert({ courseId: bobCourse.id, topic: 'bob topic', kind: 'difficulty', confidence: 0.5, source: 'feedback' })

    const seen = await r.alice('/memory')
    assert.equal(seen.json.lanes.experience.items.length, 1)
    assert.equal(seen.json.lanes.experience.items[0].topic, 'joins')
    assert.ok(!seen.text.includes('bob topic'))

    const exported = await r.alice('/memory/export')
    assert.match(exported.headers.get('content-disposition'), /attachment/)
    assert.equal(exported.json.experiences.length, 1)

    assert.equal((await r.bob(`/memory/experiences/${e.id}`, { method: 'PATCH', body: { observedIssue: 'x' } })).status, 404)
    const fixed = await r.alice(`/memory/experiences/${e.id}`, { method: 'PATCH', body: { observedIssue: 'only inner joins', difficulty: 'improving' } })
    assert.equal(fixed.json.difficulty, 'improving')

    assert.equal((await r.alice(`/memory/lane/experience?course=${bobCourse.id}`, { method: 'DELETE' })).status, 404)
    assert.equal((await r.alice('/memory/lane/conversation', { method: 'DELETE' })).json.code, 'use-conversations')
    assert.equal((await r.alice('/memory/lane/academic', { method: 'DELETE' })).json.code, 'confirm-required')
    assert.equal((await r.alice(`/memory/experiences/${e.id}`, { method: 'DELETE' })).status, 204)

    assert.equal((await r.alice('/memory', { method: 'DELETE' })).json.code, 'confirm-required')
    assert.equal((await r.alice('/memory?confirm=all', { method: 'DELETE' })).status, 200)
    assert.deepEqual((await r.alice('/courses')).json.courses, [])
    assert.equal((await r.bob('/courses')).json.courses.length, 1, 'bob still has his course')
    assert.equal((await r.bob('/memory')).json.lanes.experience.items.length, 1, 'and his memory')
  })
})

const NOTES = '# Normalisation\n\nNormalisation removes redundancy.\n\n## Third normal form\n\nEvery attribute depends on the key and nothing but the key.'

test('course materials over HTTP: markdown and text in, passages out, versions, delete; documents of one person never reach another', async () => {
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Databases' } })).json
    const url = (title, type = 'lecture_notes') => `/courses/${course.id}/documents?title=${encodeURIComponent(title)}&type=${type}`
    const added = await r.alice(url('Lecture 3'), { method: 'POST', text: NOTES, type: 'text/markdown' })
    assert.equal(added.status, 201)
    assert.equal(added.json.document.version, 1)
    assert.equal(added.json.document.format, 'markdown')
    assert.equal(added.json.document.chunkCount, 2)
    assert.equal((await r.alice(url('Plain'), { method: 'POST', text: 'plain words about joins', type: 'text/plain' })).json.document.format, 'text')

    const same = await r.alice(url('Lecture 3'), { method: 'POST', text: NOTES, type: 'text/markdown' })
    assert.equal(same.status, 200)
    assert.equal(same.json.unchanged, true)
    const v2 = await r.alice(url('Lecture 3'), { method: 'POST', text: `${NOTES}\n\nBoyce-Codd normal form is stricter.`, type: 'text/markdown' })
    assert.equal(v2.json.document.version, 2)

    const docs = (await r.alice(`/courses/${course.id}/documents`)).json.documents
    assert.deepEqual(docs.map((d) => d.title).sort(), ['Lecture 3', 'Plain'])
    assert.ok(!JSON.stringify(docs).includes('nothing but the key'), 'listing never carries the text')

    const found = (await r.alice(`/search?course=${course.id}&q=${encodeURIComponent('third normal form')}`)).json
    assert.equal(found.passages[0].headingPath, 'Normalisation > Third normal form')
    assert.equal(found.passages[0].label, 'S1')

    // nobody else can see, search, add to or delete it
    assert.equal((await r.bob(`/courses/${course.id}/documents`)).status, 404)
    assert.equal((await r.bob(url('x'), { method: 'POST', text: 'hello', type: 'text/plain' })).status, 404)
    assert.equal((await r.bob(`/search?course=${course.id}&q=normal`)).status, 404)
    assert.equal((await r.bob(`/documents/${docs[0].id}`, { method: 'DELETE' })).status, 404)
    assert.equal((await r.bob('/search?q=normalisation')).json.passages.length, 0)

    assert.equal((await r.alice(`/documents/${docs[0].id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await r.alice(`/documents/${docs[0].id}`, { method: 'DELETE' })).status, 404)
    const lane = (await r.alice('/memory')).json.lanes.knowledge.documents
    assert.equal(lane.length, 1)
    const exported = (await r.alice('/memory/export?documents=full')).json
    assert.ok(exported.documents[0].text.length > 0)
    assert.equal((await r.alice(`/memory/lane/knowledge?course=${course.id}`, { method: 'DELETE' })).json.removed, 1)
  })
})

test('only text and markdown are accepted, with plain reasons for everything else', async () => {
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'C' } })).json
    const url = (extra = '') => `/courses/${course.id}/documents?title=Doc${extra}`
    const refused = await r.alice(url(), { method: 'POST', text: '%PDF-1.4 binary', type: 'application/pdf' })
    assert.equal(refused.status, 415)
    assert.equal(refused.json.code, 'text-only')
    assert.match(refused.json.error, /PDFs and images are not accepted/)
    assert.equal((await r.alice(url(), { method: 'POST', text: '   \n', type: 'text/plain' })).json.code, 'empty-document')
    assert.equal((await r.alice(`/courses/${course.id}/documents`, { method: 'POST', text: 'no title', type: 'text/plain' })).json.code, 'invalid-input')
    assert.equal((await r.alice(url('&type=poster'), { method: 'POST', text: 'x y z', type: 'text/plain' })).json.code, 'invalid-input')
    assert.equal((await r.alice(url(), { method: 'POST', text: 'x'.repeat(3 * 1024 * 1024), type: 'text/plain' })).status, 413)
    assert.equal((await r.alice(url(), { method: 'POST', text: 'x'.repeat(700_000), type: 'text/plain' })).json.code, 'document-too-large')
    assert.equal((await r.alice('/courses/nope/documents?title=x', { method: 'POST', text: 'abc def', type: 'text/plain' })).status, 404)
  })
})

test('searching another of your courses needs a stated reason; a lecture that is not yours is "not found"', async () => {
  await using(async (r) => {
    const a = (await r.alice('/courses', { method: 'POST', body: { title: 'A' } })).json
    const b = (await r.alice('/courses', { method: 'POST', body: { title: 'B' } })).json
    await r.alice(`/courses/${b.id}/documents?title=BDoc`, { method: 'POST', text: 'handshake exchanges session keys', type: 'text/plain' })
    const noReason = await r.alice(`/search?course=${a.id}&also=${b.id}&q=session+keys`)
    assert.equal(noReason.status, 400)
    assert.equal(noReason.json.code, 'cross-course-needs-reason')
    const ok = await r.alice(`/search?course=${a.id}&also=${b.id}&q=session+keys&reason=${encodeURIComponent('networks covers encryption keys')}`)
    assert.equal(ok.json.crossCourse, true)
    assert.equal(ok.json.passages[0].crossCourse, true)
    const lecture = await r.alice(`/courses/${a.id}/documents/from-meeting`, { method: 'POST', body: { meetingId: 'someone-elses' } })
    assert.equal(lecture.status, 503, 'this test server has no meetings (503 is the plain answer)')
  })
})

test('the lectures to choose from: a person gets a list (here empty: this server has no meetings), a visitor and the shared code get nothing', async () => {
  await using(async (r) => {
    const mine = await r.alice('/meetings')
    assert.equal(mine.status, 200)
    assert.deepEqual(mine.json, { lectures: [] })
    assert.equal((await r.nobody('/meetings')).status, 401)
  })
})

test('study sessions over HTTP: start with a declared type, pause, resume, stop; the type cannot be changed and a restricted session refuses capture', async () => {
  await using(async (r) => {
    assert.equal((await r.alice('/sessions/current')).json.session, null)
    assert.equal((await r.alice('/sessions', { method: 'POST', body: {} })).json.code, 'invalid-input', 'the type must be declared')
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Database Systems' } })).json
    const started = await r.alice('/sessions', { method: 'POST', body: { type: 'study', courseId: course.id, captureEnabled: true, topic: 'normal forms' } })
    assert.equal(started.status, 201)
    const id = started.json.id
    assert.equal((await r.alice('/sessions/current')).json.session.id, id)
    assert.equal((await r.alice(`/sessions/${id}/pause`, { method: 'POST' })).json.status, 'paused')
    assert.equal((await r.alice(`/sessions/${id}/resume`, { method: 'POST' })).json.status, 'active')
    const patched = await r.alice(`/sessions/${id}`, { method: 'PATCH', body: { topic: 'joins', type: 'restricted' } })
    assert.equal(patched.json.activeTopic, 'joins')
    assert.equal(patched.json.sessionType, 'study', 'the type in the request is ignored')
    assert.equal((await r.bob(`/sessions/${id}`)).status, 404, 'bob cannot see it')
    assert.equal((await r.bob(`/sessions/${id}/stop`, { method: 'POST' })).status, 404)
    assert.equal((await r.alice(`/sessions/${id}/stop`, { method: 'POST' })).json.status, 'ended')
    assert.equal((await r.alice(`/sessions/${id}/resume`, { method: 'POST' })).json.code, 'session-ended')

    const restricted = await r.alice('/sessions', { method: 'POST', body: { type: 'restricted' } })
    assert.equal(restricted.json.captureEnabled, false)
    assert.equal((await r.alice('/sessions', { method: 'POST', body: { type: 'restricted', captureEnabled: true } })).json.code, 'restricted-no-capture')
    const again = (await r.alice('/sessions', { method: 'POST', body: { type: 'restricted' } })).json
    const refused = await r.alice(`/sessions/${again.id}/captures`, { method: 'POST', raw: png(), type: 'image/png' })
    assert.equal(refused.status, 403)
    assert.equal(refused.json.code, 'restricted-assessment')
    assert.equal(refused.json.details.offer, 'explain_concept')
    assert.equal(r.vision.calls.length, 0, 'the model was never asked')
  })
})

test('a screenshot sent to a study session is read; the questions are listed; other kinds of body are refused', async () => {
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Database Systems' } })).json
    const s = (await r.alice('/sessions', { method: 'POST', body: { type: 'practice', courseId: course.id, captureEnabled: true } })).json
    const read = await r.alice(`/sessions/${s.id}/captures`, { method: 'POST', raw: png(), type: 'image/png' })
    assert.equal(read.status, 200)
    assert.equal(read.json.status, 'recognised')
    assert.equal(read.json.questions[0].task, 'explain')
    assert.equal(read.json.context.courseId, course.id)
    const listed = (await r.alice(`/sessions/${s.id}/questions`)).json.questions
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, read.json.questions[0].id)
    assert.equal((await r.bob(`/sessions/${s.id}/questions`)).status, 404)
    assert.equal((await r.bob(`/sessions/${s.id}/captures`, { method: 'POST', raw: png(), type: 'image/png' })).status, 404)
    assert.equal((await r.alice(`/sessions/${s.id}/captures`, { method: 'POST', text: 'not a picture', type: 'text/plain' })).json.code, 'invalid-image')
    assert.equal((await r.alice(`/sessions/${s.id}/captures`, { method: 'POST', raw: Buffer.from('not a picture at all but long enough'), type: 'image/png' })).json.code, 'invalid-image')
    assert.equal((await r.alice(`/sessions/${s.id}/captures`, { method: 'POST', raw: Buffer.alloc(5_000_000, 1), type: 'image/png' })).status, 413)
    assert.equal((await r.nobody(`/sessions/${s.id}/captures`, { method: 'POST', raw: png(), type: 'image/png' })).status, 401)
  })
})

test('answering over HTTP: a typed question, a question from the screen, a concept in a restricted session, and the application\'s refusals', async () => {
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Database Systems' } })).json
    await r.alice(`/courses/${course.id}/documents?title=Lecture+3`, { method: 'POST', text: '# Normalisation\n\n## Third normal form\n\nNo transitive dependency on the key.', type: 'text/markdown' })
    const conversation = r.conversations.forOwner(r.t.who.alice).createSession({}).id
    const s = (await r.alice('/sessions', { method: 'POST', body: { type: 'study', courseId: course.id, captureEnabled: true } })).json

    const typed = await r.alice(`/sessions/${s.id}/ask`, { method: 'POST', body: { text: 'What is third normal form?', conversationId: conversation } })
    assert.equal(typed.status, 200)
    assert.equal(typed.json.status, 'answered')
    assert.equal(typed.json.grounding, 'course')
    assert.match(typed.json.markdown, /\*\*Sources\*\*/)
    assert.equal(typed.json.savedToConversation, true)

    const read = (await r.alice(`/sessions/${s.id}/captures`, { method: 'POST', raw: png(), type: 'image/png' })).json
    const fromScreen = await r.alice(`/sessions/${s.id}/questions/${read.questions[0].id}/answer`, { method: 'POST', body: { conversationId: conversation, style: 'simpler' } })
    assert.equal(fromScreen.json.status, 'answered')
    assert.equal(fromScreen.json.approach, 'simpler')
    assert.equal((await r.alice(`/sessions/${s.id}/ask`, { method: 'POST', body: { text: '' } })).json.code, 'invalid-input')
    assert.equal((await r.bob(`/sessions/${s.id}/ask`, { method: 'POST', body: { text: 'What is a key?' } })).status, 404)
    assert.equal((await r.nobody(`/sessions/${s.id}/ask`, { method: 'POST', body: { text: 'What is a key?' } })).status, 401)

    const restricted = (await r.alice('/sessions', { method: 'POST', body: { type: 'restricted', courseId: course.id } })).json
    const callsBefore = r.model.calls.length
    const refused = await r.alice(`/sessions/${restricted.id}/ask`, { method: 'POST', body: { text: 'What is third normal form?' } })
    assert.equal(refused.status, 403)
    assert.equal(refused.json.code, 'restricted-assessment')
    assert.equal(refused.json.details.offer, 'explain_concept')
    assert.equal(r.model.calls.length, callsBefore, 'the model was not asked')
    const concept = await r.alice(`/sessions/${restricted.id}/concept`, { method: 'POST', body: { concept: 'third normal form' } })
    assert.equal(concept.json.status, 'answered')
    assert.match(r.model.calls.at(-1)[0].content, /RESTRICTED assessment context/)
    const pasted = await r.alice(`/sessions/${restricted.id}/concept`, { method: 'POST', body: { concept: 'Explain why a table in 2NF may still fail 3NF and give a worked example with a schema of five attributes' } })
    assert.equal(pasted.status, 400)
    assert.equal(pasted.json.code, 'concept-looks-like-question')
  })
})

test('feedback, progress and saved concepts over HTTP; the person\'s learning is theirs alone, and can be switched off', async () => {
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Databases' } })).json
    const fb = (body) => r.alice('/feedback', { method: 'POST', body: { courseId: course.id, topic: 'joins', ...body } })
    assert.equal((await fb({ kind: 'misunderstanding', note: 'mixes up inner and outer' })).json.recorded, true)
    assert.equal((await fb({ kind: 'not_helpful' })).json.experience.difficulty, 'needs_practice')
    assert.equal((await fb({ kind: 'sulking' })).json.code, 'invalid-input')
    assert.equal((await fb({ kind: 'helpful', approach: 'telepathy' })).status, 400)
    const progress = (await r.alice(`/progress?course=${course.id}`)).json
    assert.equal(progress.topics[0].topic, 'joins')
    assert.deepEqual(progress.suggestedReview.map((x) => x.topic), ['joins'])
    assert.equal((await r.alice('/progress?course=nope')).status, 404)
    assert.equal((await r.bob('/progress')).json.topics.length, 0)
    assert.equal((await r.bob('/feedback', { method: 'POST', body: { kind: 'helpful', courseId: course.id, topic: 'joins' } })).json.code, 'course-not-found')
    const mem = (await r.alice('/memory')).json.lanes.experience.items[0]
    assert.equal((await r.alice(`/memory/experiences/${mem.id}/reviewed`, { method: 'POST' })).json.lastReviewedAt !== null, true)
    assert.equal((await r.bob(`/memory/experiences/${mem.id}/reviewed`, { method: 'POST' })).status, 404)

    await r.alice('/profile', { method: 'PUT', body: { adaptiveLearning: false } })
    assert.deepEqual((await fb({ kind: 'not_helpful', topic: 'indexing' })).json, { recorded: false, reason: 'adaptive-learning-off' })
    assert.equal((await r.alice('/memory')).json.lanes.experience.items.every((e) => e.topic === 'joins'), true)

    const saved = await r.alice('/feedback', { method: 'POST', body: { kind: 'save_concept', courseId: course.id, topic: 'inner joins', text: '# Inner join\n\nKeeps only the rows that match on both sides.' } })
    assert.equal(saved.status, 201, 'keeping an explanation is the student\'s own act: it works with adaptive learning off')
    assert.equal(saved.json.document.title, 'Saved concept: inner joins')
    assert.match((await r.alice(`/search?course=${course.id}&q=inner+join+rows`)).json.passages[0].text, /Keeps only the rows/)
    assert.equal((await r.alice('/feedback', { method: 'POST', body: { kind: 'save_concept', courseId: 'nope', topic: 'x', text: 'y z' } })).status, 404)
  })
})

test('research over HTTP is labelled and counted; a person with no sign-in cannot use it', async () => {
  await using(async (r) => {
    const found = await r.alice('/research?q=relational+model')
    assert.equal(found.status, 200)
    assert.equal(found.json.works[0].verified, true)
    assert.equal(found.json.works[0].url, 'https://doi.org/10.1145/362384.362685')
    assert.equal((await r.nobody('/research?q=x')).status, 401)
    assert.equal((await r.legacy('/research?q=x')).status, 403)
    assert.ok(r.t.audits.some((a) => a.event === 'academic.research' && a.detail.verified === 1))
  })
})
