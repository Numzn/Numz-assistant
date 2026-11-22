import assert from 'node:assert/strict'
import test from 'node:test'
import { createResearchService, deriveQuery } from './researchService.js'
import { quiet } from './testSupport.js'

const inverted = { Relational: [0], databases: [1], store: [2], data: [3], in: [4], tables: [5] }
const OPENALEX = {
  results: [
    { title: 'A Relational Model of Data for Large Shared Data Banks', publication_year: 1970, doi: 'https://doi.org/10.1145/362384.362685', authorships: [{ author: { display_name: 'E. F. Codd' } }], primary_location: { source: { display_name: 'Communications of the ACM' } }, abstract_inverted_index: inverted, type: 'article' },
    { title: 'A Totally Invented Paper About Normal Forms', publication_year: 2019, doi: 'https://doi.org/10.9999/fake.123', authorships: [{ author: { display_name: 'N. Ope' } }], primary_location: null, abstract_inverted_index: null, type: 'article' },
    { title: 'No year, no doi', publication_year: null, doi: null, authorships: [] },
    { title: '', publication_year: 2000, doi: null }
  ]
}
const CROSSREF = { '10.1145/362384.362685': { message: { DOI: '10.1145/362384.362685', title: ['A relational model of data for large shared data banks'], issued: { 'date-parts': [[1970]] } } } }

function fetcher({ openalex = OPENALEX, crossref = CROSSREF, fail = null } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init })
    if (fail) throw fail
    const u = new URL(url)
    if (u.host === 'api.openalex.org') return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(openalex) }
    if (u.host === 'api.crossref.org') {
      const doi = decodeURIComponent(u.pathname.replace('/works/', ''))
      return crossref[doi] ? { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(crossref[doi]) } : { ok: false, status: 404, headers: new Map(), text: async () => '{}' }
    }
    throw new Error(`unexpected host ${u.host}`)
  }
  fn.calls = calls
  return fn
}

test('works are found and a DOI is "verified" only when Crossref confirms it with a matching title and year', async () => {
  const fetchFn = fetcher()
  const { works, query } = await createResearchService({ fetchFn, logger: quiet }).forOwner('u1').search({ query: 'relational model normalisation', limit: 3 })
  assert.equal(query, 'relational model normalisation')
  assert.deepEqual(works.map((w) => [w.label, w.verified]), [['R1', true], ['R2', false]], 'verified work first; the one with neither year nor DOI, and the untitled one, are dropped')
  const codd = works[0]
  assert.equal(codd.title, 'A Relational Model of Data for Large Shared Data Banks')
  assert.deepEqual(codd.authors, ['E. F. Codd'])
  assert.equal(codd.year, 1970)
  assert.equal(codd.venue, 'Communications of the ACM')
  assert.equal(codd.doi, '10.1145/362384.362685')
  assert.equal(codd.url, 'https://doi.org/10.1145/362384.362685')
  assert.equal(codd.abstract, 'Relational databases store data in tables')
  assert.equal(works[1].verified, false, 'a DOI Crossref does not know is not verified')
})

test('only the two fixed public hosts are ever contacted, with a plain client name and nothing about the person', async () => {
  const fetchFn = fetcher()
  await createResearchService({ fetchFn, logger: quiet }).forOwner('person-with-a-private-id').search({ query: 'third normal form' })
  assert.ok(fetchFn.calls.length >= 2)
  for (const { url, init } of fetchFn.calls) {
    assert.ok(['api.openalex.org', 'api.crossref.org'].includes(new URL(url).host), url)
    assert.equal(init.headers['User-Agent'], 'NUMZ-AI-study-assistant/1.0')
    assert.ok(!/person-with-a-private-id|@/.test(JSON.stringify(init.headers) + url), 'no identity in the request')
  }
})

test('a DOI that is not well formed is never put into a request, and a malformed response is just "unverified"', async () => {
  const evil = { results: [{ title: 'Odd one', publication_year: 2020, doi: '10.1/../../etc/passwd?x=1', authorships: [] }] }
  const fetchFn = fetcher({ openalex: evil })
  const { works } = await createResearchService({ fetchFn, logger: quiet }).forOwner('u').search({ query: 'odd topic here' })
  assert.equal(works[0].verified, false)
  assert.equal(works[0].url, '')
  assert.equal(fetchFn.calls.filter((c) => new URL(c.url).host === 'api.crossref.org').length, 0)
})

test('the query is a short phrase of subject words, never the question itself; a daily allowance applies per person', async () => {
  const question = 'Explain in detail why the third normal form removes transitive dependencies between non-key attributes in a relational schema design'
  const q = deriveQuery('third normal form', question)
  assert.ok(q.split(' ').length <= 8)
  assert.ok(q.length < question.length / 2)
  assert.match(q, /third normal form/)
  assert.equal(deriveQuery('', 'the and of'), '')

  const fetchFn = fetcher()
  const service = createResearchService({ fetchFn, logger: quiet, perPersonPerDay: 2 })
  const mine = service.forOwner('u1')
  await mine.search({ query: 'normal forms' })
  await mine.search({ query: 'normal forms again' })
  await assert.rejects(mine.search({ query: 'one more search' }), (err) => err.code === 'research-limit' && err.statusCode === 429)
  await service.forOwner('u2').search({ query: 'normal forms' })
  assert.deepEqual((await service.forOwner('u3').search({ query: 'x' })).works, [], 'a query too short to mean anything searches nothing')
})

test('when the research services cannot be reached the failure is plain and the caller can carry on without research', async () => {
  const down = createResearchService({ fetchFn: fetcher({ fail: new Error('offline') }), logger: quiet }).forOwner('u')
  await assert.rejects(down.search({ query: 'normal forms' }), (err) => err.code === 'research-unavailable' && err.statusCode === 502 && /course materials and general knowledge only/.test(err.message))
  const slow = createResearchService({ fetchFn: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), timeoutMs: 20, logger: quiet }).forOwner('u')
  await assert.rejects(slow.search({ query: 'normal forms' }), (err) => err.code === 'research-unavailable')
  const huge = createResearchService({ fetchFn: async () => ({ ok: true, status: 200, headers: new Map([['content-length', '9000000']]), text: async () => '{}' }), logger: quiet }).forOwner('u')
  await assert.rejects(huge.search({ query: 'normal forms' }), (err) => err.code === 'research-unavailable', 'an answer that is too large is refused')
})
