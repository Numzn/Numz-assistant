import express from 'express'
import { AcademicError, textField } from '../academic/academicError.js'

/**
 * The course-materials group of the academic routes (added to /api/v1/assistant/academic):
 *
 *   GET    /courses/:id/documents                 the course's documents (no text)
 *   POST   /courses/:id/documents?title=&type=&format=   body = the text or markdown itself (text/markdown or text/plain), at most 2 MB
 *                                                 -> 201 { document, unchanged?, replaced? }
 *   POST   /courses/:id/documents/from-meeting    { meetingId, title? }  a finished lecture of the person's own becomes course material
 *   DELETE /documents/:id                         204
 *   GET    /search?course=<id>&q=&also=<id,id>&reason=&limit=   passages that match (the same retrieval an answer uses)
 *
 * Only text and markdown are accepted: a PDF or an image is refused with a plain reason.
 */

const MAX_BYTES = 2 * 1024 * 1024

export function addKnowledgeRoutes(router, { wrap, body, audit }, { knowledge, knowledgeService }) {
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

  router.post(
    '/courses/:id/documents',
    express.text({ type: ['text/markdown', 'text/plain', 'text/x-markdown'], limit: MAX_BYTES }),
    wrap((req, res) => {
      const type = String(req.headers['content-type'] ?? '')
      if (!/^text\//i.test(type) || typeof req.body !== 'string') {
        throw new AcademicError(415, 'text-only', 'Send the document as text or markdown (Content-Type: text/markdown or text/plain). PDFs and images are not accepted here.')
      }
      const format = typeof req.query.format === 'string' ? req.query.format : /markdown/i.test(type) ? 'markdown' : null
      const result = mine(req).addDocument({
        courseId: req.params.id,
        title: textField(typeof req.query.title === 'string' ? req.query.title : '', 'title', { max: 160, required: true }),
        sourceType: typeof req.query.type === 'string' ? req.query.type : 'notes',
        format,
        text: req.body
      })
      note(req, 'academic.document_add', { documentId: result.document.id, courseId: req.params.id, chars: result.document.chars, version: result.document.version, unchanged: Boolean(result.unchanged) })
      res.status(result.unchanged ? 200 : 201).json(result)
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
