import { isLiveSpeechSupported } from '../voice/liveSpeechClient.js'

/**
 * Whether this page can record a meeting, checked BEFORE a meeting is created on the server.
 * The usual reason it cannot is not the browser but the address: browsers only hand out the
 * microphone on a secure page (https, or localhost), so a plain http page on a LAN or tailnet address
 * gets no microphone at all.
 */
export function checkLiveSpeechSupport(scope = globalThis) {
  if (isLiveSpeechSupported()) return { ok: true }
  if (scope.isSecureContext === false) {
    return {
      ok: false,
      reason:
        'The browser blocks the microphone on this page because it is not a secure connection. ' +
        'Open the app over https, or through localhost.'
    }
  }
  return { ok: false, reason: 'This browser cannot capture live audio (it needs microphone and AudioWorklet support).' }
}
