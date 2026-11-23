import assert from 'node:assert/strict'
import test from 'node:test'
import { AcademicError } from './academicError.js'
import { chunkBatches, chunkDocument, looksLikeMarkdown, MAX_CHARS, MAX_CHUNKS, MAX_DOCUMENT_CHARS, normalizeText, PARAGRAPH_FLUSH_CHARS } from './chunking.js'

/**
 * chunkBatches reads a document once from the top and yields its passages a batch at a time, so a very large document costs no more
 * memory than a small one. The passages carry the lines they came from and are what answers cite, so they must not change: the code
 * below is the previous implementation (whole document split into lines, sections held, then cut), kept here as the reference, and every
 * document in these tests is cut both ways and compared.
 */

// ---- the previous implementation, unchanged -------------------------------------------------------------------------------------
function splitLong(text, startLine) {
  if (text.length <= MAX_CHARS) return [{ text, offset: 0 }]
  const parts = []
  // The one deliberate difference from the previous code: lines that end without a . ! or ? are kept (see the test about list items).
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
 * @returns {{ format: 'markdown'|'text', chunks: { seq: number, headingPath: string, locator: string, startLine: number, endLine: number, text: string }[] }}
 */
function legacyChunkDocument(raw, { format = null } = {}) {
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


// ---- documents to compare ------------------------------------------------------------------------------------------------------

function rng(seed) {
  let state = seed >>> 0
  return () => ((state = (state * 1664525 + 1013904223) >>> 0), state / 4294967296)
}
const WORDS = 'database table key row column index query join normal form relation schema transaction commit cache lecture notes heading example proof'.split(' ')

/** A random document: headings at several levels, fenced code (with # lines inside), blank lines, tilde fences, short and long paragraphs. */
function randomDocument(seed, { longest = 2600 } = {}) {
  const random = rng(seed)
  const pick = (n) => Math.floor(random() * n)
  const sentence = () => Array.from({ length: 4 + pick(12) }, () => WORDS[pick(WORDS.length)]).join(' ') + '.'
  const paragraph = (size) => {
    let text = ''
    while (text.length < size) text += `${sentence()} `
    return text.trim()
  }
  const lines = []
  for (let i = 0, n = 40 + pick(80); i < n; i++) {
    const roll = random()
    if (roll < 0.12) lines.push(`${'#'.repeat(1 + pick(4))} ${paragraph(10 + pick(40))}`)
    else if (roll < 0.2) lines.push('', '```', '# not a heading', paragraph(20 + pick(300)), '', paragraph(20), '```', '')
    else if (roll < 0.24) lines.push('~~~', '## also not a heading', '~~~')
    else if (roll < 0.5) lines.push('')
    else if (roll < 0.58) lines.push(paragraph(1300 + pick(longest)))
    else lines.push(...Array.from({ length: 1 + pick(4) }, () => paragraph(30 + pick(500))))
  }
  return lines.join('\n')
}

const cutBatches = (text, options = {}) => {
  const batches = [...chunkBatches(text, options)]
  return { format: batches[0].format, chunks: batches.flatMap((b) => b.chunks), batches }
}

test('the new cut gives exactly the passages the previous one did: text, heading paths, line numbers, numbering (300 random documents)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const text = randomDocument(seed)
    let expected
    try {
      expected = legacyChunkDocument(text)
    } catch (err) {
      assert.throws(() => chunkDocument(text), (e) => e.code === err.code, `seed ${seed}: the same refusal`)
      continue
    }
    assert.deepEqual(chunkDocument(text), expected, `seed ${seed}`)
    for (const format of ['text', 'markdown']) assert.deepEqual(chunkDocument(text, { format }), legacyChunkDocument(text, { format }), `seed ${seed} as ${format}`)
  }
})

test('the documents the comparison cuts are not trivial: many passages, headings, code fences and long paragraphs between them', () => {
  const text = randomDocument(7)
  const { chunks, format } = chunkDocument(text)
  assert.equal(format, 'markdown')
  assert.ok(chunks.length > 20, `${chunks.length} passages`)
  assert.ok(new Set(chunks.map((c) => c.headingPath)).size > 3)
  assert.ok(chunks.some((c) => c.text.includes('# not a heading')), 'a # inside a fence stays text')
})

