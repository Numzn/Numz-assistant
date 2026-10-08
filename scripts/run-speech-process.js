/**
 * Cross-platform launcher for the Speech Intelligence pipeline CLI
 * (audio/speech_cli.py), reusing the same venv as the live audio sidecar.
 */
import { runAudioScript } from './lib/audioPython.js'

runAudioScript({
  script: 'speech_cli.py',
  tag: 'speech',
  args: process.argv.slice(2),
  usage: 'Usage: npm run speech:process -- <audio-file> [--diarize] [--lang en] [--out transcript.json]'
})
