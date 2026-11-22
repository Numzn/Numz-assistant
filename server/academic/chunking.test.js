import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkDocument, chunkTranscript, hashText, MAX_CHARS, MAX_DOCUMENT_CHARS, normalizeText } from './chunking.js'

const MD = `# Databases

Intro to databases.

## Normalisation

Normalisation removes redundancy.

It uses normal forms.

\`\`\`sql
# this is a comment, not a heading
SELECT 1;
\`\`\`

### Third normal form

Every attribute depends on the key, the whole key and nothing but the key.

## Indexing

B-trees speed up lookups.
`

test('markdown is cut at headings: every passage knows its heading path and the lines it came from, and code is not mistaken for headings', () => {
  const { format, chunks } = chunkDocument(MD)
  assert.equal(format, 'markdown')
  assert.deepEqual(chunks.map((c) => c.headingPath), ['Databases', 'Databases > Normalisation', 'Databases > Normalisation > Third normal form', 'Databases > Indexing'])
  assert.deepEqual(chunks.map((c) => c.seq), [0, 1, 2, 3])
  const norm = chunks[1]
  assert.match(norm.text, /redundancy/)
  assert.match(norm.text, /normal forms/)
  assert.match(norm.text, /# this is a comment, not a heading/, 'the fenced code stays in its passage')
  assert.equal(norm.locator, `lines ${norm.startLine}-${norm.endLine}`)
  assert.equal(MD.split('\n')[norm.startLine - 1].trim(), 'Normalisation removes redundancy.')
  assert.ok(chunks.every((c) => !/^#{1,6} /m.test(c.text.replace(/```[\s\S]*?```/g, ''))), 'headings are references, not text')
})

test('plain text is cut at paragraphs, small neighbours are joined, long paragraphs are cut at sentence ends, and nothing is lost', () => {
  const sentence = 'This is a sentence about transport layer protocols and how they behave. '
  const long = sentence.repeat(60) // ~4300 characters in one paragraph
  const text = `Short one.\n\nAnother short one.\n\n${long}\n\nLast paragraph.`
  const { format, chunks } = chunkDocument(text)
  assert.equal(format, 'text')
  assert.ok(chunks.every((c) => c.text.length <= MAX_CHARS + 2), 'every passage is small enough to cite')
  assert.match(chunks[0].text, /Short one\.\n\nAnother short one\./, 'small neighbours are joined')
  assert.ok(chunks.length >= 4)
  const rejoined = chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ')
  assert.ok(rejoined.includes('Last paragraph.') && rejoined.includes('Short one.'))
  assert.equal((rejoined.match(/This is a sentence/g) ?? []).length, 60, 'no sentence is dropped or repeated')
})

test('the same text always gives the same cut and hash; line endings and a BOM do not matter', () => {
  const a = chunkDocument('# T\r\n\r\nBody here.\r\n')
  const b = chunkDocument('﻿# T\n\nBody here.\n')
  assert.deepEqual(a, b)
  assert.equal(hashText(normalizeText('x\r\ny')), hashText('x\ny'))
  assert.equal(normalizeText('a\u0000b'), 'ab')
})

test('empty, huge and structureless inputs are refused or handled with a plain code', () => {
  for (const empty of ['', '   \n\n  ', '# Only a heading\n']) assert.throws(() => chunkDocument(empty), (err) => err.code === 'empty-document' && err.statusCode === 400, JSON.stringify(empty))
  assert.throws(() => chunkDocument('x'.repeat(MAX_DOCUMENT_CHARS + 1)), (err) => err.code === 'document-too-large' && err.statusCode === 413)
  assert.equal(chunkDocument('# Title\n\nbody', { format: 'text' }).format, 'text', 'the caller can say it is text')
  assert.equal(chunkDocument('no markers at all, just words').chunks.length, 1)
})

test('a lecture transcript is cut by time and referenced by its time range', () => {
  const segments = [
    { start: 0, end: 4, text: 'Welcome to the lecture.' },
    { start: 5, end: 40, text: 'Today we cover normalisation.' },
    { start: 301, end: 330, text: 'Now second normal form.' },
    { start: 700, end: 720, text: 'Summary of the lecture.' },
    { start: 2, end: 3, text: '  ' }
  ]
  const { chunks, body } = chunkTranscript(segments, { title: 'Databases 4' })
  assert.deepEqual(chunks.map((c) => c.locator), ['00:00-00:40', '05:01-05:30', '11:40-12:00'])
  assert.equal(chunks[0].headingPath, 'Databases 4 > 00:00-00:40')
  assert.match(chunks[0].text, /\[00:05\] Today we cover normalisation\./)
  assert.ok(body.includes('[05:01] Now second normal form.'))
  assert.throws(() => chunkTranscript([]), (err) => err.code === 'empty-document')
})
