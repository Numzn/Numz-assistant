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
// Readings of the assistant's own voice needed before an interruption can be told from it (200 ms at the loop's
// normal 50 ms tick).
const MIN_ECHO_SAMPLES = 4

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
  // Self-echo protection. The assistant's own voice leaves the speakers and reaches this microphone: browser echo
  // cancellation is not guaranteed for speech synthesis, and a fixed loudness threshold cannot tell the two voices
  // apart (it was 0.04, and a laptop's speakers are louder than that in its own microphone).
  //  - After the assistant stops, the microphone is ignored this long: its last words are still in the room.
  vadPostSpeechSettleMs = 700,
  //  - After it was cut off by an interruption the pause is short: the person is already talking.
  vadBargeInSettleMs = 150,
  //  - An interruption must be this many times louder than the assistant's own voice measured in this microphone.
  vadBargeInEchoRatio = 1.8,
  //  - The first part of the playback is spent measuring that loudness; nothing counts as an interruption then.
  vadBargeInGuardMs = 500,
  // Let the browser level the microphone. Off, a quiet voice (a laptop's array microphone) can sit below the
  // fixed detection floor and never start a capture; see settings.voice.autoGainControl.
  autoGainControl = false,
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
  // The turn is in progress (the orchestrator turned detection off): stay deaf until listening is restarted.
  let detectionHeld = false
  // Self-echo: when this playback began, when it became audible, how loud it is in this microphone, and until
  // when the sound it left in the room is still being waited out.
  let speakingStartedAt = 0
  let playbackAudibleAt = 0
  let echoLevel = 0
  let echoSamples = 0 // how many microphone readings the loudness above is based on
  let settleUntil = 0
  let bargeInReported = false // an interruption is reported once per playback, however long the person talks
  // The capture in progress (or the last one): who it is, when it began, and whether it must be thrown away.
  let captureSeq = 0
  let currentCapture = null

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

  function scheduleDetectionCooldown(ms = vadCooldownMs) {
    detectionEnabled = false
    cooldownUntil = Math.max(cooldownUntil, now() + ms)
    armCooldownTimer()
  }

  function armCooldownTimer() {
    if (cooldownTimer) clearTimeout(cooldownTimer)
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null
      // Not while a capture is running, the assistant is speaking, or a turn holds detection off: listening
      // comes back through startContinuous() at the end of the turn, not because a timer ran out mid-turn.
      if (!continuousActive || captureActive || speakingPhase || detectionHeld) return
      if (now() < cooldownUntil) {
        armCooldownTimer() // fired a little early: wait out the rest
        return
      }
      detectionEnabled = true
      speechStartAt = 0
      silenceStartAt = 0
    }, Math.max(0, cooldownUntil - now()))
  }

  /** The assistant's voice is over (or was cut): wait out what is still in the room before listening. */
  function settleAfterPlayback(ms) {
    settleUntil = now() + ms
    speechStartAt = 0
    silenceStartAt = 0
    bargeStartAt = 0
    scheduleDetectionCooldown(ms)
  }

  /** A capture that began before or during playback holds the assistant's own voice: throw it away. */
  function discardActiveCapture() {
    if (currentCapture) currentCapture.discarded = true
    stopRecorderOnly()
  }

  function vadTick() {
    if (!continuousActive) return
    const rms = readRms()
    const t = now()

    if (speakingPhase) {
      // Whatever is loud now is, most likely, the assistant itself. Measure how loud it is in this microphone
      // while it starts (the sound is only counted from when it is audible), then ask an interruption to be
      // clearly louder than that as well as louder than the fixed floor.
      const audibleSince = Math.max(speakingStartedAt, playbackAudibleAt)
      // Measured from readings, not from the clock alone. A hidden or covered browser window ticks this loop about
      // once a second, so a 500 ms window can hold no reading at all, and with nothing measured the fixed floor
      // alone applied again: its own voice was heard as an interruption.
      if (t - audibleSince < vadBargeInGuardMs || echoSamples < MIN_ECHO_SAMPLES) {
        echoLevel = Math.max(echoLevel, rms)
        echoSamples += 1
        bargeStartAt = 0
        return
      }
      const ceiling = Math.max(
        vadBargeInThreshold,
        speechStartThreshold() * 1.15,
        echoLevel * vadBargeInEchoRatio
      )
      if (bargeInReported) return
      if (rms >= ceiling) {
        if (!bargeStartAt) bargeStartAt = t
        if (t - bargeStartAt >= vadBargeInMinMs) {
          bargeStartAt = 0
          bargeInReported = true
          onBargeIn()
        }
      } else {
        bargeStartAt = 0
        // Not an interruption: follow slow changes in the assistant's own loudness (upwards only, and slowly,
        // so that a person speaking for a moment does not raise the bar against themselves).
        if (rms > echoLevel) echoLevel += 0.02 * (rms - echoLevel)
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

    if (!detectionEnabled || detectionHeld || t < cooldownUntil) {
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
      bargeStartAt = 0
      detectionHeld = false
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
    detectionHeld = false
    settleUntil = 0
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
    detectionHeld = false
    speakingPhase = false
    settleUntil = 0
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
    const audio = speechAudioConstraints({ deviceId, autoGainControl: Boolean(autoGainControl) })
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
    const capture = { id: ++captureSeq, startedAt: now(), discarded: false }
    currentCapture = capture
    capturePeakRms = 0
    chunks = []
    onPartial('')
    emitPhase('recording')
    detectionEnabled = false

    const limitMs = fromWake ? maxUtteranceMsWake : maxUtteranceMs

    try {
      await ensureStream()
      // Thrown away (the assistant began to speak) or replaced while the microphone was being opened.
      if (capture.discarded || currentCapture !== capture) {
        if (currentCapture === capture) captureActive = false
        if (capture.discarded) {
          emitPhase('idle')
          onRejected({ reason: 'overlapped-playback' })
        }
        return
      }
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

        if (continuousActive && !capture.discarded) scheduleDetectionCooldown()

        try {
          if (capture.discarded) {
            // It holds the assistant's own voice. Not a transcript, and not a "no speech" error either: that
            // would restart listening in the middle of the reply. The settle after playback decides when to listen.
            emitPhase('idle')
            onRejected({ reason: 'overlapped-playback' })
            return
          }
          if (!chunks.length) {
            emitPhase('idle')
            onError({ error: 'no-speech' })
            return
          }
          const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
          const text = await transcribe(blob)
          if (text) onFinal(text, { captureId: capture.id, startedAt: capture.startedAt })
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

    /**
     * false: a turn is in progress, do not start a capture until listening is restarted with startContinuous().
     * (A cooldown timer used to re-open detection a second after an utterance ended, in the middle of the turn,
     * and a capture started then went on to record the assistant's own reply.)
     */
    setDetectionEnabled(enabled) {
      detectionEnabled = Boolean(enabled)
      detectionHeld = !enabled
      if (!enabled) {
        speechStartAt = 0
        silenceStartAt = 0
      }
    },

    /**
     * The assistant started (true) or stopped (false) speaking. Stopping because it was cut off by an interruption
     * is reported with { interrupted: true }: the person is already talking, so the wait is short.
     */
    setSpeakingPhase(active, { interrupted = false } = {}) {
      const next = Boolean(active)
      const was = speakingPhase
      speakingPhase = next
      bargeStartAt = 0
      if (next) {
        detectionEnabled = false
        speechStartAt = 0
        silenceStartAt = 0
        if (!was) {
          speakingStartedAt = now()
          playbackAudibleAt = 0
          echoLevel = 0
          echoSamples = 0
          bargeInReported = false
        }
        // Anything being recorded now will contain the assistant.
        if (captureActive) discardActiveCapture()
        return
      }
      if (was) settleAfterPlayback(interrupted ? vadBargeInSettleMs : vadPostSpeechSettleMs)
    },

    /** The output reports that the assistant's voice is audible now: the loudness measurement starts here. */
    notePlaybackStarted() {
      if (speakingPhase) playbackAudibleAt = now()
    },

    startContinuous,
    stopContinuous,

    isContinuous() {
      return continuousActive
    },

    /**
     * The microphone level right now, 0..1, read from the analyser the hands-free loop already runs.
     * 0 when it is not listening, while the assistant is speaking and while its last words are still in the room:
     * the assistant's own voice in the microphone must never be mistaken for the user's.
     */
    getInputLevel() {
      if (!continuousActive || !analyserNode || speakingPhase || now() < settleUntil) return 0
      return Math.min(1, readRms() / 0.12)
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
