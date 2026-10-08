import { generateResponse } from './aiService.js'
import { formatTimestamp } from '../utils/prompt.js'

const SYSTEM_PROMPT = `You are Numz Study Mode, an assistant that turns lecture transcripts into study material.
Given a timestamped lecture transcript, respond in Markdown with exactly these four sections, in this order:

## Key Topics
Bullet list of the main topics covered, in the order they came up. Include an approximate timestamp (mm:ss) for each.

## Important Concepts
Bullet list of concepts, definitions, or terms worth remembering, each with a short one-line explanation.

## Questions & Unclear Points
Bullet list of anything the lecturer left ambiguous, glossed over, or that a student would likely need to ask about. If nothing is unclear, say so explicitly.

## Study Notes
A concise set of study notes a student could review before an exam — short paragraphs or bullets, organized logically by subject rather than strictly in transcript order.

Be concise. Do not restate the whole transcript.`

function formatTranscriptForPrompt(transcript) {
  if (Array.isArray(transcript?.segments) && transcript.segments.length > 0) {
    return transcript.segments
      .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
      .join('\n')
  }
  return typeof transcript?.text === 'string' ? transcript.text : String(transcript ?? '')
}

/**
 * Phase 0: single-shot summarization, no chunking.
 * Fine for typical lecture-length transcripts on current provider context
 * windows; very long transcripts may need a map-reduce pass later.
 *
 * @param {{ segments?: {start:number,end:number,text:string}[], text?: string }} transcript
 * @returns {Promise<string>} Markdown study notes
 */
export async function generateLectureNotes(transcript) {
  const transcriptText = formatTranscriptForPrompt(transcript).trim()
  if (!transcriptText) {
    throw new Error('Transcript is empty — nothing to summarize')
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Lecture transcript:\n\n${transcriptText}` }
  ]

  return generateResponse(messages)
}
