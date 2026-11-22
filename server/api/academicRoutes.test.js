import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { rig } from '../academic/testSupport.js'
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
  const lanes = createMemoryLaneManager({ academic: t.academic, knowledge, audit: t.audit })
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
  app.use('/academic', gate, createAcademicRouter({ lanes, audit: t.audit, extend: [(router, helpers) => addKnowledgeRoutes(router, helpers, { knowledge, knowledgeService })] }))
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}/academic`
  const as = (who) => async (path, { method = 'GET', body, text: textBody, type } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(who ? { 'x-test-user': who } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(type ? { 'content-type': type } : {}) },
      body: textBody !== undefined ? textBody : body === undefined ? undefined : JSON.stringify(body)
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
  return { t, alice: as('alice'), bob: as('bob'), legacy: as('legacy'), nobody: as(''), close: () => new Promise((resolve) => server.close(resolve)) }
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