test('batches: the passages are the same however they are batched, numbered from 0 across the batches, and a batch is never over its size by more than a paragraph yields', () => {
  const text = randomDocument(11)
  const whole = chunkDocument(text)
  for (const batchSize of [1, 3, 10, 500]) {
    const cut = cutBatches(text, { batchSize })
    assert.deepEqual(cut.chunks, whole.chunks, `batch size ${batchSize}`)
    assert.deepEqual(cut.chunks.map((c) => c.seq), cut.chunks.map((_, i) => i))
    assert.ok(cut.batches.every((b) => b.chunks.length > 0))
  }
  assert.ok(cutBatches(text, { batchSize: 3 }).batches.length > 5, 'a small batch size really does give several batches')
})

test('text already normalised is not normalised again, and line endings are the same either way', () => {
  const text = randomDocument(5)
  assert.deepEqual(chunkDocument(normalizeText(text), { normalized: true }), chunkDocument(text))
  assert.deepEqual(chunkDocument(text.replace(/\n/g, '\r\n')), chunkDocument(text))
})

test('limits are the caller\'s: a document over its limit, one with too many passages, and one with nothing in it are refused with the usual codes', () => {
  assert.throws(() => [...chunkBatches('word '.repeat(300), { maxDocumentChars: 1000 })], (err) => err instanceof AcademicError && err.code === 'document-too-large' && err.statusCode === 413)
  const many = Array.from({ length: 60 }, (_, i) => `# Heading ${i}\n\nA short paragraph ${i}.`).join('\n\n')
  assert.throws(() => chunkDocument(many, { maxChunks: 20 }), (err) => err.code === 'document-too-large' && /too many parts/.test(err.message))
  assert.equal(chunkDocument(many, { maxChunks: 60 }).chunks.length, 60)
  assert.throws(() => chunkDocument('   \n\n', {}), (err) => err.code === 'empty-document')
  assert.ok(MAX_DOCUMENT_CHARS >= 100 * 1024 * 1024 && MAX_CHUNKS >= 100_000, 'the defaults are the upgraded ones')
})

test('a long paragraph keeps its lines that end without a full stop (list items, code): the cut used to drop them', () => {
  const items = Array.from({ length: 80 }, (_, i) => `- item number ${i} of the list without any full stop`).join('\n') // one paragraph, about 4 KB
  const words = (s) => s.split(/\s+/).filter(Boolean).length
  const cut = chunkDocument(items)
  assert.ok(cut.chunks.length > 1, 'it is longer than one passage')
  assert.equal(cut.chunks.reduce((n, c) => n + words(c.text), 0), words(items))
  assert.ok(cut.chunks.map((c) => c.text).join('\n').includes('item number 79 of the list'))
})

test('a document with no blank line at all is read as it comes, in paragraphs of a bounded size, and every word of it is kept', () => {
  const line = 'The primary key of a table identifies one row and no other, and its values can never be empty.'
  const text = Array.from({ length: 3000 }, (_, i) => `${line} ${i}`).join('\n') // one 290 KB "paragraph" of 3000 lines
  const cut = cutBatches(text, { batchSize: 50 })
  assert.ok(cut.chunks.length > 200)
  assert.ok(cut.chunks.every((c) => c.text.length <= MAX_CHARS))
  const words = (s) => s.split(/\s+/).filter(Boolean).length
  assert.equal(cut.chunks.reduce((n, c) => n + words(c.text), 0), words(text), 'nothing was lost or repeated')
  const last = cut.chunks.at(-1)
  assert.ok(last.endLine === 3000 && cut.chunks[0].startLine === 1, 'the passages span the lines of the document')
  assert.ok(cut.chunks.some((c) => c.endLine - c.startLine < 400), 'and cite far smaller ranges than "the whole document"')
  assert.ok(PARAGRAPH_FLUSH_CHARS > MAX_CHARS * 10)
})

test('a large document is cut without being held: 30 MB comes out as ordered batches', () => {
  const paragraph = `${'Normalisation removes redundancy from a schema. '.repeat(20)}\n\n`
  const text = `# Big\n\n${paragraph.repeat(Math.ceil((30 * 1024 * 1024) / paragraph.length))}`
  let passages = 0
  let batches = 0
  let next = 0
  for (const batch of chunkBatches(text, { batchSize: 400, normalized: true, maxDocumentChars: 100 * 1024 * 1024, maxChunks: 150_000 })) {
    batches += 1
    for (const chunk of batch.chunks) assert.equal(chunk.seq, next++)
    passages += batch.chunks.length
  }
  assert.ok(text.length > 30 * 1024 * 1024)
  assert.ok(passages > 25_000 && passages < 150_000, `${passages} passages`)
  assert.ok(batches >= Math.floor(passages / 400))
})
