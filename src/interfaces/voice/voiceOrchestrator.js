import { STATES } from '../../assistant/stateMachine.js'
import { describeMicError } from './voiceDeviceManager.js'
import { createVoiceDebug } from './voiceDebug.js'
import { matchWakePhrase, normalizeText } from './wakePhrase.js'
import { createSelfEchoGuard } from './selfEchoGuard.js'

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
  config,
  eventBus,
  // Optional { handle(text) -> Promise<{ reply } | null> }: a command heard by voice (a meeting command) is
  // answered here, out loud, and never sent to the assistant.
  commands = null
}) {
  let pressed = false
  let busy = false
  let lastTranscript = ''
  // What the assistant said, kept for a moment, so its own words coming back through the microphone are not
  // answered as if the user had said them. Off with config.selfEchoGuard === false. See selfEchoGuard.js.
  const echoGuard = config?.selfEchoGuard === false ? null : createSelfEchoGuard({ now: () => nowMs() })
  let wakeMode = false
  // While a meeting records, the assistant must neither listen nor speak — not even a reply that was
  // already on its way when the meeting started (it would be recorded into the meeting). See suspend().
  let suspended = false
  let awaitingWakeCommand = false

  // Turn identity. A turn ends when it is interrupted, stopped or a meeting starts. Whatever it still does when its
  // pending request returns must not speak, change the voice state, or keep the next command out as "busy".
  let turnId = 0
  // A capture that began before this moment was already given up on (interrupted, stopped, meeting started).
  let staleBefore = 0
  // Capture ids already handed to a turn: one capture is answered at most once, whatever announces it again.
  const handledCaptures = new Set()
  const MAX_REMEMBERED_CAPTURES = 64
  // The latest request, until it settles. It can outlive an interrupted turn: the server does not stop generating
  // an interrupted reply, and sends the rest of it on the same connection.
  let requestInFlight = null

  // Continuous (ChatGPT-Voice-style) conversation loop.
  let conversationActive = false
  let streamingText = ''
  let markedFirstToken = false

  // Sentence-level streaming TTS: speak each sentence as soon as it's
  // complete instead of waiting for the whole reply to finish generating
  // (previously the single biggest source of perceived response latency —
  // the model could finish thinking in 1s but a long reply still delayed
  // first audio by however long the rest took to generate).
  let speechBuffer = ''
  let speakingStarted = false

  const audioMode = String(config?.audioMode ?? 'legacy').toLowerCase()
  const isLocalMode = audioMode === 'local'
  const conversationMode = Boolean(config?.conversationMode) && isLocalMode
  const hideHoldToTalk = Boolean(config?.hideHoldToTalkButton)
  const autoStartOnLoad = Boolean(config?.autoStartOnLoad)
  const supportsContinuous = typeof voiceInput?.startContinuous === 'function'
  const voiceDebug = createVoiceDebug({
    enabled: Boolean(config?.debugTiming) || Boolean(config?.latencyAuditEnabled)
  })

  // Extracts one speakable chunk (up to the first sentence boundary) from a
  // growing token buffer, leaving the remainder for more context. Falls
  // back to a soft break at the last space once the buffer grows too long
  // without punctuation, so long unpunctuated text still speaks
  // progressively rather than piling up silently.
  const SENTENCE_BOUNDARY_RE = /[.!?]+[)\]"']*(?:\s+|$)/
  const MIN_CHUNK_CHARS = 12
  const MAX_BUFFER_CHARS = 220

  function extractSpeakableChunk(buffer) {
    if (buffer.length >= MAX_BUFFER_CHARS) {
      const lastSpace = buffer.lastIndexOf(' ', MAX_BUFFER_CHARS)
      const cut = lastSpace > MIN_CHUNK_CHARS ? lastSpace : MAX_BUFFER_CHARS
      return { chunk: buffer.slice(0, cut).trim(), rest: buffer.slice(cut) }
    }

    const match = SENTENCE_BOUNDARY_RE.exec(buffer)
    if (!match) return null
    const cut = match.index + match[0].length
    const chunk = buffer.slice(0, cut).trim()
    if (chunk.length < MIN_CHUNK_CHARS) return null
    return { chunk, rest: buffer.slice(cut) }
  }

  function ttsOptions() {
    return {
      voiceName: config?.ttsVoiceName,
      lang: config?.lang,
      rate: config?.ttsRate,
      pitch: config?.ttsPitch,
      volume: config?.ttsVolume
    }
  }

  function nowMs() {
    return globalThis.performance?.now?.() ?? Date.now()
  }

  /** The turn in progress is over: its late results are ignored and the next command is not held off. */
  function abandonTurn() {
    turnId += 1
    staleBefore = nowMs()
    echoGuard?.noteSpeechEnded() // whatever was being said has stopped (or is being cut)
    if (busy) {
      busy = false
      setBusyUi(false)
    }
  }

  /**
   * After an interruption the next command is held (not dropped) until the abandoned request has settled, so that
   * the tail of the old reply is not received as the start of the new one. Bounded: it never waits for ever.
   */
  async function waitForAbandonedRequest() {
    const pending = requestInFlight
    if (!pending) return
    const limit = Number(config?.interruptSettleMs)
    const waitMs = Number.isFinite(limit) && limit >= 0 ? limit : 6000
    let timer = null
    const gaveUp = new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs)
    })
    try {
      await Promise.race([pending, gaveUp])
    } finally {
      clearTimeout(timer)
    }
  }

  // A safety net, not a timer for normal speech: browsers sometimes never report that speech ended, and the turn
  // must not stay busy for ever when that happens. Generous: 150 ms per character plus 15 s.
  function speechWatchdogMs(text) {
    const configured = Number(config?.ttsWatchdogMs)
    if (Number.isFinite(configured) && configured > 0) return configured
    const chars = Math.max(String(text ?? '').length, streamingText.length)
    return Math.max(20000, 15000 + chars * 150)
  }

  // Chunks are queued and drained one at a time (not fired concurrently
  // with .then()) so submission order is guaranteed even though
  // ensureSpeakingStarted() and enqueueChunk() are both async — otherwise a
  // later sentence's setup could resolve before an earlier one's, playing
  // them out of order.
  let pendingSpeechChunks = []
  let drainingSpeechQueue = false
  let speechDrain = Promise.resolve()

  // A reply reaches the speech output a chunk at a time, and each chunk waits for the one before it to finish
  // speaking. So "the output has nothing queued" is NOT "the reply has been spoken": chunks may still be waiting
  // here (or on the voice, or on the server round trip that precedes speech). A reply is over when this queue is
  // empty and the output has ended. (Treating the output alone as the end made the assistant declare itself done
  // as it began to speak, and listen to, and transcribe, its own voice.)
  function drainSpeechQueue() {
    if (drainingSpeechQueue) return speechDrain
    drainingSpeechQueue = true
    speechDrain = (async () => {
      try {
        while (pendingSpeechChunks.length > 0) {
          const text = pendingSpeechChunks.shift()
          const ready = await ensureSpeakingStarted()
          if (!ready) {
            pendingSpeechChunks = [] // given up on while the state was being synced: nothing more is spoken
            break
          }
          try {
            echoGuard?.noteSpoken(text)
            await voiceOutput.enqueueChunk(text, ttsOptions())
          } catch (err) {
            console.error('[voice] streaming speech chunk failed', err)
          }
        }
      } finally {
        drainingSpeechQueue = false
      }
    })()
    return speechDrain
  }

  /** Resolves when every chunk of the reply has been spoken and the output has ended. */
  async function waitUntilSpoken(turn) {
    while (drainingSpeechQueue || pendingSpeechChunks.length > 0) {
      await drainSpeechQueue()
      if (turn !== turnId) return
    }
    await voiceOutput.endStream()
    echoGuard?.noteSpeechEnded()
  }

  function queueSpeechChunk(text) {
    if (suspended) return
    pendingSpeechChunks.push(text)
    drainSpeechQueue().catch((err) => console.error('[voice] speaking failed', err))
  }

  /** Resolves true when speech may go ahead, false when the turn was given up on while the state was synced. */
  async function ensureSpeakingStarted() {
    if (speakingStarted) return true
    const turn = turnId
    speakingStarted = true
    try {
      voiceOutput.beginStream()
      await assistantController.setSpeaking()
      if (turn !== turnId || suspended) {
        speakingStarted = false
        return false
      }
      if (wakeMode) voiceInput.stop()
      if (isLocalVoiceInput() && typeof voiceInput.pauseWake === 'function') {
        await voiceInput.pauseWake()
      }
      if (turn !== turnId || suspended) {
        speakingStarted = false
        return false
      }
      if (conversationActive && typeof voiceInput.setSpeakingPhase === 'function') {
        // Keep the mic + analyser running so the VAD loop can detect barge-in.
        voiceInput.setSpeakingPhase(true)
      }
      return true
    } catch (err) {
      speakingStarted = false
      throw err
    }
  }

  function isLocalVoiceInput() {
    return isLocalMode && typeof voiceInput?.armWake === 'function'
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
    return matchWakePhrase(text, getWakePhrases())
  }

  function setUiStatus(text) {
    if (!ui?.statusEl) return
    ui.statusEl.textContent = text ?? ''
  }

  function setUiTranscript(text) {
    if (!ui?.transcriptEl) return
    ui.transcriptEl.textContent = text ?? ''
  }

  function setUiResponse(text) {
    if (!ui?.responseEl) return
    ui.responseEl.textContent = text ?? ''
  }

  function renderLatency() {
    if (!ui?.latencyEl || !voiceDebug.enabled) return
    const wanted = ['stt', 'ttft', 'llm_total', 'tts', 'turn_total']
    const recent = voiceDebug.getLastMeasures(12)
    const byName = new Map()
    for (const m of recent) {
      if (!byName.has(m.name)) byName.set(m.name, m.durationMs)
    }
    const parts = wanted.filter((n) => byName.has(n)).map((n) => `${n} ${byName.get(n)}ms`)
    ui.latencyEl.textContent = parts.join('  ·  ')
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
    if (suspended) return
    const turn = turnId
    // Most of the reply was very likely already handed over chunk by chunk as it streamed in (see bindStreaming's
    // token handler). What is left is the tail past the last sentence boundary, or the whole reply when it never
    // streamed (the non-streaming JSON fallback path in controller.js emits no token events at all). It goes
    // through the same queue, so it is spoken after everything before it, in order.
    const streamed = speakingStarted || drainingSpeechQueue || pendingSpeechChunks.length > 0
    const rest = String((streamed ? speechBuffer : replyText) ?? '').trim()
    speechBuffer = ''
    if (!streamed && !rest) return
    if (rest) pendingSpeechChunks.push(rest)

    let stallTimer = null
    try {
      const ended = waitUntilSpoken(turn)
      ended.catch(() => {}) // if the watchdog wins, a late rejection is not an unhandled one
      const stalled = new Promise((resolve) => {
        stallTimer = setTimeout(() => resolve('stalled'), speechWatchdogMs(replyText))
      })
      const outcome = await Promise.race([ended.then(() => 'done'), stalled])
      if (outcome === 'stalled') {
        console.warn('[voice] speech never reported that it finished; carrying on')
        try {
          voiceOutput.cancel()
        } catch {
          /* nothing was playing */
        }
        setUiStatus('')
      }
    } catch (err) {
      const reason = String(err?.error ?? err?.name ?? '')
      // Barge-in / manual stop cancels speech synthesis — not a real failure.
      if (reason !== 'interrupted' && reason !== 'canceled') throw err
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
      // Only the turn still in progress puts the shared state back. A turn that was interrupted already did,
      // and doing it again here could clear the speaking state of the turn that followed it.
      if (turn === turnId) {
        if (typeof voiceInput.setSpeakingPhase === 'function') {
          voiceInput.setSpeakingPhase(false)
        }
        speakingStarted = false
      }
    }

    if (turn === turnId && !conversationActive) {
      await safeSetIdle()
      if (wakeMode) await startWakeListening()
    }
  }

  async function answerCommand(text) {
    if (!commands || typeof commands.handle !== 'function') return null
    try {
      const answer = await commands.handle(text)
      return answer && typeof answer.reply === 'string' && answer.reply ? answer : null
    } catch (err) {
      console.error('[voice] command handling failed; sending it to the assistant instead', err)
      return null
    }
  }

  async function handleAssistantPrompt(text) {
    const cleaned = typeof text === 'string' ? text.trim() : ''
    if (!cleaned || suspended) return
    if (busy) {
      setUiStatus('Busy — wait…')
      return
    }

    busy = true
    const turn = ++turnId
    const current = () => turn === turnId
    setBusyUi(true)
    if (typeof voiceInput.setDetectionEnabled === 'function') {
      voiceInput.setDetectionEnabled(false)
    }
    lastTranscript = cleaned
    setUiTranscript(cleaned)
    streamingText = ''
    markedFirstToken = false
    speechBuffer = ''
    setUiResponse('')

    const local = await answerCommand(cleaned)
    if (!current()) return
    if (local) {
      setUiResponse(local.reply)
      eventBus?.emit?.('command:handled', { text: cleaned, reply: local.reply })
      try {
        // Speaking goes through the same states as a reply (LISTENING cannot go straight to SPEAKING).
        await assistantController.setProcessing()
        await speakReply(local.reply)
      } catch (err) {
        if (!current()) return
        console.error('[voice] speaking a command reply failed', err)
        await assistantController.setError()
        await safeSetIdle()
        if (conversationActive) await stopConversation()
      } finally {
        if (current()) {
          busy = false
          setBusyUi(false)
          voiceDebug.setPhase('idle')
        }
      }
      if (current() && conversationActive) await afterTurnComplete()
      return
    }

    voiceDebug.mark('llm_start')
    voiceDebug.setPhase('thinking')
    setUiStatus('Thinking…')

    await waitForAbandonedRequest()
    if (!current()) return
    const request = Promise.resolve(assistantController.requestReply(cleaned))
    const settled = request.then(
      () => {},
      () => {}
    )
    requestInFlight = settled
    settled.then(() => {
      if (requestInFlight === settled) requestInFlight = null
    })
    const reply = await request
    // Interrupted, stopped or a meeting started while the request was pending: its answer is no longer wanted.
    if (!current()) return
    voiceDebug.mark('llm_end')
    voiceDebug.measure('llm_total', 'llm_start', 'llm_end')
    if (!reply) {
      if (speakingStarted) {
        // Streaming produced some chunks (already spoken or in flight) but
        // the turn ended without a final reply (e.g. aborted mid-stream) —
        // still need to close out speaking state cleanly.
        try {
          await waitUntilSpoken(turn)
        } catch {
          /* ignore */
        }
        if (!current()) return
        if (typeof voiceInput.setSpeakingPhase === 'function') voiceInput.setSpeakingPhase(false)
        speakingStarted = false
      }
      if (!current()) return
      busy = false
      setBusyUi(false)
      voiceDebug.setPhase('idle')
      if (conversationActive) await afterTurnComplete()
      return
    }

    setUiResponse(reply)

    try {
      await speakReply(reply)
    } catch (err) {
      if (!current()) return
      console.error('[voice] speak failed', err)
      await assistantController.setError()
      await safeSetIdle()
      if (conversationActive) await stopConversation()
    } finally {
      if (current()) {
        busy = false
        setBusyUi(false)
        voiceDebug.setPhase('idle')
      }
    }

    if (current() && conversationActive) await afterTurnComplete()
  }

  /**
   * Starts the hands-free listening loop. Resolves to { ok: true } or { ok: false, reason } so the caller can
   * tell the user exactly what is wrong: 'permission-denied', 'no-microphone', 'needs-gesture', 'suspended'
   * (a meeting has the microphone), 'unsupported' or 'error'.
   */
  async function startConversation() {
    if (!conversationMode || !supportsContinuous) return { ok: false, reason: 'unsupported' }
    if (suspended) return { ok: false, reason: 'suspended' }
    conversationActive = true
    streamingText = ''
    setUiResponse('')
    setUiTranscript('')
    setUiStatus('Listening…')
    try {
      await assistantController.setListening()
      voiceInput.setSpeakingPhase(false)
      await voiceInput.startContinuous()
      return { ok: true }
    } catch (err) {
      console.error('[voice] startConversation failed', err)
      const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : ''
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
      if (name === 'NotAllowedError') {
        setUiStatus('Mic blocked — allow microphone in browser settings')
        conversationActive = false
        return { ok: false, reason: 'permission-denied' }
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setUiStatus('No microphone found')
        conversationActive = false
        await safeSetIdle()
        return { ok: false, reason: 'no-microphone' }
      }
      if (code === 'audio-context-suspended') {
        // Needs a real user gesture to resume — bindUi()'s mic tap handler
        // retries startConversation() directly when it sees this state.
        // The button may be hidden (hideHoldToTalkButton) since conversation
        // mode normally owns the mic hands-free; reveal it so there's an
        // actual affordance to tap.
        if (ui?.buttonEl) {
          ui.buttonEl.removeAttribute('hidden')
          ui.buttonEl.classList.remove('is-hidden')
        }
        setUiStatus('Tap Mic to start listening')
        conversationActive = false
        return { ok: false, reason: 'needs-gesture' }
      }
      await assistantController.setError()
      await safeSetIdle()
      conversationActive = false
      return { ok: false, reason: 'error' }
    }
  }

  /**
   * Stand down for a meeting: stop listening (hands-free loop and wake word), cut any speech that is
   * playing, and refuse to speak anything that arrives later, including the rest of a reply that was
   * already streaming when the meeting started. resume() lifts it; it does not restart listening.
   */
  async function suspend() {
    suspended = true
    abandonTurn()
    pendingSpeechChunks = []
    speechBuffer = ''
    try {
      voiceOutput.cancel()
    } catch {
      /* nothing was playing */
    }
    if (wakeMode) await stopWakeListening()
    await stopConversation()
  }

  function resume() {
    suspended = false
  }

  async function stopConversation() {
    conversationActive = false
    abandonTurn()
    try {
      if (typeof voiceInput.stopContinuous === 'function') {
        await voiceInput.stopContinuous()
      }
      voiceOutput.cancel()
      speechBuffer = ''
      speakingStarted = false
      pendingSpeechChunks = []
      await safeSetIdle()
      setUiStatus('')
    } catch (err) {
      console.error('[voice] stopConversation failed', err)
    }
  }

  async function afterTurnComplete() {
    // Conversation-mode only: loop straight back into listening.
    // Legacy wake / hold-to-talk paths handle their own idle + wake restart.
    if (!conversationActive) return
    await startConversation()
  }

  async function handleBargeIn() {
    if (!conversationActive) return
    // The reply in progress is over: its request may still be pending, but whatever it returns is ignored, and
    // what the person says next is a new turn, not "busy".
    abandonTurn()
    voiceOutput.cancel()
    // The speech was cut at once and the person is already talking: only a short wait before listening.
    if (typeof voiceInput.setSpeakingPhase === 'function') voiceInput.setSpeakingPhase(false, { interrupted: true })
    streamingText = ''
    speechBuffer = ''
    speakingStarted = false
    pendingSpeechChunks = []
    setUiResponse('')
    setUiTranscript('')
    try {
      await assistantController.interrupt()
    } catch (err) {
      console.warn('[voice] interrupt failed', err)
    }
    await startConversation()
  }

  /**
   * Stops the reply in progress: cuts speech, aborts the stream and drops what was queued. In a hands-free
   * conversation it goes straight back to listening (same as a barge-in); otherwise the assistant returns to
   * idle. Safe to call when nothing is happening.
   */
  async function interrupt() {
    if (suspended) return
    if (conversationActive) {
      await handleBargeIn()
      return
    }
    abandonTurn()
    try {
      voiceOutput.cancel()
    } catch {
      /* nothing was playing */
    }
    streamingText = ''
    speechBuffer = ''
    speakingStarted = false
    pendingSpeechChunks = []
    try {
      await assistantController.interrupt()
    } catch (err) {
      console.warn('[voice] interrupt failed', err)
    }
    await safeSetIdle()
    // The interrupted turn used to re-arm the wake word as it unwound; it is abandoned now, so do it here.
    if (wakeMode) await startWakeListening()
  }

  /**
   * A capture that produced nothing to answer (no speech, or only the assistant's own words): carry on listening.
   * A capture that comes back while a turn is under way belongs to an earlier moment: it must not stop the capture
   * now running, nor reset the turn (busy, speaking, listening) in progress.
   */
  async function resumeAfterEmptyCapture() {
    if (conversationActive && busy) return
    pressed = false
    try {
      voiceInput.stop()
    } catch {
      /* ignore */
    }
    // Conversation mode: a stray trigger that yields nothing quietly loops back to listening rather than
    // dropping out of the loop.
    if (conversationActive) {
      setUiStatus('Listening…')
      busy = false
      setBusyUi(false)
      await afterTurnComplete()
      return
    }
    setUiStatus(
      wakeMode ? (isLocalMode ? 'Wake armed — say NUMZ' : 'Wake mode armed') : "Didn't catch that"
    )
    await safeSetIdle()
    if (wakeMode) await startWakeListening()
  }

  async function handleFinalTranscript(text, meta = null) {
    const cleaned = typeof text === 'string' ? text.trim() : ''
    if (!cleaned) return

    if (meta && typeof meta === 'object') {
      // Began before the last interruption / stop: it was being said (or played back) before that, not now.
      if (typeof meta.startedAt === 'number' && meta.startedAt < staleBefore) return
      // The same capture is answered once, however many times it is announced. (By identity, never by text:
      // a person may say the same thing twice, and that is two commands.)
      if (meta.captureId !== undefined && meta.captureId !== null) {
        if (handledCaptures.has(meta.captureId)) return
        handledCaptures.add(meta.captureId)
        if (handledCaptures.size > MAX_REMEMBERED_CAPTURES) {
          handledCaptures.delete(handledCaptures.values().next().value)
        }
      }
    }

    // Its own words coming back through the microphone are not a command. Treated like an empty capture:
    // nothing is answered and listening carries on.
    if (echoGuard) {
      const verdict = echoGuard.check(cleaned, { capturedAt: typeof meta?.startedAt === 'number' ? meta.startedAt : undefined })
      if (verdict.echo) {
        eventBus?.emit?.('voice:echo-suppressed', { text: cleaned, score: verdict.score })
        console.warn('[voice] ignored a transcript that is the assistant\'s own speech:', cleaned)
        await resumeAfterEmptyCapture()
        return
      }
    }

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
          setUiStatus('Wake unavailable — check mic permissions')
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

    // When conversation mode owns the mic, hide the legacy hold-to-talk button.
    if (hideHoldToTalk && btn) {
      btn.classList.add('is-hidden')
      btn.setAttribute('hidden', '')
    }

    const onDown = async (ev) => {
      ev.preventDefault?.()
      if (busy) {
        setUiStatus('Busy — wait…')
        return
      }
      if (conversationMode && !conversationActive) {
        // A tap is a real user gesture — recovers conversation mode when
        // autoStartOnLoad's AudioContext came up suspended (see
        // voiceInputLocal.js's 'audio-context-suspended') or otherwise
        // failed to start. Don't fall through to hold-to-talk below.
        await startConversation()
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

    // Attached regardless of hideHoldToTalk: onDown also handles recovering
    // a stuck conversation-mode AudioContext (see startConversation's
    // 'audio-context-suspended' branch above), which reveals this button
    // on demand — a hidden element can't receive taps anyway, so this is a
    // no-op for hold-to-talk itself while conversation mode is healthy.
    const wireHoldToTalk = Boolean(btn)
    if (wireHoldToTalk) {
      btn.addEventListener('pointerdown', onDown)
      btn.addEventListener('pointerup', onUp)
      btn.addEventListener('pointercancel', onUp)
      btn.addEventListener('pointerleave', (ev) => {
        if (!pressed) return
        onUp(ev)
      })
    }

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
      if (wireHoldToTalk) {
        btn.removeEventListener('pointerdown', onDown)
        btn.removeEventListener('pointerup', onUp)
        btn.removeEventListener('pointercancel', onUp)
        // pointerleave listener is anonymous; keep it simple for v1 (page refresh clears).
      }
      ui?.wakeButtonEl?.removeEventListener('click', onWakeToggle)
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
          if (typeof voiceInput.setDetectionEnabled === 'function') {
            voiceInput.setDetectionEnabled(false)
          }
          if (conversationActive) {
            assistantController.setTranscribing().catch(() => {})
          }
        } else if (phase === 'recording' || phase === 'listening') {
          setUiStatus('Listening…')
        }
      })
    }

    if (typeof voiceInput.setOnBargeIn === 'function') {
      voiceInput.setOnBargeIn(() => {
        // Only an interruption of something of ours: the assistant speaking, or a reply on its way.
        if (!speakingStarted && !busy) return
        handleBargeIn().catch((err) => console.error('[voice] barge-in failed', err))
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

    voiceInput.setOnFinal((text, meta) => {
      voiceDebug.measure('stt', 'stt_start')
      voiceDebug.mark('transcript_ready')
      voiceDebug.mark('utterance_end')
      handleFinalTranscript(text, meta)
    })

    voiceInput.setOnError(async (err) => {
      console.error('[voice] stt error', err)
      const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : ''
      const code =
        err && typeof err === 'object' && 'error' in err ? String(err.error) : ''
      if (code === 'no-speech') {
        await resumeAfterEmptyCapture()
        return
      }
      pressed = false
      try {
        voiceInput.stop()
      } catch {
        /* ignore */
      }

      if (conversationActive) {
        if (name === 'NotAllowedError' || code === 'not-allowed') {
          setUiStatus('Mic blocked — allow microphone in browser settings')
        } else if (code === 'audio-service-offline') {
          setUiStatus('Audio service offline — run npm run dev:audio')
        } else {
          setUiStatus('Voice error — conversation stopped')
        }
        await stopConversation()
        return
      }

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
      // Its voice is audible from now: the input starts measuring how loud that is in the microphone.
      if (typeof voiceInput.notePlaybackStarted === 'function') voiceInput.notePlaybackStarted()
      voiceDebug.setPhase('speaking')
      voiceDebug.mark('tts_start')
      setUiStatus('Speaking…')
    })

    voiceOutput.setOnEnd(() => {
      echoGuard?.noteSpeechEnded()
      voiceDebug.mark('tts_end')
      voiceDebug.measure('tts', 'tts_start', 'tts_end')
      voiceDebug.measure('turn_total', 'utterance_end', 'tts_end')
      renderLatency()
      setUiStatus('')
    })

    voiceOutput.setOnError((err) => {
      console.error('[voice] tts error', err)
    })
  }

  function bindStreaming() {
    if (!eventBus || typeof eventBus.on !== 'function') return () => {}
    return eventBus.on('assistant:token', (event) => {
      const token = event?.payload?.token ?? ''
      if (!token) return
      // Only a turn this orchestrator started is spoken. A typed message streams the same events, and its
      // reply must stay silent.
      if (!busy) return
      if (!markedFirstToken) {
        markedFirstToken = true
        voiceDebug.mark('first_token')
        voiceDebug.measure('ttft', 'llm_start', 'first_token')
      }
      streamingText += token
      setUiResponse(streamingText)

      speechBuffer += token
      let extracted = extractSpeakableChunk(speechBuffer)
      while (extracted) {
        speechBuffer = extracted.rest
        queueSpeechChunk(extracted.chunk)
        extracted = extractSpeakableChunk(speechBuffer)
      }
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
        const wakeModeLabel =
          typeof voiceInput.getWakeMode === 'function' && voiceInput.getWakeMode() === 'porcupine'
            ? 'Porcupine'
            : 'speech'
        setMicHint(
          wakeOk
            ? `Local audio — hold mic or enable wake (NUMZ via ${wakeModeLabel})`
            : 'Local STT ready; enable mic permissions for wake'
        )
      }

      bindVoiceCallbacks()
      const destroyStreaming = bindStreaming()
      const destroyUi = bindUi()
      const destroyMicSettings = bindMicSettings()

      // If something external changes state to ERROR, clear UI hints.
      const unsubscribe =
        typeof stateMachine?.subscribe === 'function'
          ? stateMachine.subscribe((next) => {
              // The state label already says "Error"; this line says what to do about it.
              if (next === STATES.ERROR) setUiStatus('Something went wrong. Try again.')
            })
          : () => {}

      if (conversationMode && autoStartOnLoad && supportsContinuous) {
        // Hands-free: enter the listening loop as soon as the page is ready.
        startConversation().catch((err) =>
          console.error('[voice] auto-start conversation failed', err)
        )
      } else if (conversationMode && !supportsContinuous) {
        console.warn('[voice] conversationMode requires the local audio pipeline')
      }

      return {
        voiceDebug,
        startConversation,
        stopConversation,
        interrupt,
        suspend,
        resume,
        isConversationActive: () => conversationActive,
        /** The live microphone level, 0..1 (0 when not listening). Only real input is reported, never playback. */
        getInputLevel: () => (typeof voiceInput.getInputLevel === 'function' ? voiceInput.getInputLevel() : 0),
        destroy() {
          destroyStreaming?.()
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
