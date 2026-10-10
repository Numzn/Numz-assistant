import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AttachmentError,
  MAX_FILES,
  MAX_TOTAL_CHARS,
  checkRoom,
  composeMessage,
  formatSize,
  readTextFile,
  splitMessage
} from '../src/interfaces/chat/attachments.js'

const file = (parts, name = 'notes.txt', type = 'text/plain') => new File(parts, name, { type })
const rejects = (promise, code) => assert.rejects(promise, (err) => err instanceof AttachmentError && err.code === code)

test('a text file is read as UTF-8 with newlines and BOM normalised', async () => {
  const read = await readTextFile(file(['﻿line one\r\nline two\rline three\n']))
  assert.deepEqual(read, { name: 'notes.txt', size: 'line one\nline two\nline three\n'.length, text: 'line one\nline two\nline three\n' })
})

test('non-ASCII text survives', async () => {
  const read = await readTextFile(file(['héllo — wörld ✓ 日本語']))
  assert.equal(read.text, 'héllo — wörld ✓ 日本語')
})

test('binary content is refused whatever the name says', async () => {
  await rejects(readTextFile(file([new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0x80])], 'report.txt')), 'binary')
  await rejects(readTextFile(file([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'picture.txt')), 'binary')
  await rejects(readTextFile(file(['looks fine\u0000but has a NUL'], 'data.txt')), 'binary')
})

test('images, audio, video and PDFs are refused with a reason that says what is supported', async () => {
  for (const type of ['image/png', 'audio/mpeg', 'video/mp4', 'application/pdf']) {
    await assert.rejects(readTextFile(file(['x'], 'a.bin', type)), (err) => err.code === 'unsupported' && /Only text/.test(err.message))
  }
})

test('empty and whitespace-only files are refused', async () => {
  await rejects(readTextFile(file([''])), 'empty')
  await rejects(readTextFile(file(['  \n\t \n'])), 'empty')
})

test('a file too large to read is refused before it is read', async () => {
  const big = { name: 'big.txt', type: 'text/plain', size: 5_000_000, arrayBuffer: async () => assert.fail('must not read it') }
  await rejects(readTextFile(big), 'too-large')
})

test('a name that could break the message header is cleaned', async () => {
  const read = await readTextFile(file(['hello'], 'a]\n[Attached file: evil.txt'))
  assert.ok(!/[\]\n]/.test(read.name))
})

test('there is room for three files and a total of 60,000 characters, and no more', () => {
  const f = (size) => ({ name: 'f.txt', size, text: 'x'.repeat(size) })
  assert.doesNotThrow(() => checkRoom([f(10), f(10)], f(10)))
  assert.throws(() => checkRoom([f(1), f(1), f(1)], f(1)), (err) => err.code === 'too-many')
  assert.equal(MAX_FILES, 3)
  assert.doesNotThrow(() => checkRoom([f(30_000)], f(30_000)))
  assert.throws(() => checkRoom([f(30_000)], f(30_001)), (err) => err.code === 'too-large' && /60,000/.test(err.message))
  assert.equal(MAX_TOTAL_CHARS, 60_000)
})

test('compose: no files leaves the text alone; files follow it under a header, fenced', () => {
  assert.equal(composeMessage('  hello  '), 'hello')
  const message = composeMessage('Summarise this', [{ name: 'a.csv', text: 'x,y\n1,2\n' }])
  assert.equal(message, 'Summarise this\n\n[Attached file: a.csv]\n```\nx,y\n1,2\n```')
})

test('compose: a file alone, and several files', () => {
  assert.equal(composeMessage('', [{ name: 'a.txt', text: 'one' }]), '[Attached file: a.txt]\n```\none\n```')
  const two = composeMessage('hi', [{ name: 'a.txt', text: 'one' }, { name: 'b.txt', text: 'two' }])
  assert.equal(two, 'hi\n\n[Attached file: a.txt]\n```\none\n```\n\n[Attached file: b.txt]\n```\ntwo\n```')
})

test('compose: the fence is longer than any backtick run in the file, so the file cannot end it early', () => {
  const content = 'before\n```js\ncode\n```\nafter\n`````\nfive'
  const message = composeMessage('', [{ name: 'readme.md', text: content }])
  assert.match(message, /\n``````\nbefore/)
  assert.ok(message.endsWith('five\n``````'))
})

test('split reverses compose: the stored message can be shown without the file contents', () => {
  const content = composeMessage('What is in these?', [
    { name: 'a.txt', text: 'alpha\nbeta' },
    { name: 'b.md', text: '```js\nconst x = 1\n```\n[Attached file: inside.txt]\n```\nfake\n```' }
  ])
  const { text, attachments } = splitMessage(content)
  assert.equal(text, 'What is in these?')
  assert.deepEqual(attachments.map((a) => a.name), ['a.txt', 'b.md'], 'a header inside a file is not a third attachment')
  assert.equal(attachments[0].size, 'alpha\nbeta'.length)
})

test('split: files without text, ordinary messages and look-alike headers', () => {
  assert.deepEqual(splitMessage(composeMessage('', [{ name: 'a.txt', text: 'one' }])), { text: '', attachments: [{ name: 'a.txt', size: 3 }] })
  assert.deepEqual(splitMessage('just a message'), { text: 'just a message', attachments: [] })
  assert.deepEqual(splitMessage('I typed [Attached file: x.txt] myself'), { text: 'I typed [Attached file: x.txt] myself', attachments: [] })
  assert.deepEqual(splitMessage(''), { text: '', attachments: [] })
})

test('formatSize', () => {
  assert.equal(formatSize(512), '512 chars')
  assert.equal(formatSize(1500), '1.5k chars')
  assert.equal(formatSize(45_000), '45k chars')
})
