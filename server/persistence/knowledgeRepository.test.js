import assert from 'node:assert/strict'
import test from 'node:test'
import { rig } from '../academic/testSupport.js'
import { createKnowledgeRepository, KNOWLEDGE_LIMITS, toMatchQuery } from './knowledgeRepository.js'
import { applyMigrations, createDatabase } from './sqliteDatabase.js'

function setup() {
  const t = rig()
  const knowledge = createKnowledgeRepository(t.database, { clock: () => t.clock.t })
  const alice = knowledge.forOwner(t.who.alice)
  const bob = knowledge.forOwner(t.who.bob)
  const aCourse = t.academic.forOwner(t.who.alice).courses.create({ title: 'Databases' })
  const aCourse2 = t.academic.forOwner(t.who.alice).courses.create({ title: 'Networks' })
  const bCourse = t.academic.forOwner(t.who.bob).courses.create({ title: 'Databases (bob)' })
  return { ...t, knowledge, alice, bob, aCourse, aCourse2, bCourse }
}
const NORM = '# Normalisation\n\nNormalisation removes redundancy using normal forms.\n\n## Third normal form\n\nEvery attribute depends on the key and nothing but the key.'
const NET = '# TCP\n\nThe transport control protocol gives reliable delivery with retransmission.'
const ftsIntegrity = (database) => database.exec(`INSERT INTO academic_chunks_fts(academic_chunks_fts) VALUES ('integrity-check')`)

test('a document is cut, stored and found again by what it says, with its heading as the reference', () => {
  const t = setup()
  const added = t.alice.addDocument({ courseId: t.aCourse.id, title: 'Lecture 3', sourceType: 'lecture_notes', text: NORM })
  assert.equal(added.document.version, 1)
  assert.equal(added.document.chunkCount, 2)
  assert.equal(added.document.format, 'markdown')
  const hits = t.alice.search({ courseIds: [t.aCourse.id], query: 'what is third normal form?' })
  assert.equal(hits[0].headingPath, 'Normalisation > Third normal form')
  assert.equal(hits[0].title, 'Lecture 3')
  assert.equal(hits[0].sourceType, 'lecture_notes')
  assert.match(hits[0].text, /nothing but the key/)
  assert.ok(t.alice.search({ courseIds: [t.aCourse.id], query: 'normalising redundant tables' }).length > 0, 'stemming finds related word forms')
  assert.deepEqual(t.alice.search({ courseIds: [t.aCourse.id], query: 'photosynthesis' }), [])
  ftsIntegrity(t.database)
})

test('course isolation: a search sees only the course it is asked about; another person\'s materials are unreachable even by naming their course', () => {
  const t = setup()
  t.alice.addDocument({ courseId: t.aCourse.id, title: 'DB notes', text: NORM })
  t.alice.addDocument({ courseId: t.aCourse2.id, title: 'Net notes', text: NET })
  t.bob.addDocument({ courseId: t.bCourse.id, title: 'Bob DB', text: 'Normalisation according to bob is secret bob material.' })
  const onlyNet = t.alice.search({ courseIds: [t.aCourse2.id], query: 'normalisation redundancy' })
  assert.deepEqual(onlyNet, [], 'the networks course does not contain the database passages')
  assert.equal(t.alice.search({ courseIds: [t.aCourse.id, t.aCourse2.id], query: 'normalisation' }).length > 0, true)
  const naming = t.alice.search({ courseIds: [t.bCourse.id], query: 'normalisation secret' })
  assert.deepEqual(naming, [], 'bob\'s course id means nothing to alice')
  assert.ok(!JSON.stringify(t.alice.search({ courseIds: [t.aCourse.id, t.bCourse.id], query: 'normalisation secret bob' })).includes('secret bob'))
  assert.deepEqual(t.bob.listDocuments().map((d) => d.title), ['Bob DB'])
  assert.equal(t.bob.getDocument(t.alice.listDocuments()[0].id), null)
  assert.equal(t.bob.removeDocument(t.alice.listDocuments()[0].id), false)
})

test('the database refuses a document in someone else\'s course and a passage that does not match its document', () => {
  const t = setup()
  assert.throws(() => t.alice.addDocument({ courseId: t.bCourse.id, title: 'x', text: 'body' }), (err) => err.code === 'course-not-found')
  assert.throws(() => t.database.prepare(`INSERT INTO academic_documents (id, owner_user_id, course_id, title, source_type, format, content_hash, chars, chunk_count, body, created_at, updated_at) VALUES ('d', ?, ?, 't', 'notes', 'text', 'h', 1, 1, 'b', 't', 't')`).run(t.who.alice, t.bCourse.id), /course-owner-mismatch/)
  const { document } = t.alice.addDocument({ courseId: t.aCourse.id, title: 'ok', text: 'some text' })
  assert.throws(() => t.database.prepare(`INSERT INTO academic_chunks (document_id, owner_user_id, course_id, seq, text) VALUES (?, ?, ?, 9, 'x')`).run(document.id, t.who.bob, t.bCourse.id), /chunk-scope-mismatch/)
})

