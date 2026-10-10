/**
 * Checks what a model said about a meeting against the saved transcript it was given.
 *
 * A model is asked to cite segment ids and times for everything it reports, and it may cite ones that do not
 * exist, give times that were not what those segments say, or state something the cited words do not support.
 * Nothing it returns is shown as fact until this has looked at it:
 *   - an item that cites no real segment is dropped, and listed under `rejected` with the reason
 *   - times and quotes always come from the segments themselves, never from the model
 *   - an item is `inferred` when its words are mostly found in what it cites, `uncertain` when they are not
 *     (or when a cited segment was recognised with low confidence)
 *   - an owner is kept only if the cited text names them or the cited segment carries that speaker label
 *   - a summary is listed with any number or proper name in it that appears nowhere in the transcript
 * Only deterministic findings (meetingSignals.js) can be `confirmed`. A model's reading is at best `inferred`.
 */

const CATEGORIES = {
  keyTopics: { field: 'topic', kind: 'topic' },
  currentTopics: { field: 'topic', kind: 'topic' },
  importantConcepts: { field: 'concept', kind: 'concept' },
  questions: { field: 'question', kind: 'question' },
  openQuestions: { field: 'question', kind: 'question' },
  studyNotes: { field: 'note', kind: 'note' },
  importantPoints: { field: 'point', kind: 'note' },
  decisions: { field: 'decision', kind: 'decision' },
  actionItems: { field: 'action', kind: 'actionItem' }
}

const STOP = new Set(
  ('a an the and or but if then so of to in on at by for from with about as is are was were be been being it its this that ' +
    'these those i you he she we they them our your their my me us not no yes do does did have has had will would can could ' +
    'should may might must there here what which who whom whose when where why how also just very more most some any all ' +
    'into over under up down out off than too each other another such own same only').split(' ')
)
const SUPPORT_THRESHOLD = 0.5
const LOW_CONFIDENCE = 0.4
const TIME_TOLERANCE_S = 1

export function contentWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 2 && !STOP.has(word))
}

/** A word counts as present when it, or its first five letters (a crude stem), is in the evidence. */
function supportRatio(words, evidenceText) {
  if (words.length === 0) return 0
  const evidence = new Set(contentWords(evidenceText))
  const stems = new Set([...evidence].map((word) => word.slice(0, 5)))
  const found = words.filter((word) => evidence.has(word) || stems.has(word.slice(0, 5))).length
  return found / words.length
}

function indexSegments(segments) {
  const byId = new Map()
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (segment && typeof segment.id === 'string') byId.set(segment.id, segment)
  }
  return byId
}

