import { createPorcupineWake } from './porcupineWake.js'

function createUnsupportedError() {
  return new Error('Local voice input is not supported in this browser')
}

function getMediaDevices() {
  return globalThis?.navigator?.mediaDevices ?? null
}

function pickMimeType() {
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

async function parseJson(res) {
  const text = await res.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * Local audio input: Porcupine wake + MediaRecorder utterance + local STT POST.
 */
export function createVoiceInputLocal({
  endpoint = '/api/v1/assistant/stt',
  lang = 'en-US',
  prompt = '',
  sttBackend = 'local',
  maxUtteranceMs = 8000,
  maxUtteranceMsWake = 6000,
  wakeDebounceMs = 1500,
  accessKey = '',
  keywordPublicPath = '',
  modelPublicPath = '/porcupine/porcupine_params_en.pv',
  keywordLabel = 'numz',
  getDeviceId = () => ''
} = {}) {
  let onPartial = () => {}
  let onFinal = () => {}
  let onError = () => {}
  let onWakeDetected = () => {}
  let onPhase = () => {}
  let onRejected = () => {}

  const porcupine = createPorcupineWake({
    accessKey,
    keywordPublicPath,
    modelPublicPath,
    keywordLabel,
    wakeDebounceMs,
    onWake: () => {
      onWakeDetected({ keyword: keywordLabel })
      startUtteranceCapture({ fromWake: true }).catch((err) => onError(err))
    }
  })

  let stream = null
  let recorder = null
  let chunks = []
  let captureActive = false
  let wakeArmed = false
  let utteranceTimer = null
  let holdToTalkActive = false

  function emitPhase(phase) {
    onPhase(phase)
  }

  function stopTracks(s) {
    for (const t of s?.getTracks?.() ?? []) t.stop()
  }

  function clearUtteranceTimer() {
    if (utteranceTimer) {
      clearTimeout(utteranceTimer)
      utteranceTimer = null
    }
  }

  async function ensureStream() {
    const mediaDevices = getMediaDevices()
    if (!mediaDevices?.getUserMedia) throw createUnsupportedError()

    if (stream?.active) return stream

    const deviceId = typeof getDeviceId === 'function' ? getDeviceId() : ''
    const audio = deviceId ? { deviceId: { exact: deviceId } } : true
    try {
      stream = await mediaDevices.getUserMedia({ audio, video: false })
    } catch (err) {
      if (err?.name === 'NotAllowedError') {
        const denied = new Error('Microphone permission denied')
        denied.name = 'NotAllowedError'
        denied.error = 'not-allowed'
        throw denied
      }
      throw err
    }
    return stream
  }

  async function transcribe(blob) {
    emitPhase('transcribing')
    const buf = await blob.arrayBuffer()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-audio-mime': blob.type || 'audio/webm',
        'x-stt-lang': lang,
        'x-stt-prompt': prompt,
        'x-stt-backend': sttBackend
      },
      body: buf
    })

    const data = await parseJson(res)
    if (!res.ok) {
      const msg = data.error ?? `STT failed: ${res.status}`
      if (res.status === 503 || String(msg).toLowerCase().includes('audio service')) {
        const err = new Error(msg)
        err.error = 'audio-service-offline'
        err.code = 'audio-service-offline'
        throw err
      }
      throw new Error(msg)
    }
    if (data.error === 'no-speech') {
      const err = new Error('no-speech')
      err.error = 'no-speech'
      throw err
    }
    emitPhase('idle')
    return String(data.text ?? '').trim()
  }

  function stopRecorderOnly() {
    clearUtteranceTimer()
    captureActive = false
    try {
      if (recorder?.state === 'recording') recorder.stop()
    } catch {
      /* ignore */
    }
  }

  async function startUtteranceCapture({ fromWake = false } = {}) {
    if (captureActive) {
      onRejected({ reason: 'capture-active' })
      return
    }
    captureActive = true
    chunks = []
    onPartial('')
    emitPhase('recording')

    const limitMs = fromWake ? maxUtteranceMsWake : maxUtteranceMs

    try {
      await ensureStream()
      const mimeType = pickMimeType()
      recorder = new globalThis.window.MediaRecorder(stream, mimeType ? { mimeType } : undefined)

      recorder.ondataavailable = (ev) => {
        if (!ev?.data || ev.data.size === 0) return
        chunks.push(ev.data)
      }

      recorder.onerror = (ev) => {
        captureActive = false
        emitPhase('idle')
        onError(ev?.error ?? ev)
      }

      recorder.onstop = async () => {
        clearUtteranceTimer()
        captureActive = false
        const wasHold = holdToTalkActive
        holdToTalkActive = false

        try {
          if (!chunks.length) {
            emitPhase('idle')
            onError({ error: 'no-speech' })
            return
          }
          const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
          const text = await transcribe(blob)
          if (text) onFinal(text)
          else onError({ error: 'no-speech' })
        } catch (err) {
          emitPhase('idle')
          if (err?.code === 'audio-service-offline') err.error = 'audio-service-offline'
          onError(err)
        } finally {
          chunks = []
          recorder = null
          if (!wasHold && !wakeArmed) {
            stopTracks(stream)
            stream = null
          }
        }
      }

      recorder.start()
      utteranceTimer = setTimeout(() => {
        if (recorder?.state === 'recording') recorder.stop()
      }, limitMs)
    } catch (err) {
      captureActive = false
      emitPhase('idle')
      onError(err)
    }
  }

  function isSupported() {
    const w = globalThis?.window
    return Boolean(getMediaDevices()?.getUserMedia) && typeof w?.MediaRecorder === 'function'
  }

  function isWakeSupported() {
    return isSupported() && porcupine.isSupported()
  }

  return {
    isSupported,
    isWakeSupported,

    isWakeConfigured() {
      return porcupine.isConfigured()
    },

    setOnPartial(fn) {
      onPartial = typeof fn === 'function' ? fn : () => {}
    },

    setOnFinal(fn) {
      onFinal = typeof fn === 'function' ? fn : () => {}
    },

    setOnError(fn) {
      onError = typeof fn === 'function' ? fn : () => {}
    },

    setOnWakeDetected(fn) {
      onWakeDetected = typeof fn === 'function' ? fn : () => {}
    },

    setOnPhase(fn) {
      onPhase = typeof fn === 'function' ? fn : () => {}
    },

    setOnRejected(fn) {
      onRejected = typeof fn === 'function' ? fn : () => {}
    },

    async armWake() {
      wakeArmed = true
      await ensureStream()
      return porcupine.arm()
    },

    async disarmWake() {
      wakeArmed = false
      await porcupine.disarm()
      stopRecorderOnly()
      stopTracks(stream)
      stream = null
      emitPhase('idle')
    },

    async pauseWake() {
      await porcupine.pause()
    },

    async resumeWake() {
      if (wakeArmed) await porcupine.resume()
    },

    async start() {
      if (captureActive) {
        onRejected({ reason: 'capture-active' })
        return
      }
      holdToTalkActive = true
      await startUtteranceCapture({ fromWake: false })
    },

    stop() {
      if (!captureActive && !holdToTalkActive) return
      holdToTalkActive = false
      stopRecorderOnly()
    },

    async release() {
      await this.disarmWake()
      await porcupine.release()
    }
  }
}
