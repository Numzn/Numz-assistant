import express from 'express'
import { AcademicError, textField } from '../academic/academicError.js'
import { DEFAULT_LIMITS } from '../academic/knowledgeLimits.js'

/**
 * The course-materials group of the academic routes (added to /api/v1/assistant/academic):
 *
 *   GET    /courses/:id/documents                 the course's documents (no text)
 *   POST   /courses/:id/documents?title=&type=&format=   body = the text or markdown itself (text/markdown or text/plain), up to the
 *                                                 server's document limit (100 MB by default, see GET /limits)
 *                                                 -> 201 { document, unchanged?, replaced? }  a document up to the background threshold (1 MB by default)
 *                                                    is cut and searchable at once; a larger one is stored and answered 202 { document: { status:
 *                                                    'processing' }, processing: true } and is cut and indexed in the background
 *   POST   /documents/:id/retry                   a document whose processing failed (status 'failed', with its `error`) is processed again -> 202
 *   GET    /limits                                { maxDocumentBytes, maxBatchFiles }: what the page may send
 *   POST   /courses/:id/documents/from-meeting    { meetingId, title? }  a finished lecture of the person's own becomes course material
 *   GET    /meetings                              the person's own finished lectures, to choose one to add to a course
 *   DELETE /documents/:id                         204
 *   GET    /search?course=<id>&q=&also=<id,id>&reason=&limit=   passages that match (the same retrieval an answer uses)
 *
 * Only text and markdown are accepted: a PDF or an image is refused with a plain reason.
 */

export function addKnowledgeRoutes(router, { wrap, body, audit }, { knowledge, knowledgeService, limits = DEFAULT_LIMITS }) {
  const mine = (req) => knowledge.forOwner(req.academic.userId)
  const service = (req) => knowledgeService.forOwner(req.academic.userId)
  const note = (req, event, detail) => audit(event, { userId: req.academic.userId, detail })

  router.get(
    '/courses/:id/documents',
    wrap((req, res) => {
      if (!req.lanes.getCourse(req.params.id)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
      res.json({ documents: mine(req).listDocuments({ courseId: req.params.id }) })
    })
  )

  router.get('/limits', wrap((req, res) => res.json({ maxDocumentBytes: limits.maxDocumentChars, maxBatchFiles: limits.maxBatchFiles })))

  /** Reports how a background job ended, to the audit log (an outcome nobody was waiting for on a request). */
  const settled = (req, documentId, courseId) => (document) => {
    note(req, document?.status === 'ready' ? 'academic.document_ready' : 'academic.document_failed', { documentId, courseId, chunks: document?.chunkCount, error: document?.error ?? undefined })
  }

  router.post(
    '/courses/:id/documents',
    express.text({ type: ['text/markdown', 'text/plain', 'text/x-markdown'], limit: limits.maxDocumentChars }),
    wrap((req, res) => {
      const type = String(req.headers['content-type'] ?? '')
      if (!/^text\//i.test(type) || typeof req.body !== 'string') {
        throw new AcademicError(415, 'text-only', 'Send the document as text or markdown (Content-Type: text/markdown or text/plain). PDFs and images are not accepted here.')
      }
      const format = typeof req.query.format === 'string' ? req.query.format : /markdown/i.test(type) ? 'markdown' : null
      const input = {
        courseId: req.params.id,
        title: textField(typeof req.query.title === 'string' ? req.query.title : '', 'title', { max: 160, required: true }),
        sourceType: typeof req.query.type === 'string' ? req.query.type : 'notes',
        format,
        text: req.body
      }
      // A small document is cut on the spot, as it always was. A large one is stored now and cut in the background: the answer does not wait for it.
      const large = req.body.length > limits.asyncThresholdChars
      const result = large ? mine(req).beginDocument(input) : mine(req).addDocument(input)
      note(req, 'academic.document_add', { documentId: result.document.id, courseId: req.params.id, chars: result.document.chars, version: result.document.version, unchanged: Boolean(result.unchanged), background: Boolean(result.processing) })
      if (result.processing) {
        service(req).process(result.document.id, { onSettled: settled(req, result.document.id, req.params.id) })
        return res.status(202).json(result)
      }
      res.status(result.unchanged ? 200 : 201).json(result)
    })
  )

  router.post(
    '/documents/:id/retry',
    wrap((req, res) => {
      const found = mine(req).getDocument(req.params.id)
      if (!found) throw new AcademicError(404, 'document-not-found', 'That document does not exist.')
      const document = service(req).retry(req.params.id, { onSettled: settled(req, found.id, found.courseId) })
      note(req, 'academic.document_retry', { documentId: found.id, courseId: found.courseId })
      res.status(202).json({ document, processing: true })
    })
  )

  router.post(
    '/courses/:id/documents/from-meeting',
    wrap((req, res) => {
      const result = service(req).ingestMeeting({ meetingId: body(req).meetingId, courseId: req.params.id, title: body(req).title })
      note(req, 'academic.meeting_ingest', { documentId: result.document.id, courseId: req.params.id, version: result.document.version, unchanged: Boolean(result.unchanged) })
      res.status(result.unchanged ? 200 : 201).json(result)
    })
  )

  router.get('/meetings', wrap((req, res) => res.json({ lectures: service(req).listLectures() })))

  router.delete(
    '/documents/:id',
    wrap((req, res) => {
      const found = mine(req).getDocument(req.params.id)
      if (!found || !mine(req).removeDocument(req.params.id)) throw new AcademicError(404, 'document-not-found', 'That document does not exist.')
      note(req, 'academic.document_delete', { documentId: found.id, courseId: found.courseId })
      res.status(204).end()
    })
  )

  router.get(
    '/search',
    wrap((req, res) => {
      const course = typeof req.query.course === 'string' ? req.query.course : ''
      if (course && !req.lanes.getCourse(course)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
      const also = typeof req.query.also === 'string' ? req.query.also.split(',').map((v) => v.trim()).filter(Boolean) : []
      res.json(service(req).retrieve({ courseId: course || null, query: typeof req.query.q === 'string' ? req.query.q : '', alsoCourseIds: also, reason: typeof req.query.reason === 'string' ? req.query.reason : '', limit: Number.parseInt(req.query.limit ?? '6', 10) || 6 }))
    })
  )
}
