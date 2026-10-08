/**
 * Launcher for the live transport outbox tool (audio/outbox_cli.py), using the sidecar's venv and the
 * same .env files as the services. The meeting ticket is read from MEETING_TICKET, never from argv.
 */
import '../server/loadEnv.js'
import { runAudioScript } from './lib/audioPython.js'

runAudioScript({
  script: 'outbox_cli.py',
  tag: 'outbox',
  args: process.argv.slice(2),
  usage: 'Usage: npm run outbox:status | MEETING_TICKET=<ticket> npm run outbox:replay -- <meeting-id>'
})
