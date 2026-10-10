import * as THREE from 'three'
import { createAnimator } from './animation/animator.js'
import { createCamera } from './engine/camera.js'
import { createComposer } from './engine/composer.js'
import { createRenderer } from './engine/renderer.js'
import { createScene } from './engine/scene.js'
import { setupResize } from './engine/resize.js'
import { createCore } from './core/core.js'
import { createEventBus } from './core/events/eventBus.js'
import { createStateMachine, STATES } from './assistant/stateMachine.js'
import { createAssistantClient } from './assistant/client.js'
import { createAssistantController } from './assistant/controller.js'
import { settings } from './config/settings.js'
import { createVoiceInputWebSpeech } from './interfaces/voice/voiceInputWebSpeech.js'
import { createVoiceInputRecorderServer } from './interfaces/voice/voiceInputRecorderServer.js'
import { createVoiceInputLocal } from './interfaces/voice/voiceInputLocal.js'
import { createVoiceOutputSpeechSynthesis } from './interfaces/voice/voiceOutputSpeechSynthesis.js'
import { createVoiceOrchestrator } from './interfaces/voice/voiceOrchestrator.js'
import { createVoiceDeviceManager } from './interfaces/voice/voiceDeviceManager.js'
import { createVoiceDebugPanel } from './interfaces/voice/voiceDebugPanel.js'
import { createLiveSpeechClient } from './interfaces/voice/liveSpeechClient.js'
import { createMeetingApi } from './interfaces/meeting/meetingApi.js'
import { createMeetingController, LIVE_SPEECH_PATH } from './interfaces/meeting/meetingController.js'
import { createMeetingStorage } from './interfaces/meeting/meetingStorage.js'
import { createMeetingPanel } from './interfaces/meeting/meetingPanel.js'
import { checkLiveSpeechSupport } from './interfaces/meeting/liveSupport.js'
import { createChatController } from './interfaces/chat/chatController.js'
import { createChatView } from './interfaces/chat/chatView.js'
import { createCommandRouter } from './interfaces/commands/meetingCommands.js'
import { createHistoryApi } from './interfaces/history/historyApi.js'
import { createAccessApi, createAccessController, watchForUnauthorized } from './interfaces/auth/access.js'
import { createAccessGateView } from './interfaces/auth/accessGateView.js'

const canvas = document.querySelector('#canvas')
if (!canvas) {
  throw new Error('Missing #canvas element')
}

const renderer = createRenderer(canvas)
const scene = createScene()
const camera = createCamera(window.innerWidth, window.innerHeight)

const core = createCore()
scene.add(core)

const { composer, bloomPass } = createComposer(renderer, scene, camera)

setupResize({ renderer, camera, composer })

const eventBus = createEventBus()
const assistantStateMachine = createStateMachine(STATES.IDLE, { eventBus })
const assistantClient = createAssistantClient()
const assistantController = createAssistantController({
  stateMachine: assistantStateMachine,
  client: assistantClient,
  eventBus
})

// Declared up here because the animator and the meeting callbacks below read them as the page goes on.
let voiceApi = null
let voiceModeActive = false
let chatView = null
let meetingPanel = null
// Meeting commands are answered by one router for typed and spoken input; it is created once the meeting
// controller exists, and until then (or if the meeting panel failed to start) nothing is treated as a command.
let commandRouter = null
const commandHook = { handle: (text) => (commandRouter ? commandRouter.handle(text) : null) }
const motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null

const animator = createAnimator({
  core,
  bloomPass,
  stateMachine: assistantStateMachine,
  // Only the user's real microphone level, only in voice mode. Playback has no level to read.
  getLevel: () => (voiceModeActive ? voiceApi?.getInputLevel?.() ?? 0 : 0),
  reducedMotion: () => motionQuery?.matches === true
})

assistantStateMachine.subscribe((next, prev) => {
  console.log('[assistant:visual]', prev, '->', next)
})

