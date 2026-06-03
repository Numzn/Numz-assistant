export const settings = {
  colors: {
    core: 0xd8f0ff,
    coreOuter: 0x4ab8ff,
    background: 0x020617
  },
  assistantVisual: {
    /** Seconds to ease between state visual profiles. */
    stateTransitionSeconds: 0.22,
    /**
     * Production defaults for state-driven behavior.
     * - Colors are in hex (THREE.Color-compatible).
     * - Multipliers modulate the base settings below.
     */
    states: {
      IDLE: {
        coreColor: 0xd8f0ff,
        outerColor: 0x4ab8ff,
        pulseSpeedMult: 1.0,
        pulseStrengthMult: 1.0,
        bloomStrengthMult: 1.0,
        haloOpacityMult: 1.0,
        fieldOpacityMult: 1.0,
        ringOpacityMult: 1.0,
        flareOpacityMult: 1.0
      },
      LISTENING: {
        coreColor: 0xeaffff,
        outerColor: 0x2ff0ff,
        pulseSpeedMult: 1.15,
        pulseStrengthMult: 1.35,
        bloomStrengthMult: 1.12,
        haloOpacityMult: 1.18,
        fieldOpacityMult: 1.12,
        ringOpacityMult: 1.08,
        flareOpacityMult: 1.1
      },
      PROCESSING: {
        coreColor: 0xffffff,
        outerColor: 0x7cc6ff,
        pulseSpeedMult: 1.6,
        pulseStrengthMult: 1.75,
        bloomStrengthMult: 1.28,
        haloOpacityMult: 1.25,
        fieldOpacityMult: 1.2,
        ringOpacityMult: 1.22,
        flareOpacityMult: 1.25
      },
      SPEAKING: {
        coreColor: 0xf6fbff,
        outerColor: 0x6ae4ff,
        pulseSpeedMult: 3.15,
        pulseStrengthMult: 1.55,
        bloomStrengthMult: 1.18,
        haloOpacityMult: 1.1,
        fieldOpacityMult: 1.05,
        ringOpacityMult: 1.35,
        flareOpacityMult: 1.35
      },
      ERROR: {
        coreColor: 0xffeef0,
        outerColor: 0xff3355,
        pulseSpeedMult: 1.85,
        pulseStrengthMult: 1.45,
        bloomStrengthMult: 1.05,
        haloOpacityMult: 1.1,
        fieldOpacityMult: 0.85,
        ringOpacityMult: 1.15,
        flareOpacityMult: 1.05
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
    strength: 0.88,
    radius: 0.52,
    threshold: 0.4,
    resolutionScale: 0.5,
    /** Subtle live variation on bloom strength (fraction, e.g. 0.06 = ±6%). */
    liveModulation: 0.055
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
    flareOpacityBase: 0.66,
    flareOpacitySwing: 0.11
  },
  camera: {
    fov: 40,
    near: 0.1,
    far: 100,
    positionY: 0.18,
    positionZ: 3.95
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
     * - `local`: Porcupine wake + local Python STT (Silero VAD + faster-whisper)
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
    maxUtteranceMs: 8000,
    sttPrompt: 'Proper nouns: NUMZ, NUMZFLEET.',
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
