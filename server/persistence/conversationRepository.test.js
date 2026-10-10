import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabase } from './sqliteDatabase.js'
import { createConversationRepository, deriveTitle } from './conversationRepository.js'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const at = (n) => `2026-10-10T10:00:${String(n).padStart(2, '0')}.000Z`

function repo() {
  const database = createDatabase({ filename: ':memory:' })
  return { database, store: createConversationRepository(database) }
}

test('the first message creates the conversation; messages keep their order', () => {
  const { store } = repo()
  assert.equal(store.append(A, { role: 'user', content: 'Hello there', createdAt: at(1) }, { conversationCreatedAt: at(0) }), true)
  store.append(A, { role: 'assistant', content: 'Hi!', createdAt: at(2) })
  store.append(A, { role: 'user', content: 'And again', createdAt: at(3) })
  const conversation = store.get(A)
  assert.equal(conversation.title, 'Hello there')
  assert.equal(conversation.createdAt, at(0))
  assert.equal(conversation.updatedAt, at(3))
  assert.deepEqual(conversation.messages.map((m) => `${m.role}:${m.content}`), ['user:Hello there', 'assistant:Hi!', 'user:And again'])
})

test('only user and assistant text is stored', () => {
  const { store } = repo()
  assert.equal(store.append(A, { role: 'system', content: 'secret prompt' }), false)
  assert.equal(store.append(A, { role: 'user', content: 42 }), false)
  assert.equal(store.get(A), null, 'a refused message creates nothing')
})

test('the title comes from the first user message and never changes', () => {
  const { store } = repo()
  store.append(A, { role: 'assistant', content: 'Greeting first', createdAt: at(1) })
  assert.equal(store.get(A).title, null, 'an assistant message gives no title')
  store.append(A, { role: 'user', content: 'The real question', createdAt: at(2) })
  store.append(A, { role: 'user', content: 'A later question', createdAt: at(3) })
  assert.equal(store.get(A).title, 'The real question')
})

test('titles: whitespace collapsed, long ones cut, an attached file never leaks into it', () => {
  assert.equal(deriveTitle('  lots   of\n\nspace  '), 'lots of space')
  assert.equal(deriveTitle('x'.repeat(200)).length, 80)
  assert.ok(deriveTitle('x'.repeat(200)).endsWith('…'))
  assert.equal(deriveTitle('Summarise this\n\n[Attached file: a.csv]\n```\nsecret,data\n```'), 'Summarise this')
  assert.equal(deriveTitle('[Attached file: prices.csv]\n```\nitem,price\n```'), 'prices.csv')
  assert.equal(deriveTitle('   '), null)
  assert.equal(deriveTitle(undefined), null)
})

test('the list is newest first, with counts, a total, limit and offset', () => {
  const { store } = repo()
  store.append(A, { role: 'user', content: 'old one', createdAt: at(1) })
  store.append(B, { role: 'user', content: 'new one', createdAt: at(5) })
  store.append(B, { role: 'assistant', content: 'reply', createdAt: at(6) })
  const all = store.list()
  assert.equal(all.total, 2)
  assert.deepEqual(all.conversations.map((c) => [c.title, c.messageCount]), [['new one', 2], ['old one', 1]])
  assert.deepEqual(store.list({ limit: 1 }).conversations.map((c) => c.title), ['new one'])
  assert.deepEqual(store.list({ limit: 1, offset: 1 }).conversations.map((c) => c.title), ['old one'])
  assert.equal(store.list({ limit: -5, offset: 'x' }).conversations.length, 1, 'a limit below 1 is raised to 1 and a non-number offset is 0')
  assert.equal(store.list({ limit: 'x' }).conversations.length, 2, 'a non-number limit falls back to the default')
  assert.equal(store.list({ limit: 100000 }).conversations.length, 2, 'the limit is capped')
})

test('a conversation that does not exist is null; the list of nothing is empty', () => {
  const { store } = repo()
  assert.equal(store.get(A), null)
  assert.deepEqual(store.list(), { total: 0, conversations: [] })
})

test('removing a conversation removes its messages and nothing else', () => {
  const { database, store } = repo()
  store.append(A, { role: 'user', content: 'one', createdAt: at(1) })
  store.append(B, { role: 'user', content: 'two', createdAt: at(2) })
  assert.equal(store.remove(A), true)
  assert.equal(store.remove(A), false, 'already gone')
  assert.equal(store.get(A), null)
  assert.equal(store.get(B).messages.length, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM assistant_messages').get().n, 1, 'no orphaned messages')
})

test('removing everything reports how many, and leaves meetings alone', () => {
  const { database, store } = repo()
  database.prepare(`INSERT INTO meetings (meeting_id, status, created_at, updated_at, metadata_json) VALUES ('m1', 'LIVE', 'x', 'x', '{}')`).run()
  store.append(A, { role: 'user', content: 'one', createdAt: at(1) })
  store.append(B, { role: 'user', content: 'two', createdAt: at(2) })
  assert.equal(store.removeAll(), 2)
  assert.deepEqual(store.list(), { total: 0, conversations: [] })
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meetings').get().n, 1, 'meeting data is untouched')
})

test('the same message text twice is two messages, in order (nothing is de-duplicated away)', () => {
  const { store } = repo()
  store.append(A, { role: 'user', content: 'same', createdAt: at(1) })
  store.append(A, { role: 'user', content: 'same', createdAt: at(2) })
  assert.equal(store.get(A).messages.length, 2)
})

test('text with quotes, newlines, unicode and SQL-looking content is stored exactly', () => {
  const { store } = repo()
  const nasty = `it's "quoted"\n'); DROP TABLE assistant_messages; --\n日本語 ✓ end`
  store.append(A, { role: 'user', content: nasty, createdAt: at(1) })
  assert.equal(store.get(A).messages[0].content, nasty)
  assert.equal(store.list().total, 1)
})

test('a NUL character does not cut the message short: the rest survives (the NUL itself is shown as U+FFFD)', () => {
  const { store } = repo()
  store.append(A, { role: 'user', content: 'before\u0000after', createdAt: at(1) })
  assert.equal(store.get(A).messages[0].content, 'before\uFFFDafter')
})
