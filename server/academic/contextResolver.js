import { contentWords } from '../intelligence/grounding.js'

/**
 * The Academic Context Resolver: which of the person's courses a question belongs to, decided from what they declared and what is on the
 * screen, never invented. A course the person chose for the session always wins. Without one, a course is picked only when its title or
 * code clearly matches the screen and no other course matches nearly as well; otherwise the answer is "ask", with the candidates.
 *
 * Deterministic and small on purpose: it reads words, it does not guess. Confidence is `high` (declared, or an unmistakable match),
 * `medium` (a clear match), `low` (not enough) or `none` (the person has no courses, so there is nothing to attach to).
 */

// Words that appear in many course titles and say nothing about which course: they never count towards a match on their own.
const GENERIC = new Set(['systems', 'system', 'introduction', 'intro', 'advanced', 'principles', 'fundamentals', 'foundations', 'studies', 'theory', 'applied', 'general', 'topics', 'concepts', 'basics', 'practice', 'methods', 'management'])
const MATCH = 0.5
const MARGIN = 0.25
const STRONG = 0.8

function scoreCourse(course, haystackWords, haystackText) {
  const all = [...new Set(contentWords(course.title))]
  const titleWords = all.filter((w) => !GENERIC.has(w)).length ? all.filter((w) => !GENERIC.has(w)) : all
  let score = titleWords.length ? titleWords.filter((w) => haystackWords.has(w) || [...haystackWords].some((h) => h.length > 4 && w.length > 4 && h.slice(0, 5) === w.slice(0, 5))).length / titleWords.length : 0
  const code = String(course.code ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (code.length >= 3 && haystackText.replace(/\s+/g, '').includes(code)) score = Math.min(1, score + 0.6)
  return Math.round(score * 100) / 100
}

/**
 * @param {{ session: object|null, courses: object[], reading?: { subject?: string, topic?: string, questions?: {text:string}[] }, text?: string }} input
 */
export function resolveContext({ session, courses, reading = {}, text = '' }) {
  const list = Array.isArray(courses) ? courses : []
  const material = [reading.subject, reading.topic, text, ...(reading.questions ?? []).map((q) => q.text)].filter((v) => typeof v === 'string').join(' ')
  const words = new Set(contentWords(material))
  const lower = material.toLowerCase()
  const scored = list.map((course) => ({ courseId: course.id, title: course.title, score: scoreCourse(course, words, lower) })).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))

  if (list.length === 0) return { courseId: null, confidence: 'none', source: 'none', needsClarification: false, candidates: [], reason: 'no-courses' }

  if (session?.courseId) {
    const chosen = list.find((c) => c.id === session.courseId)
    if (chosen) {
      const own = scored.find((c) => c.courseId === chosen.id)?.score ?? 0
      const rival = scored.find((c) => c.courseId !== chosen.id)
      const mismatch = rival && rival.score >= STRONG && own < 0.2 ? { courseId: rival.courseId, title: rival.title } : null
      return { courseId: chosen.id, confidence: 'high', source: 'session', needsClarification: false, candidates: [], reason: 'declared-for-session', ...(mismatch ? { note: 'the-screen-looks-like-another-course', suggestion: mismatch } : {}) }
    }
  }

  const [best, second] = scored
  if (best && best.score >= MATCH && best.score - (second?.score ?? 0) >= MARGIN) {
    return { courseId: best.courseId, confidence: best.score >= STRONG ? 'high' : 'medium', source: 'match', needsClarification: false, candidates: [], reason: 'matches-title-or-code' }
  }
  return { courseId: null, confidence: 'low', source: 'none', needsClarification: true, candidates: scored.slice(0, 3).map(({ courseId, title }) => ({ courseId, title })), reason: best?.score >= MATCH ? 'several-courses-match' : 'no-course-matches' }
}
