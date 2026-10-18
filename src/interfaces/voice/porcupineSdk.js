// The Picovoice SDK is about 1.1 MB (its WebAssembly is embedded), so it lives behind this one module and is
// only ever reached through `import('./porcupineSdk.js')` in porcupineWake.js. Never import it statically:
// tests/importGraph.test.js fails if the first page load can reach it.
export { PorcupineWorker } from '@picovoice/porcupine-web'
export { WebVoiceProcessor } from '@picovoice/web-voice-processor'
