/**
 * Numz Study Mode — Phase 0: turn a Lecture Engine transcript into study notes
 * using the existing, provider-swappable AI service (server/services/aiService.js).
 *
 * Usage:
 *   node scripts/lecture-notes.js <transcript.json> [out.md]
 */
import '../server/loadEnv.js'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { generateLectureNotes } from '../server/services/lectureService.js'

const [, , transcriptPathArg, outArg] = process.argv

if (!transcriptPathArg) {
  console.error('Usage: npm run lecture:notes -- <transcript.json> [out.md]')
  process.exit(1)
}

const transcriptPath = path.resolve(transcriptPathArg)
const transcript = JSON.parse(readFileSync(transcriptPath, 'utf-8'))

const outPath = outArg
  ? path.resolve(outArg)
  : transcriptPath.replace(/\.transcript\.json$/i, '').concat('.notes.md')

const notes = await generateLectureNotes(transcript)
writeFileSync(outPath, notes, 'utf-8')

console.log(`Study notes written to ${outPath}`)
