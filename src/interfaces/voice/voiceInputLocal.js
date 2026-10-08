import { createPorcupineWake } from './porcupineWake.js'
import { createVoiceInputWebSpeech } from './voiceInputWebSpeech.js'
import { getMediaDevices, pickMimeType, speechAudioConstraints, stopTracks } from './micUtils.js'
import { matchWakePhrase, normalizeText } from './wakePhrase.js'
import { parseJsonBody } from '../../utils/json.js'

function createUnsupportedError() {
  return new Error('Local voice input is not supported in this browser')
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
  wakePhrases = ['numz', 'hello numz', 'hi numz'],
  vadSilenceMs = 1800,
  vadEnergyThreshold = 0.02,
  vadMinSpeechMs = 250,
  minRecordingMs = 2000,
  vadSpeechRatio = 2.2,
  vadSpeechMinDelta = 0.012,
  vadSilenceRatio = 0.42,
  vadCooldownMs = 1200,
  vadBargeInMinMs = 600,
  vadBargeInThreshold = 0.04,
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

  const usePorcupineWake = porcupine.isConfigured() && Boolean(String(keywordPublicPath ?? '').trim())
  const normalizedWakePhrases = (Array.isArray(wakePhrases) ? wakePhrases : [keywordLabel])
    .map(normalizeText)
    .filter(Boolean)

  const webSpeechWake = createVoiceInputWebSpeech({
    lang,
    interimResults: true,
    continuous: true
  })

  let lastWebWakeAt = 0

  function handleWebSpeechWakeTranscript(text) {
    if (!wakeArmed || captureActive) return

    const now = Date.now()
    if (now - lastWebWakeAt < wakeDebounceMs) return

    const command = matchWakePhrase(text, normalizedWakePhrases)
    if (command === null) return

    lastWebWakeAt = now
    webSpeechWake.stop()
    onWakeDetected({ keyword: keywordLabel, transcript: text })

    if (command) {
      onFinal(command)
      return
    }

    startUtteranceCapture({ fromWake: true }).catch((err) => onError(err))
  }

  webSpeechWake.setOnFinal(handleWebSpeechWakeTranscript)
  webSpeechWake.setOnPartial((text) => {
    if (!wakeArmed || captureActive) return
    const command = matchWakePhrase(text, normalizedWakePhrases)
    if (command === null) return
    handleWebSpeechWakeTranscript(text)
  })

  let stream = null
  let recorder = null
  let chunks = []
  let captureActive = false
  let captureStartedAt = 0
  let wakeArmed = false
  let utteranceTimer = null
  let holdToTalkActive = false

  // Continuous (hands-free) conversation state — energy VAD via Web Audio API.
  let continuousActive = false
  let detectionEnabled = false
  let speakingPhase = false
  let onBargeIn = () => {}
  let audioCtx = null
  let analyserNode = null
  let sourceNode = null
  let vadTimer = null
  let vadBuffer = null
  let speechStartAt = 0
  let silenceStartAt = 0
  let bargeStartAt = 0
  let noiseFloorRms = vadEnergyThreshold * 0.5
  let capturePeakRms = 0
  let cooldownUntil = 0
  let cooldownTimer = null

  function now() {
    return performance.now?.() ?? Date.now()
  }

  function readRms() {
    if (!analyserNode || !vadBuffer) return 0
    analyserNode.getByteTimeDomainData(vadBuffer)
    let sumSq = 0
    for (let i = 0; i < vadBuffer.length; i++) {
      const v = (vadBuffer[i] - 128) / 128
      sumSq += v * v
    }
    return Math.sqrt(sumSq / vadBuffer.length)
  }

  function updateNoiseFloor(rms) {
    const rate = 0.06
    if (rms < noiseFloorRms * 1.8) {
      noiseFloorRms = noiseFloorRms * (1 - rate) + rms * rate
    }
    noiseFloorRms = Math.max(vadEnergyThreshold * 0.35, Math.min(noiseFloorRms, 0.12))
  }

  function speechStartThreshold() {
    return Math.max(
      vadEnergyThreshold,
      noiseFloorRms + vadSpeechMinDelta,
      noiseFloorRms * vadSpeechRatio
    )
  }

  function isSpeechStart(rms) {
    return rms >= speechStartThreshold()
  }

  function isCaptureSilent(rms) {
    const relative = capturePeakRms > 0 ? capturePeakRms * vadSilenceRatio : 0
    const quietCeiling = Math.max(noiseFloorRms * 1.35, relative, vadEnergyThreshold * 0.55)
    return rms < quietCeiling
  }

  function scheduleDetectionCooldown() {
    detectionEnabled = false
    cooldownUntil = now() + vadCooldownMs
    if (cooldownTimer) clearTimeout(cooldownTimer)
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null
      if (!continuousActive || captureActive || speakingPhase) return
      if (now() < cooldownUntil) return
      detectionEnabled = true
      speechStartAt = 0
      silenceStartAt = 0
    }, vadCooldownMs)
  }

  function vadTick() {
    if (!continuousActive) return
    const rms = readRms()
    const t = now()

    if (speakingPhase) {
      // Barge-in: require clearly louder than ambient noise (not random clicks).
      const bargeLoud = rms >= Math.max(vadBargeInThreshold, speechStartThreshold() * 1.15)
      if (bargeLoud) {
        if (!bargeStartAt) bargeStartAt = t
        if (t - bargeStartAt >= vadBargeInMinMs) {
          bargeStartAt = 0
          onBargeIn()
        }
      } else {
        bargeStartAt = 0
      }
      return
    }
    bargeStartAt = 0

    if (captureActive) {
      if (!isCaptureSilent(rms)) {
        capturePeakRms = Math.max(capturePeakRms, rms)
        silenceStartAt = 0
      } else {
        if (!silenceStartAt) silenceStartAt = t
        const silenceElapsed = t - silenceStartAt
        const captureElapsed = captureStartedAt ? t - captureStartedAt : 0
        if (silenceElapsed >= vadSilenceMs && captureElapsed >= minRecordingMs) {
          silenceStartAt = 0
          scheduleDetectionCooldown()
          stopRecorderOnly()
        }
      }
      return
    }

    if (!detectionEnabled || t < cooldownUntil) {
      speechStartAt = 0
      if (!captureActive && !speakingPhase) updateNoiseFloor(rms)
      return
    }

    updateNoiseFloor(rms)

    if (isSpeechStart(rms)) {
      if (!speechStartAt) {
        // Start the MediaRecorder on the FIRST above-threshold sample, not
        // after vadMinSpeechMs of confirmed speech — the recorder only
        // captures audio from the moment it's started, so waiting here
        // permanently loses the beginning of every utterance (the exact
        // sound that triggered detection). vadMinSpeechMs no longer gates
        // starting; minRecordingMs (already in place) absorbs any brief
        // false triggers by requiring the capture to run a minimum length
        // before silence can end it, same as it already does today.
        speechStartAt = t
        silenceStartAt = 0
        capturePeakRms = rms
        startUtteranceCapture({ continuous: true }).catch((err) => onError(err))
      }
    } else {
      speechStartAt = 0
    }
  }

  async function startContinuous() {
    // Idempotent: if already running, just (re)enable speech detection.
    if (continuousActive) {
      speechStartAt = 0
      silenceStartAt = 0
      detectionEnabled = now() >= cooldownUntil
      emitPhase('listening')
      return true
    }

    await ensureStream()
    const AC = globalThis.window?.AudioContext ?? globalThis.window?.webkitAudioContext
    if (!AC) throw createUnsupportedError()

    audioCtx = new AC()
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume()
      } catch {
        /* handled by the state check below */
      }
    }
    if (audioCtx.state !== 'running') {
      // Mobile browsers routinely refuse to run an AudioContext started
      // without a direct user gesture (e.g. on page load via
      // autoStartOnLoad) — without this check the VAD loop below would
      // silently analyze a dead/suspended context forever: no speech ever
      // detected, nothing ever sent, no visible error.
      try {
        await audioCtx.close()
      } catch {
        /* ignore */
      }
      audioCtx = null
      stopTracks(stream)
      stream = null
      const err = new Error('Audio context is suspended — a user gesture is required to enable the microphone')
      err.code = 'audio-context-suspended'
      throw err
    }
    sourceNode = audioCtx.createMediaStreamSource(stream)
    analyserNode = audioCtx.createAnalyser()
    analyserNode.fftSize = 1024
    analyserNode.smoothingTimeConstant = 0.4
    vadBuffer = new Uint8Array(analyserNode.fftSize)
    sourceNode.connect(analyserNode)

    continuousActive = true
    detectionEnabled = true
    speechStartAt = 0
    silenceStartAt = 0
    bargeStartAt = 0
    emitPhase('listening')
    vadTimer = setInterval(vadTick, 50)
    return true
  }

  async function stopContinuous() {
    continuousActive = false
    detectionEnabled = false
    speakingPhase = false
    cooldownUntil = 0
    if (cooldownTimer) {
      clearTimeout(cooldownTimer)
      cooldownTimer = null
    }
    if (vadTimer) {
      clearInterval(vadTimer)
      vadTimer = null
    }
    stopRecorderOnly()
    try {
      sourceNode?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      analyserNode?.disconnect()
    } catch {
      /* ignore */
    }
    if (audioCtx) {
      try {
        await audioCtx.close()
      } catch {
        /* ignore */
      }
      audioCtx = null
    }
    sourceNode = null
    analyserNode = null
    vadBuffer = null
    stopTracks(stream)
    stream = null
    emitPhase('idle')
  }

  function emitPhase(phase) {
    onPhase(phase)
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
    const audio = speechAudioConstraints({ deviceId })
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

    const data = await parseJsonBody(res)
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
    captureStartedAt = 0
    try {
      if (recorder?.state === 'recording') recorder.stop()
    } catch {
      /* ignore */
    }
  }

  async function startUtteranceCapture({ fromWake = false, continuous = false } = {}) {
    void continuous
    if (captureActive) {
      onRejected({ reason: 'capture-active' })
      return
    }
    captureActive = true
    capturePeakRms = 0
    chunks = []
    onPartial('')
    emitPhase('recording')
    detectionEnabled = false

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
        if (continuousActive) scheduleDetectionCooldown()

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
          capturePeakRms = 0
          if (!wasHold && !wakeArmed && !continuousActive) {
            stopTracks(stream)
            stream = null
          }
        }
      }

      captureStartedAt = now()
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
    if (!isSupported()) return false
    if (usePorcupineWake) return porcupine.isSupported()
    return webSpeechWake.isSupported()
  }

  return {
    isSupported,
    isWakeSupported,

    isWakeConfigured() {
      return usePorcupineWake ? porcupine.isConfigured() : webSpeechWake.isSupported()
    },

    getWakeMode() {
      return usePorcupineWake ? 'porcupine' : 'webspeech'
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

    setOnBargeIn(fn) {
      onBargeIn = typeof fn === 'function' ? fn : () => {}
    },

    setDetectionEnabled(enabled) {
      detectionEnabled = Boolean(enabled)
      if (!enabled) {
        speechStartAt = 0
        silenceStartAt = 0
      }
    },

    setSpeakingPhase(active) {
      speakingPhase = Boolean(active)
      bargeStartAt = 0
      if (active) {
        detectionEnabled = false
        speechStartAt = 0
      }
    },

    startContinuous,
    stopContinuous,

    isContinuous() {
      return continuousActive
    },

    async armWake() {
      wakeArmed = true
      await ensureStream()
      if (usePorcupineWake) return porcupine.arm()
      webSpeechWake.start()
      return true
    },

    async disarmWake() {
      wakeArmed = false
      if (usePorcupineWake) await porcupine.disarm()
      else webSpeechWake.stop()
      stopRecorderOnly()
      stopTracks(stream)
      stream = null
      emitPhase('idle')
    },

    async pauseWake() {
      if (usePorcupineWake) await porcupine.pause()
      else webSpeechWake.stop()
    },

    async resumeWake() {
      if (!wakeArmed) return
      if (usePorcupineWake) await porcupine.resume()
      else webSpeechWake.start()
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
      if (continuousActive) await stopContinuous()
      await this.disarmWake()
      await porcupine.release()
    }
  }
}
