/**
 * Numz Study Mode — grounded AI notes from a canonical Speech Intelligence
 * transcript (produced by `npm run speech:process`). Every extracted
 * topic/concept/question/note retains its source segment IDs and
 * timestamps for future "jump to source" / grounded Q&A. Uses the
 * existing, unmodified AI provider abstraction (server/services/aiService.js).
 *
 * Usage:
 *   node scripts/speech-notes.js <transcript.json> [out.json]
 */
import '../server/loadEnv.js'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { generateGroundedNotes } from '../server/services/speechNotesService.js'

const [, , transcriptPathArg, outArg] = process.argv

if (!transcriptPathArg) {
  console.error('Usage: npm run speech:notes -- <transcript.json> [out.json]')
  process.exit(1)
}

const transcriptPath = path.resolve(transcriptPathArg)
const transcript = JSON.parse(readFileSync(transcriptPath, 'utf-8'))

const outPath = outArg
  ? path.resolve(outArg)
  : transcriptPath.replace(/\.transcript\.json$/i, '').concat('.notes.json')

const result = await generateGroundedNotes(transcript)
writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8')

if (result.notes) {
  console.log(`Grounded study notes written to ${outPath}`)
} else {
  console.warn(`Model did not return valid JSON (${result.parseError}); raw reply saved to ${outPath}`)
}
