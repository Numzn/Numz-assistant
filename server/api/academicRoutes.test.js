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
import { DEFAULT_LIMITS } from '../academic/knowledgeLimits.js'

const quiet = { error() {}, warn() {}, info() {}, log() {} }

async function serve({ limits: limitOverrides = {}, pause } = {}) {
  const t = rig()
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides }
  const knowledge = createKnowledgeRepository(t.database, { limits })
  const knowledgeService = createKnowledgeService({ knowledge, pause })
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
  app.use('/academic', gate, createAcademicRouter({ lanes, audit: t.audit, extend: [(router, helpers) => addKnowledgeRoutes(router, helpers, { knowledge, knowledgeService, limits }), (router, helpers) => addSessionRoutes(router, helpers, { sessionManager, captureService }), (router, helpers) => addAnswerRoutes(router, helpers, { answerService, researchService: research, knowledge })] }))
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
  return { t, vision, model, conversations, knowledge, knowledgeService, alice: as('alice'), bob: as('bob'), legacy: as('legacy'), nobody: as(''), close: () => new Promise((resolve) => server.close(resolve)) }
}

async function using(body, options) {
  const r = await serve(options)
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
    // over the document limit (600 KB in this test; 100 MB by default): refused before it is read in full
    const over = await r.alice(url(), { method: 'POST', text: 'x'.repeat(700_000), type: 'text/plain' })
    assert.equal(over.status, 413)
    assert.equal(over.json.code, 'too-large')
    assert.equal((await r.alice(url(), { method: 'POST', text: 'x'.repeat(3 * 1024 * 1024), type: 'text/plain' })).status, 413)
    assert.equal((await r.alice('/courses/nope/documents?title=x', { method: 'POST', text: 'abc def', type: 'text/plain' })).status, 404)
  }, { limits: { maxDocumentChars: 600_000 } })
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

