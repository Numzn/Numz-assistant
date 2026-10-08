/**
 * Shared launcher for the Python audio tooling (sidecar server + CLIs): runs a
 * script from audio/ with the sidecar's venv (audio/.venv) when present, else
 * the system Python, and mirrors the child's exit code.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const audioDir = path.join(__dirname, '..', '..', 'audio')
const isWin = process.platform === 'win32'

const venvPython = isWin
  ? path.join(audioDir, '.venv', 'Scripts', 'python.exe')
  : path.join(audioDir, '.venv', 'bin', 'python')

/**
 * @param {{ script: string, tag: string, args?: string[], usage?: string }} opts
 *   script: file under audio/ to run; tag: log prefix; usage: printed (exit 1)
 *   when the script needs arguments and none were given.
 */
export function runAudioScript({ script, tag, args = [], usage }) {
  const hasVenv = existsSync(venvPython)
  const python = hasVenv ? venvPython : isWin ? 'python' : 'python3'

  if (!hasVenv) {
    console.warn(`[${tag}] no .venv found at audio/.venv — using system Python`)
    console.warn(`[${tag}] if you see ModuleNotFoundError, set up the sidecar once:`)
    if (isWin) {
      console.warn('  cd audio && python -m venv .venv && .venv\\Scripts\\activate && pip install -r requirements.txt')
    } else {
      console.warn('  cd audio && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt')
    }
  }

  if (usage && args.length === 0) {
    console.error(usage)
    process.exit(1)
  }

  const child = spawn(python, [path.join(audioDir, script), ...args], {
    cwd: audioDir,
    stdio: 'inherit',
    env: process.env
  })

  child.on('error', (err) => {
    console.error(`[${tag}] failed to start Python:`, err.message)
    process.exit(1)
  })

  child.on('exit', (code) => process.exit(code ?? 1))
}
