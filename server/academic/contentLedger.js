import { randomUUID } from 'node:crypto'
import { identityText, sameQuestion } from '../camera/questionIdentity.js'

/**
 * The content ledger: what a study session has already seen on the person's screen, as SEGMENTS (a question, a paragraph, a code block, a
 * table, a figure, a list: any independent piece of meaningful content, whatever the document). Every screen the vision model reads is a list
 * of segments; this decides, for each one, whether it is NEW, already SEEN, has GROWN (more of it is visible than before: a scroll, a
 * longer selection), or CONTINUES one that was cut off at the edge of an earlier screen, and it keeps the relations between segments.
 *
 * Everything is by content and never by layout or by a mode the person chooses, so the same rules cover one segment or many on a screen,
 * pages and tabs and slides (a different set each time, and an earlier one coming back), scrolling (screens that overlap, a segment cut at
 * the bottom that is whole on the next screen) and content that continues across screens:
 *
 *   same       the same text again (a misread letter is tolerated, a different number is not)       -> seen, nothing to process
 *   inside     a part of a segment already known (only a piece of it is visible now)                -> seen
 *   grew       a known segment with more of it visible (text before and/or after)                   -> the segment is updated in place
 *   continued  the end of a cut-off segment is the start of this one (they share some words)         -> merged into one segment
 *   new        none of the above                                                                    -> added
 *
 * What is never done: a segment is never dropped because it overlaps an earlier screen, and new text is never merged into something it only
 * resembles. When in doubt the answer is "new": reading something twice costs a little, missing something costs the person the content.
 * Held in the session's memory only, like the rest of what a screen yields.
 */

export const LEDGER_LIMITS = Object.freeze({
  maxSegments: 400,
  maxWords: 600, // compared per segment (a longer one is compared by its first 600 words)
  minOverlapWords: 4, // words two screens must share at the cut for a segment to be called a continuation (when it was marked as cut off)
  strongOverlapWords: 12 // words that make a continuation certain even if neither screen marked the cut
})

const SAME_RATIO = 0.94 // long text: the share of words in common (short text uses the question rule: 96% of the characters)
const PART_RATIO = 0.92 // the share of the smaller text found, in order, in the larger
const GROWTH_WORDS = 3 // more words than this must be visible for a segment to count as having grown
const MIN_PART_WORDS = 6 // a text shorter than this is never taken for a part of another, or as having grown
const FUZZY_OVERLAP = 0.9

const normalizeWord = (word) =>
  word
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–—]/g, '-')
    .replace(/[“”‘’"'`]/g, '')
    .replace(/^[.,;:!?]+|[.,;:!?]+$/g, '')

/** A text as words: the words as shown, and the same words normalised for comparison (the two lists line up one to one). */
export function wordsOf(text) {
  const raw = []
  const norm = []
  for (const word of String(text ?? '').replace(/\u0000/g, '').split(/\s+/)) {
    const n = normalizeWord(word)
    if (!n) continue
    raw.push(word)
    norm.push(n)
  }
  return { raw: raw.slice(0, LEDGER_LIMITS.maxWords), norm: norm.slice(0, LEDGER_LIMITS.maxWords) }
}

const numbersOf = (norm) => norm.filter((w) => /\d/.test(w)).join(' ')

/** The longest common subsequence of two word lists: its length and where it starts and ends in each. */
function match(a, b) {
  const n = a.length
  const m = b.length
  if (!n || !m) return { length: 0, aFirst: -1, aLast: -1, bFirst: -1, bLast: -1 }
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1])
  }
  let i = n
  let j = m
  let aFirst = -1
  let aLast = -1
  let bFirst = -1
  let bLast = -1
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      if (aLast === -1) [aLast, bLast] = [i - 1, j - 1]
      ;[aFirst, bFirst] = [i - 1, j - 1]
      i--
      j--
    } else if (table[i - 1][j] >= table[i][j - 1]) i--
    else j--
  }
  return { length: table[n][m], aFirst, aLast, bFirst, bLast }
}

