import { generateResponse } from './aiService.js'
import { formatSegmentLine, stripCodeFences } from '../utils/prompt.js'

const SCHEMA_VERSION = '1.0'

const SYSTEM_PROMPT = `You are Numz Study Mode, turning a canonical speech transcript into grounded study notes.

The transcript is a sequence of lines like:
[seg_0041 | 42:01-42:34 | speaker_00] Today we're discussing distributed systems.

Each line's leading [seg_ID | start-end | speaker] tag is metadata, not part of the spoken text.

Respond with ONLY a single valid JSON object (no markdown code fences, no commentary before or after), matching exactly this shape:

{
  "summary": "2-4 sentence overview of the whole recording",
  "keyTopics": [ { "topic": "string", "source": { "segmentIds": ["seg_0041"], "start": 2521.4, "end": 2594.0 } } ],
  "importantConcepts": [ { "concept": "string", "explanation": "one line", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ],
  "questions": [ { "question": "string describing an unclear or unresolved point", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ],
  "studyNotes": [ { "note": "string, a concise reviewable point", "source": { "segmentIds": [...], "start": 0, "end": 0 } } ]
}

Rules:
- Every item in keyTopics/importantConcepts/questions/studyNotes MUST include a "source" with the real segmentIds and start/end timestamps (in seconds, as numbers) copied from the transcript tags it was drawn from — this lets a reader jump back to that moment. Never invent a source; only cite tags that actually appear in the transcript.
- If speaker labels are meaningful (more than one real speaker), you may reference who said something in the text fields.
- If nothing is unclear, return an empty "questions" array rather than inventing a question.
- Be concise. Do not restate the whole transcript.`

function formatCanonicalTranscriptForPrompt(transcript) {
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : []
  if (segments.length > 0) {
    return segments.map(formatSegmentLine).join('\n')
  }
  return typeof transcript?.text === 'string' ? transcript.text : ''
}

/**
 * Turn a canonical Speech Intelligence transcript (audio/speech/schema.py
 * shape) into grounded study notes: every extracted item retains the
 * source segment IDs / timestamps it was drawn from, for future
 * "jump to source" / grounded Q&A. Uses the existing, unmodified AI
 * provider abstraction (aiService.js) — no new provider code.
 *
 * @param {object} transcript canonical transcript (schemaVersion, segments[], ...)
 * @returns {Promise<{schemaVersion: string, notes: object, raw?: string, parseError?: string}>}
 */
export async function generateGroundedNotes(transcript) {
  const transcriptText = formatCanonicalTranscriptForPrompt(transcript).trim()
  if (!transcriptText) {
    throw new Error('Transcript is empty — nothing to summarize')
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Transcript:\n\n${transcriptText}` }
  ]

  const reply = await generateResponse(messages)
  const candidate = stripCodeFences(reply)

  try {
    const notes = JSON.parse(candidate)
    return { schemaVersion: SCHEMA_VERSION, notes }
  } catch (err) {
    return { schemaVersion: SCHEMA_VERSION, notes: null, raw: reply, parseError: err.message }
  }
}