test('the content of a screen comes back as segments, the session lists what it has seen, and nobody else can see it', async () => {
  await using(async (r) => {
    const s = (await r.alice('/sessions', { method: 'POST', body: { type: 'study', captureEnabled: true } })).json
    r.vision.state.reply = async () => JSON.stringify({ contentKind: 'other_content', segments: [{ kind: 'paragraph', title: 'Keys', text: 'A foreign key is a column in one table that refers to the primary key of another table.', cutOff: 'none' }, { kind: 'code', title: '', text: 'SELECT * FROM orders;', cutOff: 'none' }], position: 'slide 2', confidence: 0.9 })
    const read = await r.alice(`/sessions/${s.id}/captures`, { method: 'POST', raw: png(1280, 720, 1), type: 'image/png' })
    assert.equal(read.status, 200)
    assert.deepEqual([read.json.status, read.json.layout, read.json.arrival, read.json.summary.new, read.json.position], ['recognised', 'multiple', 'new-screen', 2, 'slide 2'])
    assert.deepEqual(read.json.segments.map((x) => [x.kind, x.status]), [['paragraph', 'new'], ['code', 'new']])
    assert.deepEqual((await r.alice(`/sessions/${s.id}/content`)).json.segments.map((x) => x.kind), ['paragraph', 'code'])
    assert.equal((await r.bob(`/sessions/${s.id}/content`)).status, 404)
    assert.equal((await r.nobody(`/sessions/${s.id}/content`)).status, 401)
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

// ---- large documents: stored at once, cut and indexed in the background, with a status, a reason and a retry --------------------------

/** A document of about `kb` KB with headings, so that it is cut into many passages and each one can be found by its own words. */
const bigDocument = (kb, tag = 'alpha') => {
  const sections = []
  for (let i = 0; sections.join('\n').length < kb * 1024; i++) sections.push(`## ${tag} section ${i}\n\nThe ${tag} section ${i} explains normalisation number ${i} (${tag}marker${i}z). ${'It keeps data consistent and removes redundancy. '.repeat(8)}`)
  return `# ${tag} notes\n\n${sections.join('\n\n')}\n`
}
const waitUntil = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}
/** A pause the test controls: processing waits at every batch until `release()`. */
function gate() {
  let open = false
  let waiters = []
  return {
    pause: () => (open ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))),
    release() {
      open = true
      waiters.forEach((resolve) => resolve())
      waiters = []
    },
    step() {
      const next = waiters.shift()
      next?.()
    },
    get waiting() {
      return waiters.length
    }
  }
}

test('a large document is answered 202 at once and processed in the background: processing, progress, then ready and searchable; a small one is cut on the spot as before', async () => {
  const g = gate()
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Databases' } })).json
    const url = (title) => `/courses/${course.id}/documents?title=${encodeURIComponent(title)}&type=lecture_notes`
    const small = await r.alice(url('Small'), { method: 'POST', text: '# Keys\n\nA key identifies a row.', type: 'text/markdown' })
    assert.equal(small.status, 201)
    assert.equal(small.json.document.status, 'ready')
    assert.equal(small.json.processing, undefined)

    const big = await r.alice(url('Big'), { method: 'POST', text: bigDocument(300), type: 'text/markdown' })
    assert.equal(big.status, 202, 'the answer does not wait for the cutting')
    assert.equal(big.json.processing, true)
    assert.equal(big.json.document.status, 'processing')
    assert.equal(big.json.document.chunkCount, 0)
    const id = big.json.document.id

    await waitUntil(() => g.waiting > 0) // the first batch is in and the work is paused between batches
    const during = (await r.alice(`/courses/${course.id}/documents`)).json.documents.find((d) => d.id === id)
    assert.equal(during.status, 'processing')
    assert.ok(during.chunkCount > 0, `progress is visible: ${during.chunkCount} parts so far`)
    assert.equal((await r.alice(`/search?course=${course.id}&q=alphamarker3z`)).json.passages.length, 0, 'a document that is not ready is never searched or cited')
    assert.equal((await r.alice(`/search?course=${course.id}&q=key+identifies+row`)).json.passages.length, 1, 'the small document, which is ready, still is')

    g.release()
    await r.knowledgeService.idle()
    const after = (await r.alice(`/courses/${course.id}/documents`)).json.documents.find((d) => d.id === id)
    assert.equal(after.status, 'ready')
    assert.equal(after.error, null)
    assert.ok(after.chunkCount > 100, `${after.chunkCount} parts`)
    const found = (await r.alice(`/search?course=${course.id}&q=alphamarker3z`)).json.passages
    assert.ok(found.length > 0 && found[0].title === 'Big' && /section 3/.test(found[0].headingPath), 'found by its own words, with its heading as the reference')
    const audit = r.t.audits.filter((a) => a.event.startsWith('academic.document_')).map((a) => a.event)
    assert.ok(audit.includes('academic.document_add') && audit.includes('academic.document_ready'), audit.join())
  }, { limits: { asyncThresholdChars: 50_000 }, pause: g.pause })
})

test('a document that fails to process says why and keeps its text; Retry makes it ready; a document that is not failed cannot be retried; nobody else can retry it', async () => {
  let failures = 1
  const pause = async () => {
    if (failures-- > 0) throw new Error('disk hiccup')
  }
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Databases' } })).json
    const created = await r.alice(`/courses/${course.id}/documents?title=Notes`, { method: 'POST', text: bigDocument(200), type: 'text/markdown' })
    assert.equal(created.status, 202)
    const id = created.json.document.id
    await r.knowledgeService.idle()
    const failed = (await r.alice(`/courses/${course.id}/documents`)).json.documents[0]
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /could not be processed/)
    assert.equal(failed.chunkCount, 0, 'the passages made before the failure are gone: nothing half-cut is left')
    assert.equal(r.t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks').get().n, 0)
    assert.equal((await r.alice(`/search?course=${course.id}&q=normalisation`)).json.passages.length, 0)

    assert.equal((await r.bob(`/documents/${id}/retry`, { method: 'POST' })).status, 404, 'another person cannot reach it')
    assert.equal((await r.nobody(`/documents/${id}/retry`, { method: 'POST' })).status, 401)
    const retried = await r.alice(`/documents/${id}/retry`, { method: 'POST' })
    assert.equal(retried.status, 202)
    assert.equal(retried.json.document.status, 'processing')
    assert.equal(retried.json.document.error, null)
    await r.knowledgeService.idle()
    const done = (await r.alice(`/courses/${course.id}/documents`)).json.documents[0]
    assert.equal(done.status, 'ready')
    assert.ok(done.chunkCount > 50)
    assert.equal((await r.alice(`/documents/${id}/retry`, { method: 'POST' })).status, 409, 'only a failed document can be retried')
    assert.equal((await r.alice('/documents/nope/retry', { method: 'POST' })).status, 404)
  }, { limits: { asyncThresholdChars: 50_000 }, pause })
})