function groundItem(raw, { field, kind }, byId) {
  const text = typeof raw?.[field] === 'string' ? raw[field].trim() : ''
  if (!text) return { rejected: { kind, reason: 'no-text', claimed: null } }

  const cited = Array.isArray(raw?.source?.segmentIds) ? raw.source.segmentIds.filter((id) => typeof id === 'string') : []
  const real = [...new Set(cited)].filter((id) => byId.has(id))
  if (real.length === 0) {
    return { rejected: { kind, reason: cited.length ? 'cited-segments-do-not-exist' : 'no-source', claimed: text, cited } }
  }

  const segments = real.map((id) => byId.get(id))
  const start = Math.min(...segments.map((segment) => segment.start))
  const end = Math.max(...segments.map((segment) => segment.end))
  const evidenceText = segments.map((segment) => segment.text).join(' ')
  const caveats = []

  if (real.length < cited.length) caveats.push('some-cited-segments-do-not-exist')
  const claimedStart = Number(raw?.source?.start)
  const claimedEnd = Number(raw?.source?.end)
  if (
    (Number.isFinite(claimedStart) && Math.abs(claimedStart - start) > TIME_TOLERANCE_S) ||
    (Number.isFinite(claimedEnd) && Math.abs(claimedEnd - end) > TIME_TOLERANCE_S)
  ) {
    caveats.push('model-timestamps-replaced')
  }

  let status = 'inferred'
  const support = supportRatio(contentWords(text), evidenceText)
  if (support < SUPPORT_THRESHOLD) {
    status = 'uncertain'
    caveats.push('weak-lexical-support')
  }
  if (segments.some((segment) => typeof segment.confidence === 'number' && segment.confidence < LOW_CONFIDENCE)) {
    status = 'uncertain'
    caveats.push('low-asr-confidence')
  }

  const item = {
    id: `${kind}:${real[0]}:${text.slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    kind,
    text,
    status,
    basis: 'model-inference',
    source: { segmentIds: real, start, end },
    evidence: segments.map((segment) => ({ segmentId: segment.id, text: segment.text })),
    support: Math.round(support * 100) / 100,
    caveats
  }

  if (kind === 'actionItem') {
    const claimed = typeof raw?.owner === 'string' ? raw.owner.trim() : ''
    let owner = { name: null, evidence: null }
    if (claimed) {
      const lower = claimed.toLowerCase()
      if (evidenceText.toLowerCase().includes(lower)) owner = { name: claimed, evidence: 'named-in-cited-text' }
      else if (segments.some((segment) => String(segment.speaker ?? '').toLowerCase() === lower)) {
        owner = { name: claimed, evidence: 'speaker-label' }
      } else caveats.push('owner-unverified')
    }
    item.owner = owner
  }
  return { item }
}

// Capitalised only because they start a sentence: closed-class words and the words summaries open with.
const SENTENCE_STARTERS = new Set(
  ('the this that these those there they their it its we our he she his her i you your in on at as a an and but or so if ' +
    'then also however overall after before during while when once next first second third finally meanwhile several ' +
    'some many most all both each every no not nobody everyone someone anyone participants attendees speakers speaker ' +
    'team group meeting discussion discussions conversation topics topic decisions decision actions action questions ' +
    'question notes note summary key main other another one two three four five six seven eight nine ten later earlier ' +
    'today tomorrow yesterday currently previously finally ultimately importantly additionally furthermore').split(' ')
)

/** Numbers and proper names in `summary` that the transcript never contains. */
export function unsupportedTerms(summary, segments) {
  const transcript = (Array.isArray(segments) ? segments : []).map((segment) => segment.text).join(' ').toLowerCase()
  const found = new Set()
  const sentences = String(summary ?? '').split(/(?<=[.!?])\s+/)
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/)
    words.forEach((raw, index) => {
      const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
      if (!word) return
      const isNumber = /\d/.test(word)
      const looksLikeName = /^[A-Z][a-z]+$/.test(word)
      // Mid-sentence a capital is a name. A sentence's first word is capitalised anyway, so it counts only when
      // it is not a word summaries ordinarily open with.
      const isProperName = looksLikeName && (index > 0 || !SENTENCE_STARTERS.has(word.toLowerCase()))
      if ((isNumber || isProperName) && !transcript.includes(word.toLowerCase())) found.add(word)
    })
  }
  return [...found]
}

/**
 * @param {object} notes  what the model returned (any of the category arrays, and an optional `summary` string)
 * @param {object[]} segments  the saved canonical segments it was given
 * @returns {{ items: object[], rejected: object[], summary: object|null }}
 */
export function groundNotes(notes, segments) {
  const byId = indexSegments(segments)
  const items = []
  const rejected = []
  for (const [category, spec] of Object.entries(CATEGORIES)) {
    const entries = Array.isArray(notes?.[category]) ? notes[category] : []
    for (const raw of entries) {
      const result = groundItem(raw, spec, byId)
      if (result.item) items.push({ ...result.item, category })
      else rejected.push({ ...result.rejected, category })
    }
  }

  let summary = null
  if (typeof notes?.summary === 'string' && notes.summary.trim()) {
    const text = notes.summary.trim()
    const caveats = []
    const unsupported = unsupportedTerms(text, segments)
    if (unsupported.length) caveats.push('contains-terms-not-in-transcript')
    const allText = [...byId.values()].map((segment) => segment.text).join(' ')
    const support = supportRatio(contentWords(text), allText)
    if (support < 0.6) caveats.push('weak-lexical-support')
    summary = {
      text,
      status: caveats.length ? 'uncertain' : 'inferred',
      basis: 'model-inference',
      scope: 'whole-transcript',
      support: Math.round(support * 100) / 100,
      unsupportedTerms: unsupported,
      caveats
    }
  }
  return { items, rejected, summary }
}
