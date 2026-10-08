/**
 * Cross-platform launcher for the Python audio sidecar.
 */
import { runAudioScript } from './lib/audioPython.js'

runAudioScript({ script: 'server.py', tag: 'audio' })