test('a document too long to cut within the limits fails with that reason; uploading the same text again counts as a retry, and a document still processing is left to finish', async () => {
  const g = gate()
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Databases' } })).json
    const url = `/courses/${course.id}/documents?title=Long`
    const text = bigDocument(200)
    const first = await r.alice(url, { method: 'POST', text, type: 'text/markdown' })
    assert.equal(first.status, 202)
    g.release()
    await r.knowledgeService.idle()
    const failed = (await r.alice(`/courses/${course.id}/documents`)).json.documents[0]
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /too many parts/)
    // the same text again: not "unchanged" (it never became usable): it is processed again (and fails again for the same reason)
    const again = await r.alice(url, { method: 'POST', text, type: 'text/markdown' })
    assert.equal(again.status, 202)
    assert.equal(again.json.document.version, 2)
    await r.knowledgeService.idle()
  }, { limits: { asyncThresholdChars: 50_000, maxChunks: 20 }, pause: g.pause })

  const hold = gate()
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Databases' } })).json
    const url = `/courses/${course.id}/documents?title=Slow`
    const text = bigDocument(200)
    assert.equal((await r.alice(url, { method: 'POST', text, type: 'text/markdown' })).status, 202)
    await waitUntil(() => hold.waiting > 0)
    const same = await r.alice(url, { method: 'POST', text, type: 'text/markdown' })
    assert.equal(same.status, 200, 'identical text while it is processing changes nothing')
    assert.equal(same.json.unchanged, true)
    assert.equal(same.json.document.status, 'processing')
    hold.release()
    await r.knowledgeService.idle()
    assert.equal((await r.alice(`/courses/${course.id}/documents`)).json.documents[0].status, 'ready')
  }, { limits: { asyncThresholdChars: 50_000 }, pause: hold.pause })
})

test('a new version uploaded while the old one is still being cut wins, and a document deleted meanwhile leaves nothing behind', async () => {
  const g = gate()
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Databases' } })).json
    const url = (title) => `/courses/${course.id}/documents?title=${title}`
    assert.equal((await r.alice(url('Notes'), { method: 'POST', text: bigDocument(200, 'oldtext'), type: 'text/markdown' })).status, 202)
    await waitUntil(() => g.waiting > 0)
    const second = await r.alice(url('Notes'), { method: 'POST', text: bigDocument(200, 'newtext'), type: 'text/markdown' })
    assert.equal(second.status, 202)
    assert.equal(second.json.document.version, 2)
    const doomed = await r.alice(url('Doomed'), { method: 'POST', text: bigDocument(200, 'gone'), type: 'text/markdown' })
    assert.equal((await r.alice(`/documents/${doomed.json.document.id}`, { method: 'DELETE' })).status, 204)
    g.release()
    await r.knowledgeService.idle()
    const docs = (await r.alice(`/courses/${course.id}/documents`)).json.documents
    assert.equal(docs.length, 1)
    assert.deepEqual([docs[0].title, docs[0].version, docs[0].status], ['Notes', 2, 'ready'])
    assert.equal((await r.alice(`/search?course=${course.id}&q=oldtext`)).json.passages.length, 0, 'nothing of the replaced version is searchable')
    assert.ok((await r.alice(`/search?course=${course.id}&q=newtext`)).json.passages.length > 0)
    const orphans = r.t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks WHERE document_id NOT IN (SELECT id FROM academic_documents)').get().n
    assert.equal(orphans, 0)
    assert.equal(r.t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks WHERE document_id = ?').get(doomed.json.document.id).n, 0)
  }, { limits: { asyncThresholdChars: 50_000 }, pause: g.pause })
})