// Five words for the voice-mode status; every internal state maps onto one of them.
const STATE_LABELS = {
  IDLE: 'Ready',
  LISTENING: 'Listening',
  TRANSCRIBING: 'Thinking',
  PROCESSING: 'Thinking',
  THINKING: 'Thinking',
  RETRIEVING_MEMORY: 'Thinking',
  TOOL_EXECUTION: 'Thinking',
  GENERATING: 'Thinking',
  SPEAKING: 'Speaking',
  INTERRUPTED: 'Ready',
  ERROR_RECOVERY: 'Error',
  ERROR: 'Error'
}

const stateBadgeEl = document.querySelector('#assistantStateBadge')
const stateLabelEl = document.querySelector('#assistantStateLabel')
if (stateBadgeEl) {
  const updateBadge = (state) => {
    stateBadgeEl.dataset.state = state
    if (stateLabelEl) stateLabelEl.textContent = STATE_LABELS[state] ?? state
  }
  updateBadge(assistantStateMachine.getState())
  assistantStateMachine.subscribe((next) => updateBadge(next))
}

// The assistant may need an access code (the server says so). Asked before anything else is requested; a refusal
// later (the login expired) shows the same card. Unlocking reloads the page, so everything starts fresh.
const accessController = createAccessController({
  api: createAccessApi(),
  onUnlocked: () => globalThis.location?.reload()
})
createAccessGateView({ controller: accessController })
watchForUnauthorized(globalThis, () => accessController.require())
accessController.start()

assistantController.init().catch((err) => {
  console.error('[assistant] init failed', err)
})

// Shared with the meeting panel further down: the assistant steps aside while a meeting is open.
let preferredMicId = () => ''

if (settings.voice?.enabled) {
  const buttonEl = document.querySelector('#micButton')
  const wakeButtonEl = document.querySelector('#wakeButton')
  const micSettingsButtonEl = document.querySelector('#micSettingsButton')
  const micPanelEl = document.querySelector('#micSettingsPanel')
  const micSelectEl = document.querySelector('#micDeviceSelect')
  const micRefreshButtonEl = document.querySelector('#micRefreshButton')
  const micTestButtonEl = document.querySelector('#micTestButton')
  const micHintEl = document.querySelector('#micDeviceHint')
  const statusEl = document.querySelector('#voiceStatus')
  const transcriptEl = document.querySelector('#voiceTranscript')
  const responseEl = document.querySelector('#assistantResponse')
  const latencyEl = document.querySelector('#latencyFooter')

  const debugRequested = globalThis.location?.search?.includes('debug') === true
  if (latencyEl && debugRequested && settings.voice?.latencyAuditEnabled) {
    latencyEl.hidden = false
    latencyEl.removeAttribute('aria-hidden')
  }

  const voiceOutput = createVoiceOutputSpeechSynthesis()
  const deviceManager = createVoiceDeviceManager()
  preferredMicId = () => deviceManager.getPreferredDeviceId?.() ?? ''

  const audioMode = String(settings.voice?.audioMode ?? 'legacy').toLowerCase()
  const sttMode = String(settings.voice?.sttMode ?? 'webspeech').toLowerCase()
  const sttBackend = String(settings.voice?.sttBackend ?? 'local').toLowerCase()
  const debugOverlay =
    Boolean(settings.voice?.debugOverlay) ||
    globalThis.location?.search?.includes('debug') === true

  const voiceInput =
    audioMode === 'local'
      ? createVoiceInputLocal({
          lang: settings.voice.lang,
          prompt: settings.voice?.sttPrompt,
          sttBackend,
          maxUtteranceMs: settings.voice?.maxUtteranceMs,
          maxUtteranceMsWake: settings.voice?.maxUtteranceMsWake,
          wakeDebounceMs: settings.voice?.wakeDebounceMs,
          accessKey: settings.voice?.porcupineAccessKey,
          keywordPublicPath: settings.voice?.porcupineKeywordPublicPath,
          modelPublicPath: settings.voice?.porcupineModelPublicPath,
          keywordLabel: settings.voice?.porcupineKeyword,
          wakePhrases: settings.voice?.wakePhrases,
          vadSilenceMs: settings.voice?.vadSilenceMs,
          vadEnergyThreshold: settings.voice?.vadEnergyThreshold,
          vadMinSpeechMs: settings.voice?.vadMinSpeechMs,
          minRecordingMs: settings.voice?.minRecordingMs,
          vadSpeechRatio: settings.voice?.vadSpeechRatio,
          vadSpeechMinDelta: settings.voice?.vadSpeechMinDelta,
          vadSilenceRatio: settings.voice?.vadSilenceRatio,
          vadCooldownMs: settings.voice?.vadCooldownMs,
          vadBargeInMinMs: settings.voice?.vadBargeInMinMs,
          vadBargeInThreshold: settings.voice?.vadBargeInThreshold,
          vadPostSpeechSettleMs: settings.voice?.vadPostSpeechSettleMs,
          vadBargeInSettleMs: settings.voice?.vadBargeInSettleMs,
          vadBargeInEchoRatio: settings.voice?.vadBargeInEchoRatio,
          vadBargeInGuardMs: settings.voice?.vadBargeInGuardMs,
          autoGainControl: settings.voice?.autoGainControl,
          getDeviceId: () => deviceManager.getPreferredDeviceId?.() ?? ''
        })
      : sttMode === 'server'
        ? createVoiceInputRecorderServer({
            lang: settings.voice.lang,
            prompt: settings.voice?.sttPrompt ?? '',
            sttBackend,
            getDeviceId: () => deviceManager.getPreferredDeviceId?.() ?? ''
          })
        : createVoiceInputWebSpeech({
            lang: settings.voice.lang,
            interimResults: true,
            continuous: true
          })

  const voice = createVoiceOrchestrator({
    stateMachine: assistantStateMachine,
    assistantController,
    voiceInput,
    voiceOutput,
    deviceManager,
    commands: commandHook,
    ui: {
      buttonEl,
      wakeButtonEl,
      micSettingsButtonEl,
      micPanelEl,
      micSelectEl,
      micRefreshButtonEl,
      micTestButtonEl,
      micHintEl,
      statusEl,
      transcriptEl,
      responseEl,
      latencyEl
    },
    config: settings.voice,
    eventBus
  })

  voiceApi = voice.init()

  if (debugOverlay && voiceApi?.voiceDebug) {
    const panelEl = document.querySelector('#voiceDebugPanel')
    createVoiceDebugPanel({
      panelEl,
      stateMachine: assistantStateMachine,
      voiceDebug: voiceApi.voiceDebug
    })
  }
}

