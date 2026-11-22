import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { rig } from '../academic/testSupport.js'
import { createMemoryLaneManager } from '../academic/memoryLanes.js'
import { LEGACY_IDENTITY, personIdentity } from '../auth/identity.js'
import { errorHandler } from '../http/errorHandler.js'
import { createAcademicRouter } from '../routes/academic.js'

const quiet = { error() {}, warn() {}, info() {}, log() {} }

async function serve() {
  const t = rig()
  const lanes = createMemoryLaneManager({ academic: t.academic, audit: t.audit })
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
  app.use('/academic', gate, createAcademicRouter({ lanes, audit: t.audit }))
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}/academic`
  const as = (who) => async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(who ? { 'x-test-user': who } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
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