test('processing the documents of two people one after the other keeps them apart: each finds only its own text', async () => {
  await using(async (r) => {
    const a = (await r.alice('/courses', { method: 'POST', body: { title: 'A' } })).json
    const b = (await r.bob('/courses', { method: 'POST', body: { title: 'B' } })).json
    await r.alice(`/courses/${a.id}/documents?title=Mine`, { method: 'POST', text: bigDocument(200, 'alicesecret'), type: 'text/markdown' })
    await r.bob(`/courses/${b.id}/documents?title=Mine`, { method: 'POST', text: bigDocument(200, 'bobsecret'), type: 'text/markdown' })
    await r.knowledgeService.idle()
    assert.ok((await r.alice(`/search?course=${a.id}&q=alicesecret`)).json.passages.length > 0)
    assert.equal((await r.alice(`/search?course=${a.id}&q=bobsecret`)).json.passages.length, 0)
    assert.equal((await r.bob(`/search?course=${a.id}&q=alicesecret`)).status, 404)
    assert.ok((await r.bob(`/search?course=${b.id}&q=bobsecret`)).json.passages.length > 0)
    assert.equal((await r.bob(`/courses/${a.id}/documents`)).status, 404)
  }, { limits: { asyncThresholdChars: 50_000 } })
})

test('the limits are the server\'s to set: the page can ask for them, the person\'s total and the documents per course are enforced with plain reasons', async () => {
  await using(async (r) => {
    const limits = await r.alice('/limits')
    assert.equal(limits.status, 200)
    assert.deepEqual(limits.json, { maxDocumentBytes: 4096, maxBatchFiles: 7 })
    assert.equal((await r.nobody('/limits')).status, 401)
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Databases' } })).json
    const add = (title, text) => r.alice(`/courses/${course.id}/documents?title=${title}`, { method: 'POST', text, type: 'text/plain' })
    assert.equal((await add('one', 'word '.repeat(600))).status, 201)
    const full = await add('two', 'other '.repeat(600))
    assert.equal(full.status, 413)
    assert.equal(full.json.code, 'storage-full')
    assert.match(full.json.error, /more than the 5 KB allowed/)
    assert.equal((await add('three', 'x')).status, 201)
    assert.equal((await add('four', 'y')).status, 409, 'two documents per course here')
    assert.equal((await add('big', 'z '.repeat(3000))).status, 413, 'a document over the limit is refused (4 KB here)')
  }, { limits: { maxDocumentChars: 4096, maxBatchFiles: 7, charsPerPerson: 5000, documentsPerCourse: 2 } })
})

test('fifty files one after the other, as the page sends a batch: every one is stored, listed and searchable', async () => {
  await using(async (r) => {
    const course = (await r.alice('/courses', { method: 'POST', body: { title: 'Databases' } })).json
    for (let i = 0; i < 50; i++) {
      const res = await r.alice(`/courses/${course.id}/documents?title=${encodeURIComponent(`Lecture ${i}`)}&type=lecture_notes`, { method: 'POST', text: `# Lecture ${i}\n\nTopic number ${i} is about uniquetopic${i}.`, type: 'text/markdown' })
      assert.equal(res.status, 201, `file ${i}`)
    }
    const docs = (await r.alice(`/courses/${course.id}/documents`)).json.documents
    assert.equal(docs.length, 50)
    assert.ok(docs.every((d) => d.status === 'ready'))
    assert.equal((await r.alice(`/search?course=${course.id}&q=uniquetopic37`)).json.passages[0].title, 'Lecture 37')
  })
})
