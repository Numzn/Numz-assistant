/**
 * Launcher for the replay-and-score tool (audio/replay_cli.py), using the sidecar's venv and the same .env
 * files as the services, so it decodes with the model and gate settings the sidecar has.
 *
 * The tool runs from audio/, so file arguments are made absolute here, relative to where `npm run` was
 * typed; otherwise `audio/recordings/x.wav` would be looked up inside audio/.
 */
import '../server/loadEnv.js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runAudioScript } from './lib/audioPython.js'

const FILE_FLAGS = new Set(['--reference', '--json'])
const FLAGS_WITH_VALUE = new Set(['--reference', '--json', '--pace', '--language'])
const base = process.env.INIT_CWD || process.cwd()

export function absolutizeArgs(args, cwd = base) {
  const out = []
  let positionalSeen = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (FLAGS_WITH_VALUE.has(arg) && i + 1 < args.length) {
      out.push(arg, FILE_FLAGS.has(arg) ? path.resolve(cwd, args[i + 1]) : args[i + 1])
      i++
    } else if (!arg.startsWith('-') && !positionalSeen) {
      positionalSeen = true
      out.push(path.resolve(cwd, arg))
    } else {
      out.push(arg)
    }
  }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAudioScript({
    script: 'replay_cli.py',
    tag: 'replay',
    args: absolutizeArgs(process.argv.slice(2)),
    usage:
      'Usage: npm run speech:replay -- <recording.wav> [--reference transcript.txt] [--pace 1] [--language en] [--json out.json]'
  })
}
