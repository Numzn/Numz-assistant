import { AcademicError } from './academicError.js'
import { contentWords } from '../intelligence/grounding.js'

/**
 * External academic research with provenance. Two public scholarly services, fixed in the code (the model never chooses an address):
 *
 *   OpenAlex  https://api.openalex.org   finds works (title, authors, year, venue, DOI, abstract)
 *   Crossref  https://api.crossref.org   confirms that a DOI really exists and says the same thing about the work
 *
 * A work is `verified` only when its DOI is well formed AND Crossref returns that DOI with a matching title and year. Anything else is
 * returned `unverified` and is labelled so wherever it is shown. Nothing here fetches a full text: only the records those services publish,
 * so a source is never claimed to have been read beyond its abstract. Nothing identifying the person is sent: the query is a short phrase
 * of subject words made from the topic and the question, never the question itself, and requests carry a plain client name.
 *
 * Each person has a daily allowance of searches (default 40). A failure is reported as `research-unavailable` and the caller carries on
 * without research.
 */

const OPENALEX = 'https://api.openalex.org/works'
const CROSSREF = 'https://api.crossref.org/works/'
const DOI = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/
const MAX_BODY = 1_500_000
const AGENT = 'NUMZ-AI-study-assistant/1.0'

function titleMatch(a, b) {
  const x = new Set(contentWords(a))
  const y = new Set(contentWords(b))
  if (x.size === 0 || y.size === 0) return false
  const common = [...x].filter((w) => y.has(w)).length
  return common / Math.max(x.size, y.size) >= 0.8
}

function abstractOf(inverted) {
  if (!inverted || typeof inverted !== 'object') return ''
  const words = []
  for (const [word, positions] of Object.entries(inverted)) if (Array.isArray(positions)) for (const p of positions) if (Number.isInteger(p) && p >= 0 && p < 2000) words[p] = word
  return words.filter(Boolean).join(' ').slice(0, 900)
}

/** A short subject phrase for the search: the topic, then the commonest content words of the question. Never the whole question. */
export function deriveQuery(topic, question, maxWords = 8) {
  const words = [...new Set([...contentWords(topic), ...contentWords(question)])]
  return words.slice(0, maxWords).join(' ')
}

export function createResearchService({ fetchFn = (...args) => globalThis.fetch(...args), clock = Date.now, logger = console, perPersonPerDay = 40, timeoutMs = 8000 } = {}) {
  const used = new Map() // `${userId}|${day}` -> count
  const dayKey = () => new Date(clock()).toISOString().slice(0, 10)

  async function getJson(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': AGENT, Accept: 'application/json' }, signal: controller.signal })
      if (!res.ok) throw Object.assign(new Error(`research service answered ${res.status}`), { statusCode: res.status })
      const declared = Number(res.headers?.get?.('content-length') ?? 0)
      if (declared > MAX_BODY) throw new Error('the answer was too large')
      const text = await res.text()
      if (text.length > MAX_BODY) throw new Error('the answer was too large')
      return JSON.parse(text)
    } finally {
      clearTimeout(timer)
    }
  }

  async function verify(work) {
    if (!work.doi || !DOI.test(work.doi)) return false
    try {
      const body = await getJson(`${CROSSREF}${encodeURIComponent(work.doi)}`)
      const message = body?.message
      const title = Array.isArray(message?.title) ? message.title[0] : message?.title
      const year = message?.issued?.['date-parts']?.[0]?.[0] ?? message?.published?.['date-parts']?.[0]?.[0]
      const sameDoi = String(message?.DOI ?? '').toLowerCase() === work.doi.toLowerCase()
      return Boolean(sameDoi && title && titleMatch(title, work.title) && (!work.year || !year || Math.abs(year - work.year) <= 1))
    } catch {
      return false // could not be confirmed: it stays unverified, which is the honest answer
    }
  }

  return {
    forOwner(userId) {
      return {
        /** @returns {Promise<{ works: object[], query: string }>} each work: { label, title, authors, year, venue, doi, abstract, type, verified, url, source } */
        async search({ query, limit = 3 }) {
          const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
          if (q.length < 3) return { works: [], query: q }
          const key = `${userId}|${dayKey()}`
          if ((used.get(key) ?? 0) >= perPersonPerDay) throw new AcademicError(429, 'research-limit', 'You have used the day\'s research searches. It resets at midnight UTC.', { retryAfterSeconds: 3600 })
          used.set(key, (used.get(key) ?? 0) + 1)
          let data
          try {
            data = await getJson(`${OPENALEX}?search=${encodeURIComponent(q)}&per-page=${Math.min(5, Math.max(1, limit * 2))}&select=id,doi,title,publication_year,authorships,primary_location,abstract_inverted_index,type`)
          } catch (err) {
            logger.warn?.(`[academic] research search failed (${err?.statusCode ?? err?.name ?? 'error'})`)
            throw new AcademicError(502, 'research-unavailable', 'Research sources could not be reached just now, so this answer uses your course materials and general knowledge only.')
          }
          const candidates = (Array.isArray(data?.results) ? data.results : [])
            .map((r) => ({
              title: typeof r?.title === 'string' ? r.title.trim().slice(0, 300) : '',
              authors: (Array.isArray(r?.authorships) ? r.authorships : []).map((a) => a?.author?.display_name).filter((n) => typeof n === 'string').slice(0, 12),
              year: Number.isInteger(r?.publication_year) ? r.publication_year : null,
              venue: typeof r?.primary_location?.source?.display_name === 'string' ? r.primary_location.source.display_name.slice(0, 200) : '',
              doi: typeof r?.doi === 'string' ? r.doi.replace(/^https?:\/\/doi\.org\//i, '').trim() : '',
              abstract: abstractOf(r?.abstract_inverted_index),
              type: typeof r?.type === 'string' ? r.type : '',
              source: 'openalex'
            }))
            .filter((w) => w.title && (w.year || w.doi))
            .slice(0, limit * 2)
          const checked = await Promise.all(candidates.map(async (w) => ({ ...w, verified: await verify(w) })))
          const works = checked
            .sort((a, b) => Number(b.verified) - Number(a.verified) || Number(Boolean(b.abstract)) - Number(Boolean(a.abstract)))
            .slice(0, limit)
            .map((w, i) => ({ label: `R${i + 1}`, ...w, url: w.doi && DOI.test(w.doi) ? `https://doi.org/${w.doi}` : '' }))
          return { works, query: q }
        }
      }
    }
  }
}
