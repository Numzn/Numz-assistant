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
          prompt: settings.voice?.sttPrompt ?? '',
          sttBackend,
          maxUtteranceMs: settings.voice?.maxUtteranceMs ?? 8000,
          maxUtteranceMsWake: settings.voice?.maxUtteranceMsWake ?? 6000,
          wakeDebounceMs: settings.voice?.wakeDebounceMs ?? 1500,
          accessKey: settings.voice?.porcupineAccessKey ?? '',
          keywordPublicPath: settings.voice?.porcupineKeywordPublicPath ?? '',
          modelPublicPath: settings.voice?.porcupineModelPublicPath ?? '/porcupine/porcupine_params_en.pv',
          keywordLabel: settings.voice?.porcupineKeyword ?? 'numz',
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
      transcriptEl
    },
    config: settings.voice
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
