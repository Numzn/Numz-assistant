/**
 * Browser microphone / MediaRecorder helpers shared by the voice input modules.
 */

export function getMediaDevices() {
  return globalThis?.navigator?.mediaDevices ?? null
}

export function stopTracks(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop()
}

/** First container/codec this browser's MediaRecorder supports ('' lets it choose). */
export function pickMimeType() {
  const w = globalThis?.window
  const MR = w?.MediaRecorder
  if (!MR?.isTypeSupported) return ''
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ]
  return candidates.find((t) => MR.isTypeSupported(t)) ?? ''
}

/**
 * getUserMedia `audio` constraints for speech capture (the utterance recorder
 * and the live streaming client). `extra` adds constraints such as channelCount.
 */
export function speechAudioConstraints({ deviceId = '', ...extra } = {}) {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    ...extra,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {})
  }
}
