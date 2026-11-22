import { Router } from 'express'
import { requireIdentity } from '../auth/identity.js'
import { AcademicError } from '../academic/academicError.js'

/**
 * Academic Intelligence over HTTP, mounted at /api/v1/assistant/academic behind the assistant's access gate and the `academic` capability.
 * It needs a person's own sign-in: what is kept here is about one student's learning, so the shared access code (the single-tenant
 * fallback) cannot use it.
 *
 *   GET|PUT /profile                       the personal learning profile and the academic profile (lanes 1 and 2) and adaptive learning on/off
 *   GET|POST /courses, PATCH|DELETE /courses/:id   the person's courses (deleting one deletes its documents and learning memories)
 *   GET /memory                            the memory centre: every lane, as stored, for this person only
 *   GET /memory/export[?documents=full]    the academic notes to keep
 *   DELETE /memory/lane/:lane[?course=<id>&confirm=all]   empty one lane (for one course where that makes sense)
 *   PATCH|DELETE /memory/experiences/:id   correct or delete one learning memory
 *   DELETE /memory                         everything academic about this person (needs ?confirm=all)
 *
 * Further groups (documents, sessions, captures, questions, feedback, research) are added by the modules that own them.
 */

export const wrap = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next)

/** The signed-in person behind this request. The single-tenant fallback has no person, so it gets a clear refusal, not a guess. */
export function academicPerson(req) {
  const identity = requireIdentity(req)
  if (identity.legacy === true || !identity.userId) {
    throw new AcademicError(403, 'sign-in-required', 'Academic study needs your own NUMZ AI sign-in: it keeps a private record of your learning.')
  }
  return identity
}

export function createAcademicRouter({ lanes, audit = () => {}, extend = [] }) {
  if (!lanes) throw new Error('the memory lanes are required')
  const router = Router()

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  router.use((req, _res, next) => {
    try {
      req.academic = academicPerson(req)
      req.lanes = lanes.forOwner(req.academic.userId)
      next()
    } catch (err) {
      next(err)
    }
  })

  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {})

  router.get('/profile', wrap((req, res) => res.json(req.lanes.getProfile())))
  router.put('/profile', wrap((req, res) => res.json(req.lanes.updateProfile(body(req)))))

  router.get('/courses', wrap((req, res) => res.json({ courses: req.lanes.listCourses() })))
  router.post('/courses', wrap((req, res) => res.status(201).json(req.lanes.createCourse(body(req)))))
  router.patch(
    '/courses/:id',
    wrap((req, res) => {
      const course = req.lanes.updateCourse(req.params.id, body(req))
      if (!course) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
      res.json(course)
    })
  )
  router.delete(
    '/courses/:id',
    wrap((req, res) => {
      if (!req.lanes.deleteCourse(req.params.id)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
      res.status(204).end()
    })
  )

  router.get('/memory', wrap((req, res) => res.json(req.lanes.inspect())))
  router.get(
    '/memory/export',
    wrap((req, res) => {
      res.set('Content-Disposition', 'attachment; filename="numz-academic-notes.json"')
      res.json(req.lanes.exportAll({ documents: req.query.documents === 'full' ? 'full' : 'list' }))
    })
  )
  router.delete(
    '/memory/lane/:lane',
    wrap((req, res) => res.json(req.lanes.deleteLane(req.params.lane, { courseId: typeof req.query.course === 'string' ? req.query.course : null, confirmAll: req.query.confirm === 'all' })))
  )
  router.patch(
    '/memory/experiences/:id',
    wrap((req, res) => {
      const saved = req.lanes.correctExperience(req.params.id, body(req))
      if (!saved) throw new AcademicError(404, 'memory-not-found', 'That memory does not exist.')
      res.json(saved)
    })
  )
  router.delete(
    '/memory/experiences/:id',
    wrap((req, res) => {
      if (!req.lanes.deleteExperience(req.params.id)) throw new AcademicError(404, 'memory-not-found', 'That memory does not exist.')
      res.status(204).end()
    })
  )
  router.delete(
    '/memory',
    wrap((req, res) => {
      if (req.query.confirm !== 'all') throw new AcademicError(400, 'confirm-required', 'Deleting everything academic needs ?confirm=all.')
      res.json(req.lanes.deleteEverything())
    })
  )

  // Other modules add their own groups here (each receives the router and the shared helpers).
  for (const add of extend) add(router, { wrap, body, audit })

  router.use((err, _req, res, next) => {
    if (err?.type === 'entity.too.large') return next(new AcademicError(413, 'too-large', 'That is too large.'))
    if (err?.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds))
    next(err)
  })
  return router
}
