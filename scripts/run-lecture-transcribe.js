/**
 * Cross-platform launcher for the Lecture Engine transcription CLI
 * (audio/lecture_cli.py), reusing the same venv as the live audio sidecar.
 */
import { runAudioScript } from './lib/audioPython.js'

runAudioScript({
  script: 'lecture_cli.py',
  tag: 'lecture',
  args: process.argv.slice(2),
  usage: 'Usage: npm run lecture:transcribe -- <audio-file> [--lang en] [--out transcript.json]'
})
