import { generateResponse } from './aiService.js'
import { formatSegmentLine, stripCodeFences } from '../utils/prompt.js'

const SYSTEM_PROMPT = `You maintain a rolling understanding of an in-progress meeting/lecture as it happens, from newly finalized transcript segments.

You will be given:
1. The previous rolling understanding as JSON (or "(none yet)" if this is the first update).
2. New transcript segments finalized since that last update.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary), matching exactly:

{
  "currentTopics": [ { "topic": "string", "source": { "segmentIds": ["seg_0001"], "start": 0, "end": 0 } } ],
  "decisions": [ { "decision": "string", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ],
  "openQuestions": [ { "question": "string", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ],
  "actionItems": [ { "action": "string", "owner": "string or null", "due": "string or null", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ],
  "importantPoints": [ { "point": "string", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ]
}

Rules:
- This is a MERGE, not a replacement: carry forward anything from the previous understanding that's still relevant, update items that evolved (e.g. an open question that just got answered should move out of openQuestions), and add new items the new segments introduce.
- Every item's "source" must cite real segmentIds/timestamps from what you were given — prefer the newest segment(s) that best support it. Never invent a source.
- Keep it compact — this is a live glance view, not a full summary.
- "owner" and "due" are ONLY what a speaker explicitly said, in their words ("Priya will send it", "by Friday"). If nobody said, they are null. Never infer an owner from who was speaking or a deadline from context.
- A decision is something the speakers actually settled ("we agreed", "let's go with"), not something merely discussed.`

function emptySnapshot() {
  return { currentTopics: [], decisions: [], openQuestions: [], actionItems: [], importantPoints: [] }
}

/** The model answered, but not with the JSON this tracker asked for. The segments it was sent stay pending. */
export class RollingOutputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RollingOutputError'
    this.code = 'model-output-unusable'
  }
}

const byTimeline = (a, b) => (a.start ?? 0) - (b.start ?? 0) || (a.end ?? 0) - (b.end ?? 0) || String(a.id).localeCompare(String(b.id))

/**
 * Lightweight rolling meeting-intelligence tracker. Persisted canonical segments are ingested; snapshot() asks the
 * AI provider to merge them into a running understanding, each item retaining its source segment ids.
 *
 *  - Duplicates (the same segment id, however often it is delivered) are ignored.
 *  - Segments arriving out of order are sent to the model in timeline order.
 *  - Only what was handed to the model AND came back usable leaves the pending list: a provider error or an
 *    unusable answer drops nothing, so the same segments go again next time. Segments ingested while the model
 *    works are never discarded.
 *  - Updates run one at a time, in batches of at most `maxBatch` segments, so a long backlog (a restart in the
 *    middle of a meeting) is not one enormous prompt.
 *
 * The caller (liveMeetingIntelligenceService) decides WHEN to snapshot and checks what comes back against the
 * saved transcript; this module does not know about meetings, persistence or the clock.
 */
export function createRollingIntelligenceTracker({ generate = generateResponse, maxBatch = 60 } = {}) {
  let pendingSegments = []
  const known = new Set() // every id ever ingested: pending or merged
  let lastSnapshot = null
  let merged = 0
  let chain = Promise.resolve() // updates run one after another

  async function refresh() {
    const batch = pendingSegments.slice().sort(byTimeline).slice(0, maxBatch)
    if (batch.length === 0) return lastSnapshot
    const batchIds = new Set(batch.map((segment) => segment.id))
    const previousText = lastSnapshot ? JSON.stringify(lastSnapshot) : '(none yet)'
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Previous rolling understanding:\n${previousText}\n\nNew segments:\n${batch.map(formatSegmentLine).join('\n')}`
      }
    ]

    const reply = await generate(messages) // if this throws, nothing is dropped: the batch stays pending
    let parsed
    try {
      parsed = JSON.parse(stripCodeFences(String(reply ?? '')))
    } catch (err) {
      throw new RollingOutputError(`The model did not return JSON: ${err.message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RollingOutputError('The model returned JSON that is not an object')
    }
    lastSnapshot = { ...emptySnapshot(), ...parsed }
    pendingSegments = pendingSegments.filter((segment) => !batchIds.has(segment.id))
    merged += batch.length
    return lastSnapshot
  }

  return {
    /** -> how many of `newSegments` were new (not seen before) */
    ingest(newSegments) {
      let accepted = 0
      for (const segment of Array.isArray(newSegments) ? newSegments : []) {
        if (!segment || typeof segment.id !== 'string' || known.has(segment.id)) continue
        known.add(segment.id)
        pendingSegments.push(segment)
        accepted += 1
      }
      return accepted
    },

    hasPending() {
      return pendingSegments.length > 0
    },

    pendingCount() {
      return pendingSegments.length
    },

    /** How many segments the current snapshot has absorbed. */
    mergedCount() {
      return merged
    },

    lastSnapshot() {
      return lastSnapshot
    },

    snapshot() {
      // One update at a time: a call made while one is running waits its turn, then sends only what is still
      // pending, so no segment goes to the model twice. A backlog is worked off a batch at a time.
      const run = chain.then(async () => {
        // What was waiting when this update began. Segments that arrive while the model works are for the next one.
        const wanted = new Set(pendingSegments.map((segment) => segment.id))
        while (pendingSegments.some((segment) => wanted.has(segment.id))) await refresh()
        return lastSnapshot ?? emptySnapshot()
      })
      chain = run.catch(() => {})
      return run
    }
  }
}
