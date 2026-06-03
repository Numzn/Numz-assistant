/**
 * Cross-platform launcher for the Python audio sidecar.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const audioDir = path.join(__dirname, '..', 'audio')
const isWin = process.platform === 'win32'

const venvPython = isWin
  ? path.join(audioDir, '.venv', 'Scripts', 'python.exe')
  : path.join(audioDir, '.venv', 'bin', 'python')

const hasVenv = existsSync(venvPython)
const python = hasVenv ? venvPython : isWin ? 'python' : 'python3'
const serverScript = path.join(audioDir, 'server.py')

if (!hasVenv) {
  console.warn('[audio] no .venv found at audio/.venv — using system Python')
  console.warn('[audio] if you see ModuleNotFoundError, set up the sidecar once:')
  if (isWin) {
    console.warn('  cd audio && python -m venv .venv && .venv\\Scripts\\activate && pip install -r requirements.txt')
  } else {
    console.warn('  cd audio && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt')
  }
}

const child = spawn(python, [serverScript], {
  cwd: audioDir,
  stdio: 'inherit',
  env: process.env
})

child.on('error', (err) => {
  console.error('[audio] failed to start Python:', err.message)
  process.exit(1)
})

child.on('exit', (code) => process.exit(code ?? 1))
