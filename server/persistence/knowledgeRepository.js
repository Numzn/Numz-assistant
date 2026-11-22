import { randomUUID } from 'node:crypto'
import { AcademicError, oneOf, textField } from '../academic/academicError.js'
import { chunkDocument, chunkTranscript, hashText, normalizeText } from '../academic/chunking.js'

/**
 * A person's course materials in the database (migration 10): documents, the passages they were cut into, and the full-text index.
 * Reached only through `forOwner(userId)`; every statement says `owner_user_id = ?`, and a search is always limited to courses that are
 * this person's own, so no query can return another person's passage or another course's passage that was not asked for.
 */

export const SOURCE_TYPES = Object.freeze(['lecture_notes', 'lecture_transcript', 'course_outline', 'study_guide', 'textbook', 'notes', 'research', 'other'])

export const KNOWLEDGE_LIMITS = Object.freeze({ documentsPerCourse: 100, documentsPerPerson: 300, charsPerPerson: 8_000_000 })

const iso = (ms) => new Date(ms).toISOString()

function documentOut(row) {
  return (
    row && {
      id: row.id,
      courseId: row.course_id,
      title: row.title,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      format: row.format,
      version: row.version,
      chars: row.chars,
      chunkCount: row.chunk_count,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  )
}

/**
 * The words of a question as an FTS5 query: every word quoted (so nothing a person types can be read as search syntax), joined with OR
 * so a passage need not contain all of them, the commonest English words left out. Returns '' when nothing searchable is left.
 */
const STOP = new Set('a an the and or but if then so of to in on at by for from with about as is are was were be been being it its this that these those i you he she we they them our your their my me us not no do does did have has had will would can could should may might must what which who whom when where why how into than too'.split(' '))
export function toMatchQuery(text, { maxTerms = 12 } = {}) {
  const words = String(text ?? '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []
  const terms = [...new Set(words.filter((w) => w.length > 1 && !STOP.has(w)))].slice(0, maxTerms)
  return terms.map((term) => `"${term.replace(/"/g, '')}"`).join(' OR ')
}

export function createKnowledgeRepository(database, { clock = Date.now, newId = randomUUID } = {}) {
  const now = () => iso(clock())
  const q = {
    course: database.prepare('SELECT id FROM academic_courses WHERE id = ? AND owner_user_id = ?'),
    documents: database.prepare(
      `SELECT * FROM academic_documents WHERE owner_user_id = ? AND (? IS NULL OR course_id = ?) ORDER BY updated_at DESC, id`
    ),
    document: database.prepare('SELECT * FROM academic_documents WHERE id = ? AND owner_user_id = ?'),
    byTitle: database.prepare('SELECT * FROM academic_documents WHERE owner_user_id = ? AND course_id = ? AND title = ?'),
    bySource: database.prepare('SELECT * FROM academic_documents WHERE owner_user_id = ? AND course_id = ? AND source_ref = ?'),
    counts: database.prepare(
      `SELECT COUNT(*) AS documents, COALESCE(SUM(chars), 0) AS chars, COALESCE(SUM(CASE WHEN course_id = ? THEN 1 ELSE 0 END), 0) AS inCourse
         FROM academic_documents WHERE owner_user_id = ?`
    ),
    countDocs: database.prepare('SELECT COUNT(*) AS n FROM academic_documents WHERE owner_user_id = ? AND (? IS NULL OR course_id = ?)'),
    insertDocument: database.prepare(
      `INSERT INTO academic_documents (id, owner_user_id, course_id, title, source_type, source_ref, format, version, content_hash, chars, chunk_count, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    replaceDocument: database.prepare(
      `UPDATE academic_documents SET title = ?, source_type = ?, source_ref = ?, format = ?, version = ?, content_hash = ?, chars = ?, chunk_count = ?, body = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ?`
    ),
    deleteChunksOf: database.prepare('DELETE FROM academic_chunks WHERE document_id = ? AND owner_user_id = ?'),
    insertChunk: database.prepare(
      `INSERT INTO academic_chunks (document_id, owner_user_id, course_id, seq, heading_path, locator, start_line, end_line, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    deleteDocument: database.prepare('DELETE FROM academic_documents WHERE id = ? AND owner_user_id = ?'),
    deleteDocuments: database.prepare('DELETE FROM academic_documents WHERE owner_user_id = ? AND (? IS NULL OR course_id = ?)'),
    exportDocs: database.prepare('SELECT * FROM academic_documents WHERE owner_user_id = ? ORDER BY course_id, title')
  }
  const searchStatements = new Map()
  const searchStatement = (courseCount) => {
    if (!searchStatements.has(courseCount)) {
      searchStatements.set(
        courseCount,
        database.prepare(
          `SELECT c.id AS chunkId, c.document_id AS documentId, c.course_id AS courseId, c.seq, c.heading_path AS headingPath, c.locator, c.start_line AS startLine,
                  c.end_line AS endLine, c.text, d.title, d.version, d.source_type AS sourceType, bm25(academic_chunks_fts, 1.0, 2.0) AS rank
             FROM academic_chunks_fts
             JOIN academic_chunks c ON c.id = academic_chunks_fts.rowid
             JOIN academic_documents d ON d.id = c.document_id
            WHERE academic_chunks_fts MATCH ? AND c.owner_user_id = ? AND c.course_id IN (${new Array(courseCount).fill('?').join(',')})
            ORDER BY rank LIMIT ?`
        )
      )
    }
    return searchStatements.get(courseCount)
  }

  function transaction(work) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      database.exec('COMMIT')
      return result
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
  }

  function forOwner(userId) {
    if (typeof userId !== 'string' || !userId) throw new Error('forOwner needs a person')

    const own = {
      userId,
      listDocuments: ({ courseId = null } = {}) => q.documents.all(userId, courseId, courseId).map(documentOut),
      getDocument: (id) => documentOut(q.document.get(String(id), userId)) ?? null,
      countDocuments: ({ courseId = null } = {}) => q.countDocs.get(userId, courseId, courseId).n,

      /**
       * Adds a document, or replaces the one it is a new version of (same title in the same course, or the same source, such as a lecture).
       * Identical text is not stored again: `unchanged: true`. The whole change is one transaction: a document is never left half cut.
       */
      addDocument({ courseId, title, sourceType = 'notes', sourceRef = null, format = null, text }) {
        if (!q.course.get(String(courseId), userId)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
        const cleanTitle = textField(title, 'title', { max: 160, required: true })
        const type = oneOf(sourceType, 'type', SOURCE_TYPES)
        const body = normalizeText(text)
        const cut = chunkDocument(body, { format })
        return own._store({ courseId, cleanTitle, type, sourceRef, format: cut.format, body, chunks: cut.chunks })
      },

      /** A finished lecture's transcript as a document: passages by time range. `segments` are canonical { start, end, text }. */
      addTranscript({ courseId, title, sourceRef, segments }) {
        if (!q.course.get(String(courseId), userId)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
        const cleanTitle = textField(title, 'title', { max: 160, required: true })
        const cut = chunkTranscript(segments, { title: cleanTitle })
        return own._store({ courseId, cleanTitle, type: 'lecture_transcript', sourceRef, format: 'text', body: cut.body, chunks: cut.chunks })
      },

      _store({ courseId, cleanTitle, type, sourceRef, format, body, chunks }) {
        const hash = hashText(body)
        const existing = (sourceRef ? q.bySource.get(userId, courseId, sourceRef) : null) ?? q.byTitle.get(userId, courseId, cleanTitle)
        if (existing && existing.content_hash === hash && existing.title === cleanTitle) return { document: documentOut(existing), unchanged: true }
        const totals = q.counts.get(courseId, userId)
        if (!existing) {
          if (totals.inCourse >= KNOWLEDGE_LIMITS.documentsPerCourse) throw new AcademicError(409, 'too-many-documents', `A course can hold ${KNOWLEDGE_LIMITS.documentsPerCourse} documents. Delete one first.`)
          if (totals.documents >= KNOWLEDGE_LIMITS.documentsPerPerson) throw new AcademicError(409, 'too-many-documents', `You can keep ${KNOWLEDGE_LIMITS.documentsPerPerson} documents in all. Delete one first.`)
        }
        if (totals.chars - (existing?.chars ?? 0) + body.length > KNOWLEDGE_LIMITS.charsPerPerson) throw new AcademicError(413, 'storage-full', 'Your course materials are using all the space allowed. Delete something first.')
        // A different document already has this title (the new one is from a source): the title must stay unique within the course.
        const clash = q.byTitle.get(userId, courseId, cleanTitle)
        if (clash && existing && clash.id !== existing.id) throw new AcademicError(409, 'title-in-use', 'Another document in this course already has that title.')

        return transaction(() => {
          const t = now()
          let id
          let version = 1
          if (existing) {
            id = existing.id
            version = existing.version + 1
            q.deleteChunksOf.run(id, userId)
            q.replaceDocument.run(cleanTitle, type, sourceRef, format, version, hash, body.length, chunks.length, body, t, id, userId)
          } else {
            id = newId()
            q.insertDocument.run(id, userId, courseId, cleanTitle, type, sourceRef, format, version, hash, body.length, chunks.length, body, t, t)
          }
          for (const chunk of chunks) q.insertChunk.run(id, userId, courseId, chunk.seq, chunk.headingPath, chunk.locator, chunk.startLine, chunk.endLine, chunk.text)
          return { document: own.getDocument(id), unchanged: false, replaced: Boolean(existing) }
        })
      },

      removeDocument: (id) => q.deleteDocument.run(String(id), userId).changes > 0,
      removeDocuments: ({ courseId = null } = {}) => q.deleteDocuments.run(userId, courseId, courseId).changes,

      /** Passages from these courses (all of them are checked to be this person's) that match the text, best first. */
      search({ courseIds, query, limit = 6 }) {
        const match = toMatchQuery(query)
        const ids = [...new Set((Array.isArray(courseIds) ? courseIds : []).map(String))].filter((id) => q.course.get(id, userId))
        if (!match || ids.length === 0) return []
        return searchStatement(ids.length).all(match, userId, ...ids, Math.min(20, Math.max(1, limit)))
      },

      /** Everything, with the text of each document. */
      exportDocuments: () => q.exportDocs.all(userId).map((row) => ({ ...documentOut(row), text: row.body }))
    }
    return own
  }

  return { forOwner }
}
