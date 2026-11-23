import { createHash } from 'node:crypto'
import { AcademicError } from './academicError.js'
import { DEFAULT_LIMITS } from './knowledgeLimits.js'
import { formatTimestamp } from '../utils/prompt.js'

/**
 * Cuts a course document (markdown or plain text) into passages that can be searched and cited.
 *
 * A passage never crosses a heading, so its heading path ("Normalisation > Second normal form") is a trustworthy reference; it also carries
 * the lines it came from (a text file has no pages). Paragraphs are kept whole and small neighbours are joined up to MAX_CHARS; a paragraph
 * longer than that is cut at sentence ends. A fenced code block is never mistaken for headings. A lecture transcript is cut by time
 * instead (`chunkTranscript`): its reference is the time range.
 */

export const MAX_CHARS = 1200
// The defaults (server/academic/knowledgeLimits.js, which the server's environment can change): a document, and the passages it may be cut into.
export const MAX_DOCUMENT_CHARS = DEFAULT_LIMITS.maxDocumentChars
export const MAX_CHUNKS = DEFAULT_LIMITS.maxChunks

export const hashText = (text) => createHash('sha256').update(text).digest('hex')

/** Line endings, BOM and NUL characters made uniform, so the same text always hashes and cuts the same way. */
export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/^﻿/, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
}

export function looksLikeMarkdown(text) {
  return /^\s{0,3}#{1,6}\s+\S/m.test(text) || /^\s*```/m.test(text)
}

function splitLong(text, startLine) {
  if (text.length <= MAX_CHARS) return [{ text, offset: 0 }]
  const parts = []
  // Sentences, and the lines that end without one: a fragment before a line break that has no . ! or ? (a list item, a line of code) used to match
  // nothing here and was dropped from the passages of any paragraph longer than MAX_CHARS.
  const sentences = text.match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^.!?\n]+(?=\n)|[^.!?\n]+$|\n/g) ?? [text]
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_CHARS) {
      parts.push(current.trim())
      current = ''
    }
    if (sentence.length > MAX_CHARS) {
      for (let i = 0; i < sentence.length; i += MAX_CHARS) parts.push(sentence.slice(i, i + MAX_CHARS).trim())
    } else current += sentence
  }
  if (current.trim()) parts.push(current.trim())
  return parts.filter(Boolean).map((part) => ({ text: part, offset: 0, line: startLine }))
}

/**
 * The format a document will be cut as: what the caller said, or what the text looks like.
 * @returns {'markdown'|'text'}
 */
export function resolveFormat(text, format = null) {
  return format === 'markdown' || format === 'text' ? format : looksLikeMarkdown(text) ? 'markdown' : 'text'
}

// A paragraph with no blank line in it for this many characters is closed at the next line break, so that a document with no paragraph
// breaks at all (a dump, a log, a book with single newlines) is cut as it is read instead of being held whole. A normal paragraph is far
// shorter, so nothing a person writes is cut differently.
export const PARAGRAPH_FLUSH_CHARS = 20_000

/**
 * Cuts a document into passages a batch at a time, reading it once from the top and never holding more than a batch of passages and one
 * paragraph: a 100 MB document is no heavier to cut than a small one. Yields { format, chunks }; the passages are numbered from 0 across
 * the batches. Throws the same coded errors as chunkDocument (empty, too large, too many parts), the last two as soon as they are known.
 *
 * @param {string} raw the text
 * @param {{ format?: string|null, batchSize?: number, maxDocumentChars?: number, maxChunks?: number, normalized?: boolean }} [options]
 *   `normalized`: the text has already been through normalizeText (the repository does it once and keeps that text)
 */