/** How much of the smaller set of words is in the larger, and how much of the two together is shared. A cheap test before a careful one. */
function overlapOf(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const word of small) if (large.has(word)) shared++
  return { contained: shared / Math.max(1, small.size), jaccard: shared / Math.max(1, a.size + b.size - shared) }
}

/** Whether the last `k` words of `before` are (nearly) the first `k` words of `after`: the largest such k of at least `min`, or 0. */
function overlapAtCut(before, after, min) {
  const most = Math.min(60, before.length - 1, after.length - 1)
  for (let k = most; k >= min; k--) {
    const tail = before.slice(-k)
    const head = after.slice(0, k)
    if (tail.every((w, i) => w === head[i])) return k
    if (k <= 24 && match(tail, head).length / k >= FUZZY_OVERLAP) return k
  }
  return 0
}

const cleanGroup = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)

/** What identifies a segment's content: a question by its wording and options (the Smart Camera's rule), anything else by its text. */
const matchText = (segment) => (segment.kind === 'question' ? identityText({ text: segment.text, options: segment.options }) : segment.text)

function relate(known, incoming) {
  const a = known.norm
  const b = incoming.norm
  if (!a.length || !b.length) return null
  const { contained, jaccard } = overlapOf(known.set, incoming.set)
  if (jaccard >= 0.6 && numbersOf(a) === numbersOf(b) && (a.length <= 140 && b.length <= 140 ? sameQuestion(known.match, incoming.match) : match(a, b).length / Math.max(a.length, b.length) >= SAME_RATIO)) return { type: 'same' }
  const cutAfter = known.cut.bottom || incoming.cut.top
  const cutBefore = known.cut.top || incoming.cut.bottom
  if (contained >= 0.5) {
    const m = match(a, b)
    const ofKnown = m.length / a.length
    const ofIncoming = m.length / b.length
    // The smaller text must be found nearly whole and nearly in one piece inside the larger, and be long enough to mean something.
    if (b.length >= MIN_PART_WORDS && a.length > b.length && ofIncoming >= PART_RATIO && m.aLast - m.aFirst + 1 <= b.length * 1.25 + 2) return { type: 'inside' }
    if (a.length >= MIN_PART_WORDS && b.length >= a.length + GROWTH_WORDS && ofKnown >= PART_RATIO && m.bLast - m.bFirst + 1 <= a.length * 1.25 + 2) {
      return { type: 'grew', before: m.bFirst, after: b.length - 1 - m.bLast }
    }
  }
  // Two screens that cut one segment: the end of the earlier one is the start of the later one (scrolling down), or the other way round (up).
  const after = overlapAtCut(a, b, cutAfter ? LEDGER_LIMITS.minOverlapWords : LEDGER_LIMITS.strongOverlapWords)
  if (after) return { type: 'continued', side: 'after', overlap: after }
  const before = overlapAtCut(b, a, cutBefore ? LEDGER_LIMITS.minOverlapWords : LEDGER_LIMITS.strongOverlapWords)
  if (before) return { type: 'continued', side: 'before', overlap: before }
  return null
}

const RANK = { same: 4, grew: 3, inside: 2, continued: 1 }

