import { randomUUID } from 'node:crypto'
import { AcademicError, oneOf, textField } from '../academic/academicError.js'
import { chunkBatches, chunkDocument, chunkTranscript, hashText, normalizeText, resolveFormat } from '../academic/chunking.js'
import { DEFAULT_LIMITS, describeSize } from '../academic/knowledgeLimits.js'

/**
 * A person's course materials in the database (migration 10): documents, the passages they were cut into, and the full-text index.
 * Reached only through `forOwner(userId)`; every statement says `owner_user_id = ?`, and a search is always limited to courses that are
 * this person's own, so no query can return another person's passage or another course's passage that was not asked for.
 */

export const SOURCE_TYPES = Object.freeze(['lecture_notes', 'lecture_transcript', 'course_outline', 'study_guide', 'textbook', 'notes', 'research', 'other'])

/** The default limits (server/academic/knowledgeLimits.js reads the server's environment; a repository is given what it read). */
export const KNOWLEDGE_LIMITS = Object.freeze({ documentsPerCourse: DEFAULT_LIMITS.documentsPerCourse, documentsPerPerson: DEFAULT_LIMITS.documentsPerPerson, charsPerPerson: DEFAULT_LIMITS.charsPerPerson })

// A document's row without its text (which can be 100 MB): listing, finding and checking a document never read the body. Where it stands
// comes from academic_document_jobs (no row there = ready; while it is processing, the passages made so far are counted there).
const DOCUMENT_COLUMNS = `d.id, d.owner_user_id, d.course_id, d.title, d.source_type, d.source_ref, d.format, d.version, d.content_hash, d.chars,
  CASE WHEN j.status = 'processing' THEN j.processed ELSE d.chunk_count END AS chunk_count, COALESCE(j.status, 'ready') AS status, j.error AS error, d.created_at, d.updated_at`
const DOCUMENT_FROM = 'academic_documents d LEFT JOIN academic_document_jobs j ON j.document_id = d.id'
const INTERRUPTED = 'Processing was interrupted when the server restarted. Press Retry.'
// The pause between two slices of background work: half as long as the slice took (never under 20 ms, never over 250 ms), so the server is free for
// a good part of the time and answers what came in meanwhile. Yielding for a single turn of the event loop (setImmediate) is not enough: the next
// slice starts at once and a request would wait many slices for its turn.
const restAfter = (workedMs) => new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(20, workedMs / 2))))

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
      status: row.status,
      error: row.error,
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

