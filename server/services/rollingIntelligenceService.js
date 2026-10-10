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
  "actionItems": [ { "action": "string", "owner": "string or null", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ],
  "importantPoints": [ { "point": "string", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ]
}

Rules:
- This is a MERGE, not a replacement: carry forward anything from the previous understanding that's still relevant, update items that evolved (e.g. an open question that just got answered should move out of openQuestions), and add new items the new segments introduce.
- Every item's "source" must cite real segmentIds/timestamps from what you were given — prefer the newest segment(s) that best support it. Never invent a source.
- Keep it compact — this is a live glance view, not a full summary.`

function emptySnapshot() {
  return { currentTopics: [], decisions: [], openQuestions: [], actionItems: [], importantPoints: [] }
}

/**
 * Lightweight rolling meeting-intelligence tracker: the backend seam for
 * "don't wait until the meeting ends to understand everything". As
 * finalized canonical segments arrive from a LiveSpeechSession (Python),
 * ingest() buffers them; snapshot() asks the existing AI provider to merge
 * them into a running understanding, each item retaining its source
 * segment IDs/timestamps for future "jump to source" / grounded Q&A.
 * Reuses generateResponse as-is — no new provider code.
 *
 * Not wired to a live transport in this phase (no browser mic streaming
 * exists yet) — this is the seam, exercised directly with fabricated
 * finalized segments.
 */
export function createRollingIntelligenceTracker({ generate = generateResponse } = {}) {
  let pendingSegments = []
  let lastSnapshot = null
  let chain = Promise.resolve() // updates run one after another

  async function refresh() {
    // Only what was handed to the model is cleared afterwards: segments ingested while it was thinking are
    // still pending. (The whole buffer used to be emptied, silently losing those.)
    const batch = pendingSegments.slice()
    const previousText = lastSnapshot ? JSON.stringify(lastSnapshot) : '(none yet)'
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Previous rolling understanding:\n${previousText}\n\nNew segments:\n${batch.map(formatSegmentLine).join('\n')}`
      }
    ]

    const reply = await generate(messages) // if this throws, nothing is dropped: the batch stays pending
    pendingSegments = pendingSegments.slice(batch.length)

    const candidate = stripCodeFences(reply)
    try {
      lastSnapshot = JSON.parse(candidate)
    } catch (err) {
      lastSnapshot = { ...(lastSnapshot ?? emptySnapshot()), _lastParseError: err.message, _lastRaw: reply }
    }
    return lastSnapshot
  }

  return {
    ingest(newSegments) {
      pendingSegments.push(...newSegments)
    },

    hasPending() {
      return pendingSegments.length > 0
    },

    snapshot() {
      // One update at a time: a call made while one is running waits its turn, then sends only what is still
      // pending, so no segment goes to the model twice.
      const run = chain.then(() => (pendingSegments.length === 0 ? lastSnapshot ?? emptySnapshot() : refresh()))
      chain = run.catch(() => {})
      return run
    }
  }
}
