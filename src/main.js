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

const animator = createAnimator({ core, bloomPass, stateMachine: assistantStateMachine })

assistantStateMachine.subscribe((next, prev) => {
  console.log('[assistant:visual]', prev, '->', next)
})

const STATE_LABELS = {
  IDLE: 'Ready',
  LISTENING: 'Listening',
  TRANSCRIBING: 'Transcribing',
  PROCESSING: 'Thinking',
  THINKING: 'Thinking',
  RETRIEVING_MEMORY: 'Thinking',
  TOOL_EXECUTION: 'Working',
  GENERATING: 'Thinking',
  SPEAKING: 'Speaking',
  INTERRUPTED: 'Listening',
  ERROR_RECOVERY: 'Recovering',
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

assistantController.init().catch((err) => {
  console.error('[assistant] init failed', err)
})

// Shared with the meeting panel further down: the assistant steps aside while a meeting is open.
let voiceApi = null
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

  if (latencyEl && settings.voice?.latencyAuditEnabled) {
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

try {
  const meetingApi = createMeetingApi()
  const meetingController = createMeetingController({
    api: meetingApi,
    storage: createMeetingStorage(),
    checkSupport: checkLiveSpeechSupport,
    createLiveClient: (options) =>
      createLiveSpeechClient({ wsUrl: meetingSocketUrl(), getDeviceId: preferredMicId, ...options })
  })
  const meetingPanel = createMeetingPanel({
    controller: meetingController,
    api: meetingApi,
    onActiveChange: (active) => {
      setAssistantVoiceAvailable(!active)
    }
  })
  meetingController.restore()
  meetingPanel.openIfUnfinished()
} catch (err) {
  // The meeting panel must never take the main screen down with it.
  console.error('[meeting] panel failed to start', err)
}

const clock = new THREE.Clock()

function tick() {
  requestAnimationFrame(tick)
  animator.update(clock.getElapsedTime(), clock.getDelta())
  composer.render()
}

tick()

export { assistantController, assistantStateMachine, STATES }
