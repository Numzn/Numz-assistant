import { STATES } from '../../assistant/stateMachine.js'
import { describeMicError } from './voiceDeviceManager.js'
import { createVoiceDebug } from './voiceDebug.js'

/**
 * Orchestrates STT + assistant request + TTS, mapped onto the state machine.
 * Keeps voice in `src/interfaces/` and leaves rendering layers untouched.
 */
export function createVoiceOrchestrator({
  stateMachine,
  assistantController,
  voiceInput,
  voiceOutput,
  deviceManager,
  ui,
  config
}) {
  let pressed = false
  let busy = false
  let lastTranscript = ''
  let wakeMode = false
  let awaitingWakeCommand = false

  const audioMode = String(config?.audioMode ?? 'legacy').toLowerCase()
  const isLocalMode = audioMode === 'local'
  const voiceDebug = createVoiceDebug({ enabled: Boolean(config?.debugTiming) })

  function isLocalVoiceInput() {
    return isLocalMode && typeof voiceInput?.armWake === 'function'
  }

  function normalizeText(text) {
    return String(text ?? '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function getWakePhrases() {
    const phrases = Array.isArray(config?.wakePhrases) ? config.wakePhrases : ['numz']
    return phrases.map(normalizeText).filter(Boolean)
  }

  function stripWakeKeyword(text) {
    let t = normalizeText(text)
    const keyword = normalizeText(config?.porcupineKeyword ?? 'numz')
    if (keyword && t.startsWith(keyword)) {
      t = t.slice(keyword.length).trim()
    }
    for (const phrase of getWakePhrases()) {
      if (t.startsWith(phrase)) {
        t = t.slice(phrase.length).trim()
        break
      }
    }
    return t
  }

  function extractWakeCommand(text) {
    const normalized = normalizeText(text)
    if (!normalized) return null

    for (const phrase of getWakePhrases()) {
      const index = normalized.indexOf(phrase)
      if (index === -1) continue
      const before = normalized.slice(0, index).trim()
      if (before) continue
      return normalized.slice(index + phrase.length).trim()
    }

    return null
  }

  function setUiStatus(text) {
    if (!ui?.statusEl) return
    ui.statusEl.textContent = text ?? ''
  }

  function setUiTranscript(text) {
    if (!ui?.transcriptEl) return
    ui.transcriptEl.textContent = text ?? ''
  }

  function setUiSupported(supported) {
    if (!ui?.buttonEl) return
    ui.buttonEl.disabled = !supported
    if (ui?.wakeButtonEl) ui.wakeButtonEl.disabled = !supported
  }

  function setBusyUi(isBusy) {
    if (ui?.buttonEl) ui.buttonEl.disabled = isBusy || !voiceInput.isSupported()
    if (ui?.wakeButtonEl) {
      ui.wakeButtonEl.disabled = isBusy || !voiceInput.isSupported()
    }
  }

  function setMicHint(text) {
    if (!ui?.micHintEl) return
    ui.micHintEl.textContent = text ?? ''
  }

  function selectedMicDeviceId() {
    return ui?.micSelectEl?.value ?? deviceManager?.getPreferredDeviceId?.() ?? ''
  }

  async function safeSetIdle() {
    try {
      await assistantController.setIdle()
    } catch {
      // ignore
    }
  }

  async function speakReply(replyText) {
    if (!replyText) return
    await assistantController.setSpeaking()
    if (wakeMode) voiceInput.stop()
    if (isLocalVoiceInput() && typeof voiceInput.pauseWake === 'function') {
      await voiceInput.pauseWake()
    }
    await voiceOutput.speak(replyText, {
      voiceName: config?.ttsVoiceName,
      lang: config?.lang,
      rate: config?.ttsRate,
      pitch: config?.ttsPitch,
      volume: config?.ttsVolume
    })
    await safeSetIdle()
    if (wakeMode) await startWakeListening()
  }

  async function handleAssistantPrompt(text) {
    const cleaned = typeof text === 'string' ? text.trim() : ''
    if (!cleaned) return
    if (busy) {
      setUiStatus('Busy — wait…')
      return
    }

    busy = true
    setBusyUi(true)
    lastTranscript = cleaned
    setUiTranscript(cleaned)
    voiceDebug.mark('llm_start')
    voiceDebug.setPhase('thinking')
    setUiStatus('Thinking…')

    const reply = await assistantController.requestReply(cleaned)
    voiceDebug.measure('llm', 'llm_start')
    if (!reply) {
      busy = false
      setBusyUi(false)
      voiceDebug.setPhase('idle')
      return
    }

    try {
      await speakReply(reply)
    } catch (err) {
      console.error('[voice] speak failed', err)
      await assistantController.setError()
      await safeSetIdle()
    } finally {
      busy = false
      setBusyUi(false)
      voiceDebug.setPhase('idle')
    }
  }

  async function handleFinalTranscript(text) {
    const cleaned = typeof text === 'string' ? text.trim() : ''
    if (!cleaned) return

    if (!wakeMode) {
      await handleAssistantPrompt(cleaned)
      return
    }

    if (isLocalVoiceInput()) {
      const command = stripWakeKeyword(cleaned) || cleaned
      setUiTranscript(command)
      await handleAssistantPrompt(command)
      return
    }

    setUiTranscript(cleaned)

    if (awaitingWakeCommand) {
      awaitingWakeCommand = false
      await handleAssistantPrompt(cleaned)
      return
    }

    const command = extractWakeCommand(cleaned)
    if (command === null) {
      setUiStatus('Wake mode armed')
      return
    }

    if (!command) {
      awaitingWakeCommand = true
      setUiStatus('Yes?')
      return
    }

    await handleAssistantPrompt(command)
  }

  async function startWakeListening() {
    if (!wakeMode || busy) return
    pressed = false
    lastTranscript = ''
    setUiStatus(isLocalMode ? 'Wake armed — say NUMZ' : 'Wake mode armed')

    try {
      if (isLocalVoiceInput()) {
        if (typeof voiceInput.isWakeSupported === 'function' && !voiceInput.isWakeSupported()) {
          setUiStatus('Wake needs Picovoice key + keyword files')
          wakeMode = false
          ui?.wakeButtonEl?.setAttribute('aria-pressed', 'false')
          return
        }
        const armed = await voiceInput.armWake()
        if (!armed) {
          setUiStatus('Wake failed — check Picovoice setup')
          wakeMode = false
          ui?.wakeButtonEl?.setAttribute('aria-pressed', 'false')
          return
        }
        await safeSetIdle()
        return
      }

      await assistantController.setListening()
      voiceInput.start()
    } catch (err) {
      console.error('[voice] wake start failed', err)
      setUiStatus('Wake mode failed')
      wakeMode = false
      ui?.wakeButtonEl?.setAttribute('aria-pressed', 'false')
    }
  }

  async function stopWakeListening() {
    wakeMode = false
    awaitingWakeCommand = false
    ui?.wakeButtonEl?.setAttribute('aria-pressed', 'false')
    setUiStatus('')
    try {
      if (isLocalVoiceInput() && typeof voiceInput.disarmWake === 'function') {
        await voiceInput.disarmWake()
      } else {
        voiceInput.stop()
      }
      await safeSetIdle()
    } catch (err) {
      console.error('[voice] wake stop failed', err)
    }
  }

  function bindUi() {
    const btn = ui?.buttonEl
    if (!btn) return () => {}

    const onDown = async (ev) => {
      ev.preventDefault?.()
      if (busy) {
        setUiStatus('Busy — wait…')
        return
      }
      if (wakeMode) await stopWakeListening()
      pressed = true
      lastTranscript = ''
      setUiTranscript('')
      setUiStatus('Listening…')

      try {
        await assistantController.setListening()
        voiceInput.start()
      } catch (err) {
        console.error('[voice] start', err)
        await assistantController.setError()
        await safeSetIdle()
      }
    }

    const onUp = async (ev) => {
      ev.preventDefault?.()
      pressed = false
      setUiStatus('')
      try {
        voiceInput.stop()
        // If user stops without any final transcript, return to idle.
        if (!lastTranscript) await safeSetIdle()
      } catch (err) {
        console.error('[voice] stop', err)
        await assistantController.setError()
        await safeSetIdle()
      }
    }

    btn.addEventListener('pointerdown', onDown)
    btn.addEventListener('pointerup', onUp)
    btn.addEventListener('pointercancel', onUp)
    btn.addEventListener('pointerleave', (ev) => {
      if (!pressed) return
      onUp(ev)
    })

    const onWakeToggle = async (ev) => {
      ev.preventDefault?.()
      if (busy) {
        setUiStatus('Busy — wait…')
        return
      }

      if (wakeMode) {
        await stopWakeListening()
        return
      }

      wakeMode = true
      awaitingWakeCommand = false
      ui?.wakeButtonEl?.setAttribute('aria-pressed', 'true')
      await startWakeListening()
    }

    ui?.wakeButtonEl?.addEventListener('click', onWakeToggle)

    return () => {
      btn.removeEventListener('pointerdown', onDown)
      btn.removeEventListener('pointerup', onUp)
      btn.removeEventListener('pointercancel', onUp)
      ui?.wakeButtonEl?.removeEventListener('click', onWakeToggle)
      // pointerleave listener is anonymous; keep it simple for v1 (page refresh clears).
    }
  }

  function renderMicOptions(devices) {
    const select = ui?.micSelectEl
    if (!select) return

    const preferred = deviceManager?.getPreferredDeviceId?.() ?? ''
    select.textContent = ''

    const defaultOption = document.createElement('option')
    defaultOption.value = ''
    defaultOption.textContent = 'System default'
    select.append(defaultOption)

    for (const device of devices) {
      const option = document.createElement('option')
      option.value = device.deviceId
      option.textContent = device.label
      select.append(option)
    }

    select.value = preferred
  }

  async function refreshMicDevices({ requestPermission = false } = {}) {
    if (!deviceManager || !ui?.micSelectEl) return
    if (!deviceManager.isSupported?.()) {
      ui.micSelectEl.disabled = true
      ui.micRefreshButtonEl.disabled = true
      ui.micTestButtonEl.disabled = true
      setMicHint('Mic testing is unavailable in this browser')
      return
    }

    try {
      ui.micSelectEl.disabled = true
      const devices = await deviceManager.listInputDevices({ requestPermission })
      renderMicOptions(devices)
      setMicHint(
        devices.length === 0
          ? 'No microphone devices found'
          : requestPermission
          ? 'Microphone permission checked'
          : 'Choose a mic to test before speaking'
      )
    } catch (err) {
      console.error('[voice] list microphones failed', err)
      setMicHint(describeMicError(err))
    } finally {
      ui.micSelectEl.disabled = false
    }
  }

  function bindMicSettings() {
    if (!ui?.micSettingsButtonEl || !ui?.micPanelEl) return () => {}

    const onToggle = () => {
      ui.micPanelEl.hidden = !ui.micPanelEl.hidden
      if (!ui.micPanelEl.hidden) {
        refreshMicDevices({ requestPermission: false })
      }
    }

    const onSelect = () => {
      deviceManager?.setPreferredDeviceId?.(selectedMicDeviceId())
      setMicHint('Microphone preference saved')
    }

    const onRefresh = () => {
      refreshMicDevices({ requestPermission: true })
    }

    const onTest = async () => {
      try {
        setMicHint('Testing microphone...')
        await deviceManager?.testDevice?.(selectedMicDeviceId())
        await refreshMicDevices({ requestPermission: false })
        setMicHint('Microphone is available')
      } catch (err) {
        console.error('[voice] test microphone failed', err)
        setMicHint(describeMicError(err))
      }
    }

    ui.micSettingsButtonEl.addEventListener('click', onToggle)
    ui.micSelectEl?.addEventListener('change', onSelect)
    ui.micRefreshButtonEl?.addEventListener('click', onRefresh)
    ui.micTestButtonEl?.addEventListener('click', onTest)

    refreshMicDevices({ requestPermission: false })

    return () => {
      ui.micSettingsButtonEl.removeEventListener('click', onToggle)
      ui.micSelectEl?.removeEventListener('change', onSelect)
      ui.micRefreshButtonEl?.removeEventListener('click', onRefresh)
      ui.micTestButtonEl?.removeEventListener('click', onTest)
    }
  }

  function bindVoiceCallbacks() {
    if (typeof voiceInput.setOnWakeDetected === 'function') {
      voiceInput.setOnWakeDetected(async () => {
        if (busy) {
          setUiStatus('Busy — wait…')
          return
        }
        voiceDebug.mark('wake_detected')
        voiceDebug.setPhase('recording')
        lastTranscript = ''
        setUiTranscript('')
        setUiStatus('Listening…')
        try {
          await assistantController.setListening()
        } catch (err) {
          console.error('[voice] wake listen failed', err)
          await assistantController.setError()
          await safeSetIdle()
        }
      })
    }

    if (typeof voiceInput.setOnPhase === 'function') {
      voiceInput.setOnPhase((phase) => {
        voiceDebug.setPhase(phase)
        if (phase === 'transcribing') {
          voiceDebug.mark('stt_start')
          setUiStatus('Transcribing…')
        } else if (phase === 'recording') {
          setUiStatus('Listening…')
        }
      })
    }

    if (typeof voiceInput.setOnRejected === 'function') {
      voiceInput.setOnRejected(({ reason }) => {
        if (reason === 'capture-active') {
          setUiStatus('Already listening…')
        }
      })
    }

    voiceInput.setOnPartial((text) => {
      // Only show interim while the button is held down.
      if (!pressed) return
      setUiTranscript(text)
    })

    voiceInput.setOnFinal((text) => {
      voiceDebug.measure('stt', 'stt_start')
      voiceDebug.mark('transcript_ready')
      handleFinalTranscript(text)
    })

    voiceInput.setOnError(async (err) => {
      console.error('[voice] stt error', err)
      pressed = false
      try {
        voiceInput.stop()
      } catch {
        /* ignore */
      }
      const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : ''
      const code =
        err && typeof err === 'object' && 'error' in err ? String(err.error) : ''
      if (name === 'NotAllowedError' || code === 'not-allowed' || code === 'service-not-allowed') {
        setUiStatus('Mic blocked — allow microphone in browser settings')
        wakeMode = false
        awaitingWakeCommand = false
        ui?.wakeButtonEl?.setAttribute('aria-pressed', 'false')
        if (isLocalVoiceInput() && typeof voiceInput.disarmWake === 'function') {
          await voiceInput.disarmWake()
        }
        await safeSetIdle()
        return
      }
      if (code === 'no-speech') {
        setUiStatus(
          wakeMode
            ? isLocalMode
              ? 'Wake armed — say NUMZ'
              : 'Wake mode armed'
            : "Didn't catch that"
        )
        await safeSetIdle()
        if (wakeMode) await startWakeListening()
        return
      }

      if (code === 'audio-service-offline') {
        setUiStatus('Audio service offline — run npm run dev:audio')
        wakeMode = false
        awaitingWakeCommand = false
        ui?.wakeButtonEl?.setAttribute('aria-pressed', 'false')
        if (isLocalVoiceInput() && typeof voiceInput.disarmWake === 'function') {
          await voiceInput.disarmWake()
        }
        await safeSetIdle()
        return
      }

      const hint =
        code === 'network'
          ? 'Speech offline — check internet / firewall'
          : code === 'audio-capture'
            ? 'No microphone input'
            : 'Mic error'
      setUiStatus(hint)
      wakeMode = false
      awaitingWakeCommand = false
      ui?.wakeButtonEl?.setAttribute('aria-pressed', 'false')
      await assistantController.setError()
      await safeSetIdle()
    })

    voiceOutput.setOnStart(() => {
      voiceDebug.setPhase('speaking')
      voiceDebug.mark('tts_start')
      setUiStatus('Speaking…')
    })

    voiceOutput.setOnEnd(() => {
      voiceDebug.measure('tts', 'tts_start')
      setUiStatus('')
    })

    voiceOutput.setOnError((err) => {
      console.error('[voice] tts error', err)
    })
  }

  return {
    init() {
      const supported = voiceInput.isSupported() && voiceOutput.isSupported()
      setUiSupported(supported)
      if (!supported) {
        setUiStatus(
          isLocalMode ? 'Local voice unsupported (mic or Picovoice)' : 'Voice unsupported'
        )
        return { destroy: () => {}, voiceDebug }
      }

      if (isLocalMode) {
        const wakeOk =
          typeof voiceInput.isWakeSupported !== 'function' || voiceInput.isWakeSupported()
        setMicHint(
          wakeOk
            ? 'Local audio — hold mic or enable wake (NUMZ)'
            : 'Local STT ready; add Picovoice key for wake'
        )
      }

      bindVoiceCallbacks()
      const destroyUi = bindUi()
      const destroyMicSettings = bindMicSettings()

      // If something external changes state to ERROR, clear UI hints.
      const unsubscribe =
        typeof stateMachine?.subscribe === 'function'
          ? stateMachine.subscribe((next) => {
              if (next === STATES.ERROR) setUiStatus('Error')
            })
          : () => {}

      return {
        voiceDebug,
        destroy() {
          destroyUi?.()
          destroyMicSettings?.()
          unsubscribe?.()
          if (typeof voiceInput.release === 'function') {
            voiceInput.release()
          } else {
            voiceInput.stop()
          }
          voiceOutput.cancel()
        }
      }
    }
  }
}
