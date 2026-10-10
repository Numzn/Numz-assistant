import { generateResponse } from './aiService.js'
import { formatSegmentLine, stripCodeFences } from '../utils/prompt.js'

/**
 * The final record of a MEETING, written once its transcript is closed and verified. (speechNotesService is the
 * study-notes variant for lectures: topics and concepts, no decisions or owners.)
 *
 * Same contract as speechNotesService.generateGroundedNotes, so the caller can swap either in:
 *   -> { schemaVersion, notes } | { schemaVersion, notes: null, raw, parseError }
 * Nothing it returns is trusted: intelligence/grounding.js checks every item against the transcript it was given.
 */

const SCHEMA_VERSION = '1.0'

const SYSTEM_PROMPT = `You write the final record of a meeting from its saved transcript.

The transcript is a sequence of lines like:
[seg_0041 | 42:01-42:34 | speaker_00] We agreed to ship on Friday.

Each line's leading [seg_ID | start-end | speaker] tag is metadata, not part of the spoken text.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary), exactly this shape:

{
  "summary": "3-6 sentence overview of what the meeting covered and concluded",
  "keyTopics": [ { "topic": "string", "source": { "segmentIds": ["seg_0041"], "start": 0, "end": 0 } } ],
  "decisions": [ { "decision": "string", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ],
  "actionItems": [ { "action": "string", "owner": "string or null", "due": "string or null", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ],
  "openQuestions": [ { "question": "string", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ]
}

Rules:
- Every item MUST cite real segment ids copied from the transcript tags it came from. Never invent a source.
- A decision is something the speakers actually settled ("we agreed", "let's go with"), not something merely discussed.
- "owner" and "due" are ONLY what a speaker explicitly said, in their words ("Priya will send it", "by Friday"). If nobody said, they are null. Never infer an owner from who was speaking or a deadline from context.
- "openQuestions" are questions that were asked and never answered in the transcript. Empty array if none.
- Use only what is in the transcript. Do not add names, numbers or facts that are not there.
- Be concise. Empty arrays are correct when there is nothing to report.`

export async function generateMeetingSummary(transcript, { generate = generateResponse } = {}) {
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : []
  if (segments.length === 0) throw new Error('Transcript is empty — nothing to summarize')
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Transcript:\n\n${segments.map(formatSegmentLine).join('\n')}` }
  ]
  const reply = await generate(messages)
  try {
    return { schemaVersion: SCHEMA_VERSION, notes: JSON.parse(stripCodeFences(String(reply ?? ''))) }
  } catch (err) {
    return { schemaVersion: SCHEMA_VERSION, notes: null, raw: reply, parseError: err.message }
  }
}