// ---- Meetings: record and save a meeting from this screen ----
// A meeting needs the microphone and must not be answered by the assistant, so while one is open the
// assistant's buttons, wake word and hands-free loop stand down, and come back afterwards.
async function setAssistantVoiceAvailable(available) {
  const controls = ['#micButton', '#wakeButton', '#micSettingsButton', '#micSettingsPanel']
    .map((selector) => document.querySelector(selector))
    .filter(Boolean)
  if (!available) {
    for (const element of controls) element.inert = true
    try {
      // Stops listening and the wake word, cuts speech, and drops any reply still on its way.
      await voiceApi?.suspend?.()
    } catch (err) {
      console.error('[meeting] could not pause the assistant', err)
    }
    return
  }
  voiceApi?.resume?.()
  for (const element of controls) element.inert = false
  if (settings.voice?.conversationMode && settings.voice?.autoStartOnLoad) {
    try {
      await voiceApi?.startConversation?.()
    } catch (err) {
      console.error('[meeting] could not resume the assistant', err)
    }
  }
}

function meetingSocketUrl() {
  const { protocol, host } = window.location
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${LIVE_SPEECH_PATH}`
}

// Saving a meeting's audio on the server is for measuring recognition, never a default: it needs this flag AND
// the operator's LIVE_RECORDINGS_DIR on the speech service. The service says whether it is recording.
const saveMeetingAudio =
  settings.voice?.saveMeetingAudio === true ||
  new URLSearchParams(globalThis.location?.search ?? '').get('saveAudio') === '1'

let meetingController = null
try {
  const meetingApi = createMeetingApi()
  meetingController = createMeetingController({
    api: meetingApi,
    storage: createMeetingStorage(),
    checkSupport: checkLiveSpeechSupport,
    createLiveClient: (options) =>
      createLiveSpeechClient({
        wsUrl: meetingSocketUrl(),
        getDeviceId: preferredMicId,
        // Naming the language spares the recognizer a guess on every decode (it once guessed Portuguese).
        language: settings.voice?.lang ?? '',
        // A meeting is room audio at varying distances: let the browser level it.
        autoGainControl: true,
        saveRecording: saveMeetingAudio,
        ...options
      })
  })
  meetingPanel = createMeetingPanel({
    controller: meetingController,
    api: meetingApi,
    onActiveChange: (active) => {
      setAssistantVoiceAvailable(!active)
      // The meeting owns the microphone now (setAssistantVoiceAvailable already stopped the listening).
      if (active && voiceModeActive) showVoiceMode(false)
      refreshVoiceButton()
    }
  })
  meetingController.restore()
  meetingPanel.openIfUnfinished()
  // Is this browser already unlocked? It decides whether "start the meeting" can start one straight away.
  meetingController.refreshLaunchSession().catch(() => {})
} catch (err) {
  // The meeting panel must never take the main screen down with it.
  console.error('[meeting] panel failed to start', err)
}

// ---- Settings popover: the voice engine toggles it; this keeps it accessible and easy to dismiss ----
{
  const button = document.querySelector('#micSettingsButton')
  const panel = document.querySelector('#micSettingsPanel')
  const wrap = document.querySelector('#settingsWrap')
  if (button && panel && wrap) {
    const sync = () => button.setAttribute('aria-expanded', String(!panel.hidden))
    const close = () => {
      panel.hidden = true
      sync()
    }
    button.addEventListener('click', () => queueMicrotask(sync)) // after the engine's own toggle
    document.addEventListener('pointerdown', (event) => {
      if (!panel.hidden && !wrap.contains(event.target)) close()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        close()
        button.focus()
      }
    })
    sync()
  }
}

// ---- Home: the conversation and its composer ----
// A meeting uses the microphone and the assistant stands down for it (see setAssistantVoiceAvailable), so
// ordinary messages wait until it is finished. Same definition of "open" as the meeting panel uses.
const meetingIsOpen = () => {
  const meeting = meetingController?.getState?.()
  return Boolean(meeting && (meeting.open || meeting.phase === 'launching'))
}
if (meetingController) {
  commandRouter = createCommandRouter({
    meeting: meetingController,
    openPanel: ({ title } = {}) => {
      // Unless this browser is unlocked (the router starts the meeting itself then), the launch code is typed by
      // a person in the panel; a title only saves a step.
      const titleInput = document.querySelector('#meetingTitleInput')
      if (title && titleInput) titleInput.value = title
      meetingPanel?.open()
    }
  })
}

const chat = createChatController({
  assistantController,
  assistantClient,
  eventBus,
  commands: commandHook,
  isBlocked: () => (voiceModeActive ? 'voice' : meetingIsOpen() ? 'meeting' : null),
  // One stop for everything in flight: the stream and, in voice mode, the speech and the listening loop.
  interrupt: () => (voiceModeActive && voiceApi?.interrupt ? voiceApi.interrupt() : assistantController.interrupt())
})
chatView = createChatView({ chat, onVoiceMode: () => enterVoiceMode() })

// ---- Saved conversations: reopen one from the history screen, and show its link only when history is on ----
{
  const historyApi = createHistoryApi()
  const wanted = new URLSearchParams(globalThis.location?.search ?? '').get('conversation')
  if (wanted) {
    historyApi
      .get(wanted)
      .then((conversation) => {
        // Used: leave the address bar clean, so a reload starts fresh instead of reopening it again.
        globalThis.history?.replaceState(null, '', globalThis.location.pathname)
        return chat.open(conversation)
      })
      .catch((err) => {
        // A refusal means the access code is being asked for; the link stays so it opens right after unlocking.
        if (err?.status === 401) return
        globalThis.history?.replaceState(null, '', globalThis.location.pathname)
        console.warn('[history] could not open the conversation', err)
        chatView?.notify(
          err?.code === 'not-found' ? 'That conversation no longer exists.' : 'That conversation could not be opened. Check the connection and try again.'
        )
      })
  }
  const link = document.querySelector('#historyLink')
  if (link) {
    historyApi
      .list({ limit: 1 })
      .then((result) => {
        link.hidden = !result?.enabled
      })
      .catch(() => {})
  }
}

// ---- Voice mode: the orb, a status in words, and a way out ----
const VOICE_ERRORS = {
  'permission-denied': "Microphone access is blocked. Allow it in your browser's site settings, then try again.",
  'no-microphone': 'No microphone was found. Connect one and try again.',
  'needs-gesture': 'The browser needs another tap to start listening. Press the microphone button again.',
  suspended: 'A meeting is recording, so voice mode is unavailable until it ends.',
  unsupported: 'Voice mode is not available in this browser.',
  error: 'Voice mode could not start. Check the microphone and try again.'
}
const RESPONDING = new Set(['PROCESSING', 'THINKING', 'RETRIEVING_MEMORY', 'TOOL_EXECUTION', 'GENERATING', 'SPEAKING'])
const voiceModeEl = document.querySelector('#voiceMode')
const voiceInterruptEl = document.querySelector('#voiceInterruptButton')
const voiceEndEl = document.querySelector('#voiceEndButton')

function refreshVoiceButton() {
  if (!chatView) return
  const open = meetingIsOpen()
  chatView.setVoiceButton({
    available: Boolean(voiceApi?.startConversation),
    disabled: open,
    title: open ? 'Voice mode is unavailable while a meeting is open' : 'Start voice mode'
  })
}

function syncVoiceControls() {
  if (voiceInterruptEl) {
    voiceInterruptEl.hidden = !(voiceModeActive && RESPONDING.has(assistantStateMachine.getState()))
  }
}

function showVoiceMode(on) {
  voiceModeActive = on
  document.body.dataset.mode = on ? 'voice' : 'chat'
  if (voiceModeEl) voiceModeEl.hidden = !on
  syncVoiceControls()
  if (on) voiceEndEl?.focus({ preventScroll: true })
  else chatView?.focusInput()
}

let startingVoiceMode = false

async function enterVoiceMode() {
  if (voiceModeActive || !voiceApi?.startConversation) return
  if (meetingIsOpen()) {
    chatView.notify(VOICE_ERRORS.suspended)
    return
  }
  if (chat.getState().busy) {
    chatView.notify('Wait for the reply to finish, or press Stop, then start voice mode.')
    return
  }
  if (startingVoiceMode) return
  startingVoiceMode = true
  // The browser may be asking for the microphone right now; say so instead of looking frozen.
  chatView.notify('Allow the microphone if your browser asks…')
  try {
    // The click that got us here is the user gesture the microphone needs; the result says exactly what failed.
    const result = await voiceApi.startConversation()
    if (!result?.ok) {
      chatView.notify(VOICE_ERRORS[result?.reason] ?? VOICE_ERRORS.error)
      return
    }
    chatView.clearNotice()
    showVoiceMode(true)
  } finally {
    startingVoiceMode = false
  }
}

async function exitVoiceMode() {
  if (!voiceModeActive) return
  showVoiceMode(false) // the screen never waits on the microphone
  try {
    await voiceApi.stopConversation()
  } catch (err) {
    console.error('[voice] could not stop voice mode', err)
  }
}

voiceEndEl?.addEventListener('click', () => exitVoiceMode())
voiceInterruptEl?.addEventListener('click', () => voiceApi?.interrupt?.())
assistantStateMachine.subscribe(syncVoiceControls)
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !voiceModeActive) return
  // Escape stops a reply first; with nothing to stop it leaves voice mode.
  if (voiceInterruptEl && !voiceInterruptEl.hidden) voiceApi?.interrupt?.()
  else exitVoiceMode()
})
meetingController?.subscribe?.(refreshVoiceButton)
refreshVoiceButton()

// The orb is only drawn in voice mode (the Home screen covers it), so it costs nothing the rest of the time.
const clock = new THREE.Clock()

function tick() {
  requestAnimationFrame(tick)
  // One clock read per frame: getElapsedTime() already advances the clock, so a getDelta() after it returned
  // about zero and the orb's state transitions never visibly happened.
  const delta = clock.getDelta()
  if (document.body.dataset.mode !== 'voice') return
  animator.update(clock.elapsedTime, delta)
  composer.render()
}

tick()

export { assistantController, assistantStateMachine, STATES }
