import express, { Router } from 'express'
import { CameraError } from '../camera/cameraError.js'
import { requireIdentity } from '../auth/identity.js'

/**
 * The Smart Camera's HTTP routes, mounted at /api/v1/assistant/camera behind the assistant's access gate:
 *
 *   POST   /sessions              start a session                      -> 201 { sessionId, visionConfigured, limits }
 *   POST   /sessions/:id/read     body = the picture itself (image/*)  -> { status, questionId?, question?, answer?, reason? }
 *   POST   /sessions/:id/answer   { questionId, text? }                -> { status: 'answered', questionId, answer, markdown }
 *   DELETE /sessions/:id          clear the session and what was saved -> 204
 *
 * The picture is sent as the raw body, not as base64 inside JSON, so it is a third smaller and never parsed as text.
 * Nothing here is cacheable. Errors go to the shared error handler as CameraErrors (a stable `code`, a message fit to
 * show); a Retry-After header is added when the service says when to come back.
 */

const wrap = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next)

/** Who is asking, and where their usage is counted: the camera session belongs to this person. */
function contextOf(req) {
  const identity = requireIdentity(req)
  return { owner: identity.ownerKey, identity, meter: req.meter, requestId: req.id }
}

export function createCameraRouter({ service }) {
  const router = Router()
  const maxImageBytes = service.limits.maxImageBytes

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  router.post(
    '/sessions',
    wrap(async (_req, res) => {
      res.status(201).json(await service.createSession(contextOf(_req)))
    })
  )

  router.post(
    '/sessions/:id/read',
    express.raw({ type: 'image/*', limit: maxImageBytes }),
    wrap(async (req, res) => {
      const type = String(req.headers['content-type'] ?? '')
      if (!/^image\//i.test(type)) {
        throw new CameraError(415, 'invalid-image', 'Send the picture itself, as image/jpeg, image/png or image/webp.')
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      res.json(await service.read(req.params.id, { bytes, mimeType: type }, contextOf(req)))
    })
  )

  router.post(
    '/sessions/:id/answer',
    wrap(async (req, res) => {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
      res.json(await service.answer(req.params.id, { questionId: body.questionId, text: body.text }, contextOf(req)))
    })
  )

  router.delete(
    '/sessions/:id',
    wrap(async (req, res) => {
      await service.clear(req.params.id, contextOf(req))
      res.status(204).end()
    })
  )

  // Runs for anything thrown above: make the size error one the page recognises, then add Retry-After.
  router.use((err, _req, res, next) => {
    let error = err
    if (err?.type === 'entity.too.large') error = new CameraError(413, 'image-too-large', 'That picture is too large. Try again.')
    if (error?.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds))
    next(error)
  })

  return router
}