export function createKnowledgeRepository(database, { clock = Date.now, newId = randomUUID, limits = DEFAULT_LIMITS } = {}) {
  const now = () => iso(clock())
  const q = {
    course: database.prepare('SELECT id FROM academic_courses WHERE id = ? AND owner_user_id = ?'),
    documents: database.prepare(
      `SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE d.owner_user_id = ? AND (? IS NULL OR d.course_id = ?) ORDER BY d.updated_at DESC, d.id`
    ),
    document: database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE d.id = ? AND d.owner_user_id = ?`),
    byTitle: database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE d.owner_user_id = ? AND d.course_id = ? AND d.title = ?`),
    bySource: database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE d.owner_user_id = ? AND d.course_id = ? AND d.source_ref = ?`),
    // The text itself, read only to cut it (and to export it).
    body: database.prepare('SELECT d.body, d.format, d.version, d.course_id, j.status AS job FROM academic_documents d LEFT JOIN academic_document_jobs j ON j.document_id = d.id WHERE d.id = ? AND d.owner_user_id = ?'),
    state: database.prepare('SELECT d.version, j.status AS job FROM academic_documents d LEFT JOIN academic_document_jobs j ON j.document_id = d.id WHERE d.id = ? AND d.owner_user_id = ?'),
    // Progress, success and failure touch the small jobs table only, never the document's row (which holds the whole text); only the end (markCount) rewrites it, once.
    setProgress: database.prepare('UPDATE academic_document_jobs SET processed = ?, updated_at = ? WHERE document_id = ? AND status = \'processing\''),
    markCount: database.prepare('UPDATE academic_documents SET chunk_count = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?'),
    startJob: database.prepare('INSERT OR REPLACE INTO academic_document_jobs (document_id, status, error, processed, updated_at) VALUES (?, \'processing\', NULL, 0, ?)'),
    endJob: database.prepare('DELETE FROM academic_document_jobs WHERE document_id = ?'),
    failJob: database.prepare('UPDATE academic_document_jobs SET status = \'failed\', error = ?, processed = 0, updated_at = ? WHERE document_id = ? AND status = \'processing\''),
    retryJob: database.prepare('UPDATE academic_document_jobs SET status = \'processing\', error = NULL, processed = 0, updated_at = ? WHERE document_id = ? AND status = \'failed\''),
    interrupted: database.prepare('SELECT document_id AS id FROM academic_document_jobs WHERE status = \'processing\''),
    failInterrupted: database.prepare('UPDATE academic_document_jobs SET status = \'failed\', error = ?, processed = 0, updated_at = ? WHERE document_id = ?'),
    deleteChunksOfAny: database.prepare('DELETE FROM academic_chunks WHERE document_id = ?'),
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
          // The full-text search runs FIRST and by itself (MATERIALIZED), then its hits are narrowed to this person's courses and to documents that are
          // ready. Written as one join with the filters beside the MATCH, SQLite is free to scan the person's passages and probe the index once for
          // each (about 1 ms apiece): fine for a few thousand passages, 35 seconds for 35,000. This way a search takes tens of milliseconds at any size.
          `WITH hits AS MATERIALIZED (
             SELECT rowid AS id, bm25(academic_chunks_fts, 1.0, 2.0) AS rank FROM academic_chunks_fts WHERE academic_chunks_fts MATCH ?
           )
           SELECT c.id AS chunkId, c.document_id AS documentId, c.course_id AS courseId, c.seq, c.heading_path AS headingPath, c.locator, c.start_line AS startLine,
                  c.end_line AS endLine, c.text, d.title, d.version, d.source_type AS sourceType, hits.rank AS rank
             FROM hits
             JOIN academic_chunks c ON c.id = hits.id
             JOIN academic_documents d ON d.id = c.document_id
            WHERE c.owner_user_id = ? AND c.course_id IN (${new Array(courseCount).fill('?').join(',')})
              AND NOT EXISTS (SELECT 1 FROM academic_document_jobs j WHERE j.document_id = c.document_id)
            ORDER BY hits.rank LIMIT ?`
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
        const cut = chunkDocument(body, { format, normalized: true, maxDocumentChars: limits.maxDocumentChars, maxChunks: limits.maxChunks })
        return own._store({ courseId, cleanTitle, type, sourceRef, format: cut.format, body, chunks: cut.chunks })
      },

      /**
       * Stores a document to be cut and indexed LATER, in the background (a large one: see processDocument). The document is saved at once with
       * status 'processing' and no passages, and is not searchable until it is 'ready'. Same rules as addDocument: a same-title document is
       * replaced by a new version, identical text is not stored again, and the limits apply. -> { document, unchanged?, replaced?, processing? }
       */
      beginDocument({ courseId, title, sourceType = 'notes', sourceRef = null, format = null, text }) {
        if (!q.course.get(String(courseId), userId)) throw new AcademicError(404, 'course-not-found', 'That course does not exist.')
        const cleanTitle = textField(title, 'title', { max: 160, required: true })
        const type = oneOf(sourceType, 'type', SOURCE_TYPES)
        const body = normalizeText(text)
        if (!body.trim()) throw new AcademicError(400, 'empty-document', 'That document has no text in it.')
        if (body.length > limits.maxDocumentChars) throw new AcademicError(413, 'document-too-large', `That document is ${describeSize(body.length)}; the most one document can be is ${describeSize(limits.maxDocumentChars)}. Split it into parts.`)
        return own._store({ courseId, cleanTitle, type, sourceRef, format: resolveFormat(body, format), body, chunks: null })
      },

      /**
       * Cuts a document that beginDocument stored and indexes it, in short slices: each slice is one transaction of about `sliceMs` of inserting
       * (then the rest of the server gets its turn: this runs inside the server, on its one thread and its one database connection, so a
       * transaction is never held open across a pause). The size of a slice is a balance: every commit waits for the disk to confirm it (about 0.3 s on
       * a busy host, which is what a 100 MB document costs most), so many tiny slices take far longer in all, and one huge one would hold the server
       * for as long. The document stays 'processing' (and out of every search) until the last slice, then becomes 'ready'; any failure removes the
       * passages made so far and leaves it 'failed' with the reason, for a retry. A document that was deleted or replaced by a newer version while
       * this ran is left alone. Never throws for a failed cut: the outcome is the document's status. Progress and failure touch only the small
       * jobs table; the document's own row (which holds the whole text) is written once, at the end. -> the document, or null
       */
      async processDocument(id, { batchSize = 200, sliceMs = 150, pause = restAfter } = {}) {
        const docId = String(id)
        const row = q.body.get(docId, userId)
        if (!row || row.job !== 'processing') return own.getDocument(docId)
        const version = row.version
        const current = () => {
          const state = q.state.get(docId, userId)
          return Boolean(state && state.version === version && state.job === 'processing')
        }
        try {
          q.deleteChunksOf.run(docId, userId) // a clean start (a retry, or a version that replaced one)
          const batches = chunkBatches(row.body, { format: row.format, batchSize, normalized: true, maxDocumentChars: limits.maxDocumentChars, maxChunks: limits.maxChunks })
          let batch = batches.next()
          let at = 0
          const next = () => {
            while (!batch.done && at >= batch.value.chunks.length) {
              batch = batches.next()
              at = 0
            }
            return batch.done ? null : batch.value.chunks[at++]
          }
          let made = 0
          for (let chunk = next(); chunk; chunk = next()) {
            if (!current()) return own.getDocument(docId)
            const started = performance.now()
            transaction(() => {
              do {
                q.insertChunk.run(docId, userId, row.course_id, chunk.seq, chunk.headingPath, chunk.locator, chunk.startLine, chunk.endLine, chunk.text)
                made += 1
              } while (performance.now() - started < sliceMs && (chunk = next()))
              q.setProgress.run(made, now(), docId)
            })
            await pause(performance.now() - started)
          }
          if (current()) {
            transaction(() => {
              q.markCount.run(made, now(), docId, userId)
              q.endJob.run(docId)
            })
          }
        } catch (err) {
          if (current()) {
            q.deleteChunksOf.run(docId, userId)
            q.failJob.run(err instanceof AcademicError ? err.message : 'The document could not be processed.', now(), docId)
          }
        }
        return own.getDocument(docId)
      },

      /** A failed document is made ready to be processed again (its text is kept). -> the document (status 'processing') */
      retryDocument(id) {
        const found = own.getDocument(id)
        if (!found) throw new AcademicError(404, 'document-not-found', 'That document does not exist.')
        if (q.retryJob.run(now(), found.id).changes === 0) throw new AcademicError(409, 'not-failed', 'Only a document that failed can be retried.')
        return own.getDocument(id)
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
        // Identical text is not stored again; but one that failed is processed again, and one still being processed is left to finish.
        if (existing && existing.content_hash === hash && existing.title === cleanTitle && existing.status !== 'failed') return { document: documentOut(existing), unchanged: true }
        const totals = q.counts.get(courseId, userId)
        if (!existing) {
          if (totals.inCourse >= limits.documentsPerCourse) throw new AcademicError(409, 'too-many-documents', `A course can hold ${limits.documentsPerCourse} documents. Delete one first.`)
          if (totals.documents >= limits.documentsPerPerson) throw new AcademicError(409, 'too-many-documents', `You can keep ${limits.documentsPerPerson} documents in all. Delete one first.`)
        }
        if (totals.chars - (existing?.chars ?? 0) + body.length > limits.charsPerPerson) throw new AcademicError(413, 'storage-full', `Your course materials would use more than the ${describeSize(limits.charsPerPerson)} allowed. Delete something first.`)
        // A different document already has this title (the new one is from a source): the title must stay unique within the course.
        const clash = q.byTitle.get(userId, courseId, cleanTitle)
        if (clash && existing && clash.id !== existing.id) throw new AcademicError(409, 'title-in-use', 'Another document in this course already has that title.')

        const deferred = chunks === null // cut later, in the background: 'processing' until then
        const passages = deferred ? [] : chunks
        return transaction(() => {
          const t = now()
          let id
          let version = 1
          if (existing) {
            id = existing.id
            version = existing.version + 1
            q.deleteChunksOf.run(id, userId)
            q.replaceDocument.run(cleanTitle, type, sourceRef, format, version, hash, body.length, passages.length, body, t, id, userId)
            q.endJob.run(id) // whatever was being done for the earlier version is no longer wanted
          } else {
            id = newId()
            q.insertDocument.run(id, userId, courseId, cleanTitle, type, sourceRef, format, version, hash, body.length, passages.length, body, t, t)
          }
          if (deferred) q.startJob.run(id, t)
          for (const chunk of passages) q.insertChunk.run(id, userId, courseId, chunk.seq, chunk.headingPath, chunk.locator, chunk.startLine, chunk.endLine, chunk.text)
          return { document: own.getDocument(id), unchanged: false, replaced: Boolean(existing), ...(deferred ? { processing: true } : {}) }
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

  /**
   * After a restart: a document left 'processing' lost the work that was cutting it (it ran inside the server). Its partial passages are removed
   * and it is marked 'failed' with a plain reason, so the page offers Retry. Run once at startup. -> how many documents
   */
  function recoverInterrupted() {
    const stuck = q.interrupted.all()
    for (const { id } of stuck) {
      q.deleteChunksOfAny.run(id)
      q.failInterrupted.run(INTERRUPTED, now(), id)
    }
    return stuck.length
  }

  return { forOwner, recoverInterrupted }
}