export function* chunkBatches(raw, { format = null, batchSize = 500, maxDocumentChars = MAX_DOCUMENT_CHARS, maxChunks = MAX_CHUNKS, normalized = false } = {}) {
  const text = normalized ? String(raw ?? '') : normalizeText(raw)
  if (!text.trim()) throw new AcademicError(400, 'empty-document', 'That document has no text in it.')
  if (text.length > maxDocumentChars) throw new AcademicError(413, 'document-too-large', `That document is longer than ${maxDocumentChars.toLocaleString('en-US')} characters. Split it into parts.`)
  const kind = resolveFormat(text, format)

  const stack = [] // [{ level, title }]
  let headingPath = ''
  let fence = null
  let paragraph = null // { lines, chars, start, end }
  let current = null // the passage being built in this section: { text, startLine, endLine }
  let seq = 0
  let out = []

  const emit = () => {
    if (current?.text.trim()) {
      if (seq >= maxChunks) throw new AcademicError(413, 'document-too-large', 'That document has too many parts. Split it into several documents.')
      out.push({ seq: seq++, headingPath, locator: `lines ${current.startLine}-${current.endLine}`, startLine: current.startLine, endLine: current.endLine, text: current.text.trim() })
    }
    current = null
  }
  const addParagraph = (para) => {
    for (const piece of splitLong(para.text, para.startLine)) {
      if (current && current.text.length + piece.text.length + 2 > MAX_CHARS) emit()
      if (!current) current = { text: piece.text, startLine: para.startLine, endLine: para.endLine }
      else {
        current.text += `\n\n${piece.text}`
        current.endLine = para.endLine
      }
    }
  }
  const flush = () => {
    if (paragraph && paragraph.lines.length) addParagraph({ text: paragraph.lines.join('\n').trim(), startLine: paragraph.start, endLine: paragraph.end })
    paragraph = null
  }
  const closeSection = () => {
    flush()
    emit()
  }

  let lineNo = 0
  for (let pos = 0; pos <= text.length; ) {
    const newline = text.indexOf('\n', pos)
    const line = newline === -1 ? text.slice(pos) : text.slice(pos, newline)
    pos = newline === -1 ? text.length + 1 : newline + 1
    lineNo += 1

    let isHeading = false
    if (kind === 'markdown') {
      const fenceMatch = line.match(/^\s{0,3}(```+|~~~+)/)
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1][0]
        else if (fenceMatch[1][0] === fence) fence = null
      }
      const heading = !fence && line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
      if (heading) {
        closeSection() // the passages of the section that ends here keep ITS heading path
        const level = heading[1].length
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
        stack.push({ level, title: heading[2].trim() })
        headingPath = stack.map((h) => h.title).join(' > ')
        isHeading = true
      }
    }
    if (!isHeading) {
      if (!line.trim() && !fence) flush()
      else {
        if (!paragraph) paragraph = { lines: [], chars: 0, start: lineNo, end: lineNo }
        paragraph.lines.push(line)
        paragraph.chars += line.length + 1
        paragraph.end = lineNo
        if (paragraph.chars >= PARAGRAPH_FLUSH_CHARS) flush()
      }
    }
    if (out.length >= batchSize) {
      yield { format: kind, chunks: out }
      out = []
    }
  }
  closeSection()
  if (seq === 0) throw new AcademicError(400, 'empty-document', 'That document has no text in it.')
  if (out.length) yield { format: kind, chunks: out }
}

/**
 * The whole cut at once (a document small enough to be stored in one go, and the callers that want everything).
 * @returns {{ format: 'markdown'|'text', chunks: { seq: number, headingPath: string, locator: string, startLine: number, endLine: number, text: string }[] }}
 */
export function chunkDocument(raw, options = {}) {
  const chunks = []
  let format = null
  for (const batch of chunkBatches(raw, { ...options, batchSize: 1000 })) {
    format = batch.format
    chunks.push(...batch.chunks)
  }
  return { format, chunks }
}

/**
 * A finished lecture's transcript as passages of about five minutes (and never more than MAX_CHARS), each referenced by its time range.
 * `segments` are the canonical final segments: { start, end, text } in seconds.
 */
export function chunkTranscript(segments, { title = 'Lecture', windowSeconds = 300 } = {}) {
  const lines = (Array.isArray(segments) ? segments : [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim() && Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start)
  if (lines.length === 0) throw new AcademicError(400, 'empty-document', 'That meeting has no transcript text.')
  const chunks = []
  let current = null
  const emit = () => {
    if (!current) return
    const locator = `${formatTimestamp(current.start)}-${formatTimestamp(current.end)}`
    chunks.push({ seq: chunks.length, headingPath: `${title} > ${locator}`, locator, startLine: null, endLine: null, text: current.parts.join('\n') })
    current = null
  }
  for (const segment of lines) {
    const line = `[${formatTimestamp(segment.start)}] ${segment.text.trim()}`
    if (current && (segment.start - current.start >= windowSeconds || current.chars + line.length > MAX_CHARS)) emit()
    if (!current) current = { start: segment.start, end: segment.end ?? segment.start, parts: [], chars: 0 }
    current.parts.push(line)
    current.chars += line.length + 1
    current.end = Math.max(current.end, segment.end ?? segment.start)
  }
  emit()
  const body = lines.map((s) => `[${formatTimestamp(s.start)}] ${s.text.trim()}`).join('\n')
  if (chunks.length > MAX_CHUNKS) throw new AcademicError(413, 'document-too-large', 'That transcript is too long to keep as one document.')
  return { format: 'text', chunks, body }
}
