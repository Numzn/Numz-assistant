/**
 * How much course material a person may add, and how it is processed. Every number can be set in the server's environment; a missing,
 * zero or unreadable value falls back to the default (a limit is never silently switched off).
 *
 *   ACADEMIC_MAX_DOCUMENT_MB          the largest single document, in MB of text                          default 100
 *   ACADEMIC_MAX_BATCH_FILES          files the page adds in one go (the page asks the server)           default 50
 *   ACADEMIC_MAX_PERSON_MB            all of one person's course materials together, in MB of text       default 500
 *   ACADEMIC_MAX_DOCS_PER_COURSE      documents in one course                                            default 100
 *   ACADEMIC_MAX_DOCS_PER_PERSON      documents in all of one person's courses                           default 300
 *   ACADEMIC_MAX_CHUNKS_PER_DOCUMENT  passages one document may be cut into                              default 150000
 *   ACADEMIC_ASYNC_THRESHOLD_KB       a document longer than this is processed in the background         default 1024
 *
 * 100 MB of text is about 85,000 passages of at most 1,200 characters; the database keeps the text three times over (the document, its
 * passages, the search index), so a 100 MB document takes roughly 300 MB on disk.
 */

const MB = 1024 * 1024

export const DEFAULT_LIMITS = Object.freeze({
  maxDocumentChars: 100 * MB,
  maxBatchFiles: 50,
  charsPerPerson: 500 * MB,
  documentsPerCourse: 100,
  documentsPerPerson: 300,
  maxChunks: 150_000,
  asyncThresholdChars: 1024 * 1024
})

const positive = (value, fallback, scale = 1) => {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n * scale) : fallback
}

/** @returns {typeof DEFAULT_LIMITS} */
export function readKnowledgeLimits(env = process.env) {
  const d = DEFAULT_LIMITS
  return Object.freeze({
    maxDocumentChars: positive(env.ACADEMIC_MAX_DOCUMENT_MB, d.maxDocumentChars, MB),
    maxBatchFiles: positive(env.ACADEMIC_MAX_BATCH_FILES, d.maxBatchFiles),
    charsPerPerson: positive(env.ACADEMIC_MAX_PERSON_MB, d.charsPerPerson, MB),
    documentsPerCourse: positive(env.ACADEMIC_MAX_DOCS_PER_COURSE, d.documentsPerCourse),
    documentsPerPerson: positive(env.ACADEMIC_MAX_DOCS_PER_PERSON, d.documentsPerPerson),
    maxChunks: positive(env.ACADEMIC_MAX_CHUNKS_PER_DOCUMENT, d.maxChunks),
    asyncThresholdChars: positive(env.ACADEMIC_ASYNC_THRESHOLD_KB, d.asyncThresholdChars, 1024)
  })
}

/** "100 MB", "1.5 MB", "300 KB": a size in words for a message. */
export function describeSize(chars) {
  if (chars >= MB) return `${Number((chars / MB).toFixed(1))} MB`
  return `${Math.max(1, Math.round(chars / 1024))} KB`
}