export function createContentLedger({ now = Date.now, newId = randomUUID, limits = {} } = {}) {
  const cap = { ...LEDGER_LIMITS, ...limits }
  /** @type {Map<string, object>} */
  const records = new Map()
  let lastCaptureId = null

  const publicView = (record, status, extra = {}) => ({
    id: record.id,
    kind: record.kind,
    title: record.title,
    text: record.words.join(' '),
    options: record.options,
    marks: record.marks,
    type: record.type,
    hasDiagram: record.hasDiagram,
    region: record.region,
    group: record.group,
    status,
    partial: record.cut.top || record.cut.bottom ? { top: record.cut.top, bottom: record.cut.bottom } : null,
    continuesFrom: record.continuesFrom,
    related: [],
    seenCount: record.seenCount,
    firstCaptureId: record.firstCaptureId,
    lastCaptureId: record.lastCaptureId,
    questionId: record.questionId,
    ...extra
  })

  const prepare = (segment) => {
    const { raw, norm } = wordsOf(segment.text)
    return {
      kind: segment.kind,
      title: String(segment.title ?? '').trim().slice(0, 120),
      options: Array.isArray(segment.options) ? segment.options : [],
      marks: segment.marks ?? null,
      type: segment.type ?? 'other',
      hasDiagram: segment.hasDiagram === true,
      region: Array.isArray(segment.region) ? segment.region : null,
      group: cleanGroup(segment.group),
      dependsOn: cleanGroup(segment.dependsOn),
      cut: { top: segment.cutOff === 'top' || segment.cutOff === 'both', bottom: segment.cutOff === 'bottom' || segment.cutOff === 'both' },
      words: raw,
      norm,
      set: new Set(norm),
      match: matchText(segment)
    }
  }

  function evict() {
    if (records.size <= cap.maxSegments) return
    const oldest = [...records.values()].sort((x, y) => x.lastSeenAt - y.lastSeenAt)
    for (const record of oldest.slice(0, records.size - cap.maxSegments)) records.delete(record.id)
  }

  /** The segments of one screen, in reading order, against everything seen so far. */
  function integrate(captureId, incoming, { position = '' } = {}) {
    const previousCaptureId = lastCaptureId
    const t = now()
    const taken = new Set() // a known segment answers for at most one segment of a screen
    const out = []
    for (const segment of incoming) {
      const next = prepare(segment)
      if (!next.norm.length) continue
      let best = null
      for (const record of records.values()) {
        if (taken.has(record.id)) continue
        const relation = relate(record, next)
        if (relation && (!best || RANK[relation.type] > RANK[best.relation.type] || (RANK[relation.type] === RANK[best.relation.type] && (relation.overlap ?? 0) > (best.relation.overlap ?? 0)))) best = { record, relation }
        if (best?.relation.type === 'same') break
      }
      if (!best) {
        const record = { id: newId(), ...next, firstCaptureId: captureId, lastCaptureId: captureId, firstSeenAt: t, lastSeenAt: t, seenCount: 1, continuesFrom: null, questionId: null, history: [captureId] }
        // Cut off at the top and the previous screen left a segment cut off at the bottom: this is probably its continuation, without shared words.
        if (record.cut.top && previousCaptureId) {
          const left = [...records.values()].reverse().find((r) => r.lastCaptureId === previousCaptureId && r.cut.bottom && !taken.has(r.id) && (!record.group || r.group === record.group))
          if (left) record.continuesFrom = left.id
        }
        records.set(record.id, record)
        taken.add(record.id)
        out.push({ record, view: publicView(record, 'new'), wasPrevious: false })
        continue
      }
      const { record, relation } = best
      taken.add(record.id)
      const wasPartial = record.cut.top || record.cut.bottom
      const status = { same: 'seen', inside: 'seen', grew: 'grew', continued: 'continued' }[relation.type]
      let added = null
      if (relation.type === 'grew') {
        // The incoming text holds the known text; the words around the match are what is new.
        added = { words: relation.before + relation.after, before: relation.before, after: relation.after }
        record.words = next.words
        record.norm = next.norm
        record.set = next.set
        record.match = next.match
        record.cut = next.cut
      } else if (relation.type === 'continued') {
        const k = relation.overlap
        if (relation.side === 'after') {
          const rest = next.words.slice(k)
          added = { words: rest.length, before: 0, after: rest.length }
          record.words = [...record.words, ...rest].slice(0, cap.maxWords * 3)
          record.norm = [...record.norm, ...next.norm.slice(k)].slice(0, cap.maxWords * 3)
          record.cut = { top: record.cut.top, bottom: next.cut.bottom }
        } else {
          const rest = next.words.slice(0, next.words.length - k)
          added = { words: rest.length, before: rest.length, after: 0 }
          record.words = [...rest, ...record.words].slice(0, cap.maxWords * 3)
          record.norm = [...next.norm.slice(0, next.norm.length - k), ...record.norm].slice(0, cap.maxWords * 3)
          record.cut = { top: next.cut.top, bottom: record.cut.bottom }
        }
        record.set = new Set(record.norm)
        record.match = record.kind === 'question' ? identityText({ text: record.words.join(' '), options: record.options }) : record.words.join(' ')
      } else {
        // Seen again: it is whole now if it was cut off and this view is not.
        if (relation.type === 'same') record.cut = { top: record.cut.top && next.cut.top, bottom: record.cut.bottom && next.cut.bottom }
        if (!record.title && next.title) record.title = next.title
      }
      if (next.group && !record.group) record.group = next.group
      if (next.options.length > record.options.length) record.options = next.options
      if (next.marks && !record.marks) record.marks = next.marks
      if (next.hasDiagram) record.hasDiagram = true
      const wasPrevious = Boolean(previousCaptureId) && record.history.includes(previousCaptureId)
      record.seenCount += 1
      record.lastCaptureId = captureId
      record.lastSeenAt = t
      record.history = [...record.history, captureId].slice(-6)
      const nowWhole = wasPartial && !(record.cut.top || record.cut.bottom)
      out.push({ record, view: publicView(record, status, { added, completed: nowWhole && relation.type !== 'same' ? true : undefined }), wasPrevious })
    }
    evict()

    // Relations inside the screen: a segment that depends on another one by its title, and segments of one group.
    const byTitle = (title) => (title ? out.find((o) => o.record.title && cleanGroup(o.record.title) === title) : null)
    for (const o of out) {
      const ids = new Set()
      const target = byTitle(o.record.dependsOn)
      if (target && target.record.id !== o.record.id) ids.add(target.record.id)
      if (o.record.group) for (const other of records.values()) if (other.id !== o.record.id && other.group === o.record.group) ids.add(other.id)
      if (o.record.continuesFrom) ids.add(o.record.continuesFrom)
      o.view.related = [...ids].slice(0, 6)
    }

    lastCaptureId = captureId
    const views = out.map((o) => o.view)
    const count = (status) => views.filter((v) => v.status === status).length
    const summary = { total: views.length, new: count('new'), seen: count('seen'), grew: count('grew'), continued: count('continued'), partial: views.filter((v) => v.partial).length }
    const fresh = summary.new + summary.grew + summary.continued
    // How this screen relates to the last one, from the content alone: nothing the person chose.
    let arrival = 'empty'
    if (views.length) {
      if (fresh === 0) arrival = out.every((o) => o.wasPrevious) ? 'same' : 'revisit'
      else if (summary.seen > 0 || summary.grew > 0 || summary.continued > 0) arrival = 'overlapping'
      else arrival = 'new-screen'
    }
    return { segments: views, summary, arrival, layout: views.length > 1 ? 'multiple' : 'single', position: String(position ?? '').slice(0, 80), previousCaptureId }
  }

  return {
    integrate,
    /** Ties a segment to the question the session offered for it. */
    link(id, questionId) {
      const record = records.get(id)
      if (record) record.questionId = questionId
    },
    get: (id) => records.get(id) ?? null,
    list: () => [...records.values()].map((record) => publicView(record, 'seen')),
    /** The segments a question depends on: its group, what it names, what it continues; short, for the answer to read. */
    relatedTo(id, { limit = 3, maxChars = 1200 } = {}) {
      const record = records.get(id)
      if (!record) return []
      const wanted = new Set()
      if (record.continuesFrom) wanted.add(record.continuesFrom)
      if (record.group) for (const other of records.values()) if (other.id !== id && other.group === record.group) wanted.add(other.id)
      if (record.dependsOn) for (const other of records.values()) if (other.id !== id && cleanGroup(other.title) === record.dependsOn) wanted.add(other.id)
      return [...wanted]
        .map((rid) => records.get(rid))
        .filter(Boolean)
        .filter((r) => r.kind !== 'question' || r.id === record.continuesFrom)
        .slice(0, limit)
        .map((r) => ({ title: r.title, kind: r.kind, text: r.words.join(' ').slice(0, maxChars) }))
    },
    size: () => records.size
  }
}
