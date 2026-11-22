import express from 'express'
import { AcademicError } from '../academic/academicError.js'

/**
 * The study-session group of the academic routes (added to /api/v1/assistant/academic):
 *
 *   POST   /sessions                 { type: 'study'|'practice'|'restricted', courseId?, topic?, captureEnabled?, autoAnswer?, useResearch? } -> 201
 *                                    (a restricted session refuses captureEnabled and autoAnswer; starting one ends the person's earlier session)
 *   GET    /sessions/current         { session: {...}|null }
 *   GET    /sessions/:id
 *   PATCH  /sessions/:id             { topic?, courseId?, captureEnabled?, autoAnswer?, useResearch? }   (the TYPE can never be changed)
 *   POST   /sessions/:id/pause | /resume | /stop
 *   POST   /sessions/:id/captures    body = a screenshot (image/png|jpeg|webp): read with the vision model; the segments of content on it are matched
 *                                    against what the session has seen (new, seen, grown, continued) and its questions returned
 *   GET    /sessions/:id/questions   the questions recognised so far
 *   GET    /sessions/:id/content     every segment of content the session has seen (once each, with how often it was seen)
 *
 * Errors carry a stable code: session-required, session-paused, session-ended, session-expired, restricted-assessment (with the offer of
 * a conceptual explanation), capture-off, capture-busy, capture-rate-limited (+ Retry-After), session-limit, read-failed, invalid-image.
 */

const MAX_IMAGE_BYTES = 4_000_000

export function addSessionRoutes(router, { wrap, body }, { sessionManager, captureService }) {
  const sessions = (req) => sessionManager.forOwner(req.academic.userId)
  const ctxOf = (req) => ({ identity: req.identity, meter: req.meter, requestId: req.id })

  router.post('/sessions', wrap((req, res) => res.status(201).json(sessions(req).start(body(req)))))

  router.get('/sessions/current', wrap((req, res) => res.json({ session: sessions(req).current() })))

  router.get(
    '/sessions/:id',
    wrap((req, res) => {
      const session = sessions(req).get(req.params.id)
      if (!session) throw new AcademicError(404, 'session-not-found', 'That study session does not exist.')
      res.json(session)
    })
  )

  router.patch('/sessions/:id', wrap((req, res) => res.json(sessions(req).update(req.params.id, body(req)))))
  router.post('/sessions/:id/pause', wrap((req, res) => res.json(sessions(req).pause(req.params.id))))
  router.post('/sessions/:id/resume', wrap((req, res) => res.json(sessions(req).resume(req.params.id))))
  router.post('/sessions/:id/stop', wrap((req, res) => res.json(sessions(req).stop(req.params.id))))

  router.post(
    '/sessions/:id/captures',
    express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES }),
    wrap(async (req, res) => {
      if (!/^image\//i.test(String(req.headers['content-type'] ?? ''))) throw new AcademicError(415, 'invalid-image', 'Send the screenshot itself, as image/png, image/jpeg or image/webp.')
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      res.json(await captureService.forOwner(req.academic.userId).read(req.params.id, { bytes }, ctxOf(req)))
    })
  )

  router.get('/sessions/:id/questions', wrap((req, res) => res.json({ questions: captureService.forOwner(req.academic.userId).questions(req.params.id) })))

  router.get('/sessions/:id/content', wrap((req, res) => res.json({ segments: captureService.forOwner(req.academic.userId).content(req.params.id) })))
}
