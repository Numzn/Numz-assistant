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

  const voiceApi = voice.init()

  if (debugOverlay && voiceApi?.voiceDebug) {
    const panelEl = document.querySelector('#voiceDebugPanel')
    createVoiceDebugPanel({
      panelEl,
      stateMachine: assistantStateMachine,
      voiceDebug: voiceApi.voiceDebug
    })
  }
}

const clock = new THREE.Clock()

function tick() {
  requestAnimationFrame(tick)
  animator.update(clock.getElapsedTime(), clock.getDelta())
  composer.render()
}

tick()

export { assistantController, assistantStateMachine, STATES }