test('adding the same title again is a new version; identical text is not stored twice; the index follows', () => {
  const t = setup()
  const first = t.alice.addDocument({ courseId: t.aCourse.id, title: 'Notes', text: '# A\n\nalpha beta gamma' })
  const same = t.alice.addDocument({ courseId: t.aCourse.id, title: 'Notes', text: '# A\n\nalpha beta gamma' })
  assert.equal(same.unchanged, true)
  assert.equal(same.document.id, first.document.id)
  assert.equal(same.document.version, 1)
  const second = t.alice.addDocument({ courseId: t.aCourse.id, title: 'Notes', text: '# A\n\ndelta epsilon zeta' })
  assert.equal(second.replaced, true)
  assert.equal(second.document.id, first.document.id)
  assert.equal(second.document.version, 2)
  assert.deepEqual(t.alice.search({ courseIds: [t.aCourse.id], query: 'alpha' }), [], 'the old text is gone from the index')
  assert.equal(t.alice.search({ courseIds: [t.aCourse.id], query: 'epsilon' })[0].version, 2)
  assert.equal(t.alice.listDocuments().length, 1)
  ftsIntegrity(t.database)
})

test('deleting a document, a course or a person\'s knowledge empties the index with it', () => {
  const t = setup()
  const a = t.alice.addDocument({ courseId: t.aCourse.id, title: 'A', text: 'quokka facts' }).document
  t.alice.addDocument({ courseId: t.aCourse2.id, title: 'B', text: 'wombat facts' })
  t.alice.addDocument({ courseId: t.aCourse2.id, title: 'C', text: 'echidna facts' })
  assert.equal(t.alice.removeDocument(a.id), true)
  assert.deepEqual(t.alice.search({ courseIds: [t.aCourse.id, t.aCourse2.id], query: 'quokka' }), [])
  assert.equal(t.academic.forOwner(t.who.alice).courses.remove(t.aCourse2.id), true)
  assert.deepEqual(t.alice.search({ courseIds: [t.aCourse2.id], query: 'wombat' }), [])
  assert.equal(t.alice.listDocuments().length, 0, 'a course takes its documents with it')
  assert.equal(t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks').get().n, 0)
  ftsIntegrity(t.database)
  t.alice.addDocument({ courseId: t.aCourse.id, title: 'D', text: 'platypus facts' })
  assert.equal(t.alice.removeDocuments(), 1)
  assert.equal(t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks').get().n, 0)
  ftsIntegrity(t.database)
})

test('what a person types can never be read as search syntax, and a query with nothing searchable finds nothing', () => {
  const t = setup()
  t.alice.addDocument({ courseId: t.aCourse.id, title: 'A', text: 'normal forms and keys' })
  for (const hostile of ['"unbalanced', 'NEAR(a b)', 'a AND OR NOT', '* - ^ ( )', 'text:foo', 'normal" OR "x', "'; DROP TABLE academic_chunks; --"]) {
    assert.doesNotThrow(() => t.alice.search({ courseIds: [t.aCourse.id], query: hostile }), hostile)
  }
  assert.equal(toMatchQuery('the and of'), '')
  assert.equal(toMatchQuery('Third normal form!'), '"third" OR "normal" OR "form"')
  assert.deepEqual(t.alice.search({ courseIds: [t.aCourse.id], query: '   ' }), [])
  assert.ok(t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks').get().n > 0)
})

test('limits: the documents a course and a person may keep, and the space they may use', () => {
  const t = setup()
  const small = (n) => ({ courseId: t.aCourse.id, title: `doc ${n}`, text: `content number ${n}` })
  for (let i = 0; i < KNOWLEDGE_LIMITS.documentsPerCourse; i++) t.alice.addDocument(small(i))
  assert.throws(() => t.alice.addDocument(small('one too many')), (err) => err.code === 'too-many-documents' && err.statusCode === 409)
  assert.equal(t.alice.addDocument({ ...small(3), text: 'content number 3, edited' }).replaced, true, 'replacing is still allowed when full')
  assert.throws(() => t.alice.addDocument({ courseId: t.aCourse.id, title: 'x', text: 'y', sourceType: 'poster' }), (err) => err.code === 'invalid-input')
})

test('a lecture transcript becomes a document keyed by its meeting, and doing it again replaces it', () => {
  const t = setup()
  const seg = (start, text) => ({ start, end: start + 3, text })
  const first = t.alice.addTranscript({ courseId: t.aCourse.id, title: 'Databases 4', sourceRef: 'meeting:m1', segments: [seg(0, 'We start with keys.'), seg(400, 'Then foreign keys.')] })
  assert.equal(first.document.sourceType, 'lecture_transcript')
  assert.equal(first.document.chunkCount, 2)
  const hit = t.alice.search({ courseIds: [t.aCourse.id], query: 'foreign keys' })[0]
  assert.equal(hit.locator, '06:40-06:43')
  const again = t.alice.addTranscript({ courseId: t.aCourse.id, title: 'Databases 4 (retitled)', sourceRef: 'meeting:m1', segments: [seg(0, 'We start with keys.'), seg(400, 'Then foreign keys and joins.')] })
  assert.equal(again.document.id, first.document.id)
  assert.equal(again.document.version, 2)
  assert.equal(t.alice.listDocuments().length, 1)
})

// ---- background processing: status, restart recovery, the upgrade --------------------------------------------------------------------

const BIG = Array.from({ length: 300 }, (_, i) => `## Part ${i}\n\nPart ${i} says partmarker${i}x about relational algebra. ${'Joins combine rows. '.repeat(10)}`).join('\n\n')
const noPause = () => Promise.resolve()

test('a document stored for later is "processing" with no passages and out of every search; processing makes it "ready" a slice at a time and it is found by its own words', async () => {
  const t = setup()
  const begun = t.alice.beginDocument({ courseId: t.aCourse.id, title: 'Big', text: BIG, sourceType: 'textbook' })
  assert.deepEqual([begun.document.status, begun.processing, begun.unchanged, begun.document.chunkCount], ['processing', true, false, 0])
  assert.equal(t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks').get().n, 0)
  assert.equal(t.alice.search({ courseIds: [t.aCourse.id], query: 'partmarker7x' }).length, 0)

  const progress = []
  const done = await t.alice.processDocument(begun.document.id, { batchSize: 25, sliceMs: 0, pause: async () => progress.push(t.alice.getDocument(begun.document.id).chunkCount) })
  assert.equal(done.status, 'ready')
  assert.ok(progress.length >= 5 && progress.every((n, i) => i === 0 || n > progress[i - 1]), `progress grew slice by slice: ${progress.join(',')}`)
  assert.equal(done.chunkCount, t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks WHERE document_id = ?').get(done.id).n)
  assert.equal(t.alice.search({ courseIds: [t.aCourse.id], query: 'partmarker7x' })[0].headingPath, 'Part 7')
  assert.equal(t.bob.search({ courseIds: [t.aCourse.id], query: 'partmarker7x' }).length, 0, 'another person finds nothing of it')
  ftsIntegrity(t.database)
  // the same passages as a document stored in one go
  const direct = t.alice.addDocument({ courseId: t.aCourse2.id, title: 'Same', text: BIG, sourceType: 'textbook' })
  const cut = (id) => t.database.prepare('SELECT seq, heading_path, locator, text FROM academic_chunks WHERE document_id = ? ORDER BY seq').all(id).map((c) => ({ ...c }))
  assert.deepEqual(cut(done.id), cut(direct.document.id), 'cut in the background it is exactly what cutting it at once gives')
})

test('processing that fails leaves no passages and a reason; retry processes it again; a document deleted or replaced while processing is left alone', async () => {
  const t = setup()
  const begun = t.alice.beginDocument({ courseId: t.aCourse.id, title: 'Big', text: BIG })
  const failing = await t.alice.processDocument(begun.document.id, { batchSize: 25, pause: async () => { throw new Error('boom') } })
  assert.deepEqual([failing.status, failing.chunkCount], ['failed', 0])
  assert.match(failing.error, /could not be processed/)
  assert.equal(t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks').get().n, 0)
  assert.equal(t.alice.retryDocument(begun.document.id).status, 'processing')
  assert.throws(() => t.alice.retryDocument(begun.document.id), (e) => e.code === 'not-failed' && e.statusCode === 409, 'a document that is already processing cannot be retried')
  const retried = await t.alice.processDocument(begun.document.id, { batchSize: 100, pause: noPause })
  assert.equal(retried.status, 'ready')
  assert.throws(() => t.bob.retryDocument(begun.document.id), (e) => e.statusCode === 404, 'another person cannot reach it')

  const gone = t.alice.beginDocument({ courseId: t.aCourse.id, title: 'Gone', text: BIG })
  let first = true
  const result = await t.alice.processDocument(gone.document.id, { batchSize: 25, pause: async () => { if (first) { first = false; t.alice.removeDocument(gone.document.id) } } })
  assert.equal(result, null)
  assert.equal(t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks WHERE document_id = ?').get(gone.document.id).n, 0)

  const old = t.alice.beginDocument({ courseId: t.aCourse.id, title: 'Swap', text: `${BIG}\n\noldversionword` })
  let replaced = false
  const job = t.alice.processDocument(old.document.id, { batchSize: 25, pause: async () => { if (!replaced) { replaced = true; t.alice.beginDocument({ courseId: t.aCourse.id, title: 'Swap', text: `${BIG}\n\nnewversionword` }) } } })
  await job
  assert.equal(t.alice.getDocument(old.document.id).status, 'processing', 'the old job did not finish the newer version')
  const finished = await t.alice.processDocument(old.document.id, { batchSize: 100, pause: noPause })
  assert.deepEqual([finished.status, finished.version], ['ready', 2])
  assert.equal(t.alice.search({ courseIds: [t.aCourse.id], query: 'newversionword' }).length, 1)
  assert.equal(t.alice.search({ courseIds: [t.aCourse.id], query: 'oldversionword' }).length, 0)
  ftsIntegrity(t.database)
})

test('after a restart a document left "processing" is marked failed with its partial passages removed, so that it can be retried', async () => {
  const t = setup()
  const a = t.alice.beginDocument({ courseId: t.aCourse.id, title: 'Interrupted', text: BIG })
  // the server stopped half way: some passages were made, the work was lost
  const part = t.alice.addDocument({ courseId: t.aCourse.id, title: 'Fine', text: NORM })
  const job = t.alice.processDocument(a.document.id, { batchSize: 25, pause: () => new Promise(() => {}) }) // never resumes: the process "died"
  void job
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks WHERE document_id = ?').get(a.document.id).n > 0, 'partial passages exist')
  assert.equal(t.knowledge.recoverInterrupted(), 1)
  const after = t.alice.getDocument(a.document.id)
  assert.deepEqual([after.status, after.chunkCount], ['failed', 0])
  assert.match(after.error, /interrupted when the server restarted/)
  assert.equal(t.database.prepare('SELECT COUNT(*) AS n FROM academic_chunks WHERE document_id = ?').get(a.document.id).n, 0)
  assert.equal(t.alice.getDocument(part.document.id).status, 'ready', 'a finished document is untouched')
  assert.equal(t.knowledge.recoverInterrupted(), 0, 'nothing left to recover')
  assert.equal(t.alice.retryDocument(a.document.id).status, 'processing')
  ftsIntegrity(t.database)
})

test('migration 11 upgrades a database that holds documents: every one is "ready", exactly as it was, and listings do not carry the text', () => {
  const database = new (createDatabase({ filename: ':memory:' }).constructor)(':memory:')
  applyMigrations(database, { target: 10 })
  database.prepare(`INSERT INTO ai_users (id, external_id, email, name, role, status, created_at) VALUES ('u1', 'e1', 'a@example.com', 'A', 'viewer', 'active', 't')`).run()
  database.prepare(`INSERT INTO academic_courses (id, owner_user_id, title, created_at, updated_at) VALUES ('c1', 'u1', 'DB', 't', 't')`).run()
  database.prepare(`INSERT INTO academic_documents (id, owner_user_id, course_id, title, source_type, format, version, content_hash, chars, chunk_count, body, created_at, updated_at) VALUES ('d1', 'u1', 'c1', 'Old notes', 'notes', 'text', 1, 'h', 5, 1, 'hello', 't', 't')`).run()
  database.prepare(`INSERT INTO academic_chunks (document_id, owner_user_id, course_id, seq, text) VALUES ('d1', 'u1', 'c1', 0, 'hello')`).run()
  applyMigrations(database)
  const doc = createKnowledgeRepository(database).forOwner('u1').getDocument('d1')
  assert.deepEqual([doc.status, doc.error, doc.chunkCount, doc.title], ['ready', null, 1, 'Old notes'])
  assert.equal(createKnowledgeRepository(database).forOwner('u1').search({ courseIds: ['c1'], query: 'hello' }).length, 1, 'and it is still found')
  assert.ok(!('body' in doc) && !('text' in doc))
})
