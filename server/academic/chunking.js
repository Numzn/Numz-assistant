import { createHash } from 'node:crypto'
import { AcademicError } from './academicError.js'
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
export const MAX_DOCUMENT_CHARS = 600_000
export const MAX_CHUNKS = 3000

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
  const sentences = text.match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^.!?\n]+$|\n/g) ?? [text]
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
 * @returns {{ format: 'markdown'|'text', chunks: { seq: number, headingPath: string, locator: string, startLine: number, endLine: number, text: string }[] }}
 */
export function chunkDocument(raw, { format = null } = {}) {
  const text = normalizeText(raw)
  if (!text.trim()) throw new AcademicError(400, 'empty-document', 'That document has no text in it.')
  if (text.length > MAX_DOCUMENT_CHARS) throw new AcademicError(413, 'document-too-large', `That document is longer than ${MAX_DOCUMENT_CHARS.toLocaleString('en-US')} characters. Split it into parts.`)
  const kind = format === 'markdown' || format === 'text' ? format : looksLikeMarkdown(text) ? 'markdown' : 'text'

  const lines = text.split('\n')
  const stack = [] // [{ level, title }]
  let fence = null
  const sections = [] // { headingPath, paragraphs: [{ text, startLine, endLine }] }
  let section = { headingPath: '', paragraphs: [] }
  let paragraph = null
  const flush = () => {
    if (paragraph && paragraph.lines.length) section.paragraphs.push({ text: paragraph.lines.join('\n').trim(), startLine: paragraph.start, endLine: paragraph.end })
    paragraph = null
  }
  const closeSection = () => {
    flush()
    if (section.paragraphs.length) sections.push(section)
  }

  lines.forEach((line, index) => {
    const lineNo = index + 1
    if (kind === 'markdown') {
      const fenceMatch = line.match(/^\s{0,3}(```+|~~~+)/)
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1][0]
        else if (fenceMatch[1][0] === fence) fence = null
      }
      const heading = !fence && line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
      if (heading) {
        closeSection()
        const level = heading[1].length
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
        stack.push({ level, title: heading[2].trim() })
        section = { headingPath: stack.map((h) => h.title).join(' > '), paragraphs: [] }
        return
      }
    }
    if (!line.trim() && !fence) {
      flush()
      return
    }
    if (!paragraph) paragraph = { lines: [], start: lineNo, end: lineNo }
    paragraph.lines.push(line)
    paragraph.end = lineNo
  })
  closeSection()

  const chunks = []
  for (const sec of sections) {
    let current = null
    const emit = () => {
      if (current?.text.trim()) chunks.push({ headingPath: sec.headingPath, locator: `lines ${current.startLine}-${current.endLine}`, startLine: current.startLine, endLine: current.endLine, text: current.text.trim() })
      current = null
    }
    for (const para of sec.paragraphs) {
      for (const piece of splitLong(para.text, para.startLine)) {
        if (current && current.text.length + piece.text.length + 2 > MAX_CHARS) emit()
        if (!current) current = { text: piece.text, startLine: para.startLine, endLine: para.endLine }
        else {
          current.text += `\n\n${piece.text}`
          current.endLine = para.endLine
        }
      }
    }
    emit()
  }
  if (chunks.length === 0) throw new AcademicError(400, 'empty-document', 'That document has no text in it.')
  if (chunks.length > MAX_CHUNKS) throw new AcademicError(413, 'document-too-large', 'That document has too many parts. Split it into several documents.')
  return { format: kind, chunks: chunks.map((chunk, i) => ({ seq: i, ...chunk })) }
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
