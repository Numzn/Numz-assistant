import express, { Router } from 'express'
import { requireIdentity } from '../auth/identity.js'
import { ScreenshotError } from '../screenshots/screenshotService.js'

/**
 * Screenshot Intelligence over HTTP, mounted at /api/v1/assistant/screenshots behind the assistant's access gate (a signed-in person with
 * the chat capability). A screenshot is always attached to one of the person's own conversations (the assistant's session id).
 *
 *   POST   /?conversation=<id>       body = the picture itself (image/png|jpeg|webp); optional headers X-Screenshot-Question (percent-encoded) and
 *                                    X-Screenshot-Id (a UUID the page chooses, so it can cancel or delete one whose answer it never saw; 409 if used)
 *                                    -> 202 { id, status: 'analyzing', ... }          the analysis runs in the background
 *   GET    /:id                      -> { id, status: analyzing|ready|failed|cancelled, analysis?, error?, retryable?, pictureKept, ... }
 *   POST   /:id/cancel               -> the same shape; nothing is written to the conversation
 *   POST   /:id/retry                -> the same shape; runs a failed or cancelled analysis again on the picture still held (410 if dropped)
 *   POST   /:id/ask  { question }    -> { id, question, answer, asks }   a follow-up that looks at the picture again (410 once it is dropped)
 *   DELETE /:id[?conversation=<id>]  -> 204; idempotent; removes the picture and the screenshot's messages from the conversation
 *
 * The picture is the raw body (not base64 in JSON), and nothing here is cacheable. Errors are ScreenshotErrors for the shared error
 * handler: a stable `code` the page acts on, and a message fit to show.
 */

const wrap = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next)

function contextOf(req) {
  const identity = requireIdentity(req)
  return { owner: identity.ownerKey, identity, meter: req.meter, requestId: req.id }
}

function questionHeader(req) {
  const raw = req.headers['x-screenshot-question']
  if (typeof raw !== 'string' || !raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new ScreenshotError(400, 'invalid-question', 'The question could not be read.')
  }
}

export function createScreenshotRouter({ service }) {
  const router = Router()
  const maxImageBytes = service.limits.maxImageBytes

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  router.post(
    '/',
    express.raw({ type: 'image/*', limit: maxImageBytes }),
    wrap(async (req, res) => {
      const type = String(req.headers['content-type'] ?? '')
      if (!/^image\//i.test(type)) throw new ScreenshotError(415, 'invalid-image', 'Send the screenshot itself, as image/png, image/jpeg or image/webp.')
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const wanted = typeof req.headers['x-screenshot-id'] === 'string' ? req.headers['x-screenshot-id'] : undefined
      const shot = await service.attach(String(req.query.conversation ?? ''), { bytes }, { question: questionHeader(req), id: wanted }, contextOf(req))
      res.status(202).json(shot)
    })
  )

  router.get('/:id', wrap(async (req, res) => res.json(service.get(req.params.id, contextOf(req)))))
  router.post('/:id/cancel', wrap(async (req, res) => res.json(service.cancel(req.params.id, contextOf(req)))))
  router.post('/:id/retry', wrap(async (req, res) => res.json(service.retry(req.params.id, contextOf(req)))))

  router.post(
    '/:id/ask',
    wrap(async (req, res) => {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
      res.json(await service.ask(req.params.id, { question: body.question }, contextOf(req)))
    })
  )

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      service.remove(req.params.id, { conversationId: typeof req.query.conversation === 'string' ? req.query.conversation : null }, contextOf(req))
      res.status(204).end()
    })
  )

  // Anything thrown above: make the size error one the page recognises, then add Retry-After.
  router.use((err, _req, res, next) => {
    let error = err
    if (err?.type === 'entity.too.large') error = new ScreenshotError(413, 'image-too-large', 'That screenshot is too large. Capture a smaller area, or a window.')
    if (error?.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds))
    next(error)
  })

  return router
}
