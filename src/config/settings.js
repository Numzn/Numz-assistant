export const settings = {
  colors: {
    // A quiet steel blue on charcoal. The earlier cyan glow on navy read as neon.
    core: 0xdfe6ee,
    coreOuter: 0x9fb6cf,
    // Tone mapping darkens what the scene draws: this renders as the charcoal (#212121) of the Home screen.
    background: 0x333333
  },
  assistantVisual: {
    /** Seconds to ease between state visual profiles. */
    stateTransitionSeconds: 0.35,
    /**
     * State-driven look. Colours are hex (THREE.Color); multipliers modulate the base settings below.
     * Deliberately close to one another: the state is told in words too, and the orb should stay calm.
     */
    states: {
      IDLE: {
        coreColor: 0xdfe6ee,
        outerColor: 0x9fb6cf,
        pulseSpeedMult: 1.0,
        pulseStrengthMult: 1.0,
        bloomStrengthMult: 1.0,
        haloOpacityMult: 1.0,
        fieldOpacityMult: 1.0,
        ringOpacityMult: 1.0,
        flareOpacityMult: 1.0
      },
      LISTENING: {
        coreColor: 0xeef3f8,
        outerColor: 0x9cc4e4,
        pulseSpeedMult: 1.1,
        pulseStrengthMult: 1.3,
        bloomStrengthMult: 1.05,
        haloOpacityMult: 1.1,
        fieldOpacityMult: 1.1,
        ringOpacityMult: 1.05,
        flareOpacityMult: 1.05
      },
      PROCESSING: {
        coreColor: 0xf4f6f8,
        outerColor: 0xb7c4d6,
        pulseSpeedMult: 1.5,
        pulseStrengthMult: 1.5,
        bloomStrengthMult: 1.08,
        haloOpacityMult: 1.12,
        fieldOpacityMult: 1.1,
        ringOpacityMult: 1.15,
        flareOpacityMult: 1.1
      },
      SPEAKING: {
        coreColor: 0xf4f8fb,
        outerColor: 0xa9d2ea,
        pulseSpeedMult: 2.4,
        pulseStrengthMult: 1.4,
        bloomStrengthMult: 1.08,
        haloOpacityMult: 1.08,
        fieldOpacityMult: 1.05,
        ringOpacityMult: 1.2,
        flareOpacityMult: 1.15
      },
      ERROR: {
        coreColor: 0xf3e9e9,
        outerColor: 0xd49a9a,
        pulseSpeedMult: 1.4,
        pulseStrengthMult: 1.2,
        bloomStrengthMult: 1.0,
        haloOpacityMult: 1.05,
        fieldOpacityMult: 0.9,
        ringOpacityMult: 1.1,
        flareOpacityMult: 1.0
      }
    }
  },
  core: {
    radius: 0.13,
    haloScale: 1.6,
    haloOpacity: 0.24,
    pulseSpeed: 1.25,
    pulseStrength: 0.038,
    /** Halo opacity breathes slightly around this base (animator). */
    haloLiveDepth: 0.12
  },
  bloom: {
    // Barely there: enough to soften the edge of the orb, not to glow.
    strength: 0.3,
    radius: 0.4,
    threshold: 0.55,
    resolutionScale: 0.5,
    /** Subtle live variation on bloom strength (fraction, e.g. 0.06 = ±6%). */
    liveModulation: 0.03
  },
  animation: {
    rotationSpeed: 0.072,
    floatAmplitude: 0.026,
    floatSpeed: 0.85,
    /** Blend two sine waves for organic scale (0 = single sine, 1 = equal mix). */
    pulseOrganicBlend: 0.42,
    /** Second wave is pulseSpeed * this factor. */
    pulseSecondaryFactor: 0.58,
    flareSlowHz: 0.52,
    flareFastHz: 1.28,
    flareOpacityBase: 0.4,
    flareOpacitySwing: 0.06
  },
  camera: {
    fov: 40,
    near: 0.1,
    far: 100,
    positionY: 0.18,
    // Closer than before: the orb is the subject of voice mode, the only place it is drawn.
    positionZ: 2.45
  },
  renderer: {
    antialias: true,
    alpha: false,
    maxPixelRatio: 1.75,
    opaqueClearAlpha: 1,
    toneMappingExposure: 0.94
  },
  voice: {
    enabled: true,
    lang: 'en-US',
    /**
     * Audio pipeline:
     * - `local`: Porcupine wake + local Python STT (Whisper VAD + faster-whisper)
     * - `legacy`: Web Speech and/or cloud STT (previous behavior)
     */
    audioMode: 'local',
    /**
     * STT mode (legacy path only when audioMode is `legacy`):
     * - `webspeech`: browser SpeechRecognition
     * - `server`: POST audio to `/api/v1/assistant/stt`
     */
    sttMode: 'server',
    sttBackend: 'local',
    maxUtteranceMs: 12000,
    // One plain sentence. Whisper imitates its prompt, so a comma-separated keyword list made it answer
    // in comma-separated single words and repeat list words ("NUMZ, NUMZ, NUMZ...").
    sttPrompt:
      'Numz is a helpful personal voice assistant. The user may ask about the fleet: vehicles, trackers, speed, fuel, location, maintenance, alerts and notifications.',
    /**
     * Phase 1 continuous conversation (ChatGPT Voice style):
     * - `conversationMode`: enable hands-free listen -> respond -> listen loop
     * - `autoStartOnLoad`: begin the loop automatically once the page is ready
     * - `hideHoldToTalkButton`: hide the legacy hold-to-talk mic button
     */
    conversationMode: true,
    // The microphone is only opened when the user starts voice mode (a permission prompt on page load, and
    // a hot microphone nobody asked for, do not belong on a quiet Home screen).
    autoStartOnLoad: false,
    hideHoldToTalkButton: true,
    /** Client-side energy VAD tuning (browser AnalyserNode RMS). */
    vadSilenceMs: 1800,
    /** Minimum RMS floor; adaptive noise tracking sits above this. */
    vadEnergyThreshold: 0.02,
    vadMinSpeechMs: 250,
    /** Minimum MediaRecorder duration before silence can end an utterance. */
    minRecordingMs: 2000,
    /** Speech must exceed noise floor by this ratio (or min delta). */
    vadSpeechRatio: 2.2,
    vadSpeechMinDelta: 0.012,
    /** During capture, RMS below peak * this ratio counts as silence. */
    vadSilenceRatio: 0.42,
    /** Pause new triggers after an utterance ends (ms). */
    vadCooldownMs: 1200,
    vadBargeInMinMs: 600,
    vadBargeInThreshold: 0.04,
    /**
     * The assistant hearing itself. Its voice leaves the speakers and reaches the microphone, and browser echo
     * cancellation is not guaranteed for speech synthesis. These are conservative starting points, not measured
     * values: tune them on the real device (docs/voice-self-echo.md).
     * - Wait this long after the assistant stops before listening again (its last words are still in the room).
     */
    vadPostSpeechSettleMs: 700,
    /** - The same after it was cut off by an interruption: shorter, the person is already talking. */
    vadBargeInSettleMs: 150,
    /** - An interruption must be this many times louder than the assistant's own voice in the microphone. */
    vadBargeInEchoRatio: 1.8,
    /** - The first part of each reply is spent measuring that loudness; nothing counts as an interruption then. */
    vadBargeInGuardMs: 500,
    vadIdleTimeoutMs: 30000,
    latencyAuditEnabled: true,
    porcupineKeyword: 'numz',
    porcupineAccessKey: import.meta.env.VITE_PICOVOICE_ACCESS_KEY ?? '',
    porcupineKeywordPublicPath: import.meta.env.VITE_PORCUPINE_KEYWORD_PUBLIC_PATH ?? '',
    porcupineModelPublicPath:
      import.meta.env.VITE_PORCUPINE_MODEL_PUBLIC_PATH ?? '/porcupine/porcupine_params_en.pv',
    wakePhrases: ['numz', 'hello numz', 'hi numz'],
    debugTiming: import.meta.env.DEV,
    debugOverlay: false,
    wakeDebounceMs: 1500,
    maxUtteranceMsWake: 6000,
    ttsVoiceName: '',
    ttsRate: 1,
    ttsPitch: 1,
    ttsVolume: 1
  }
}
