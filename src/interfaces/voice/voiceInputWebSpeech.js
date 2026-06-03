function createUnsupportedError() {
  return new Error('SpeechRecognition is not supported in this browser')
}

function getSpeechRecognitionCtor() {
  const w = globalThis?.window
  if (!w) return null
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * Web Speech API input adapter.
 * - Uses interim results (optional) + final transcript callbacks.
 * - `start()` must be called from a user gesture in most browsers.
 */
export function createVoiceInputWebSpeech({
  lang = 'en-US',
  interimResults = true,
  continuous = true
} = {}) {
  /** @type {(text: string) => void} */
  let onPartial = () => {}
  /** @type {(text: string) => void} */
  let onFinal = () => {}
  /** @type {(err: unknown) => void} */
  let onError = () => {}

  const Ctor = getSpeechRecognitionCtor()
  /** @type {SpeechRecognition | null} */
  let recognition = null
  let active = false
  let lastInterim = ''

  /** Errors where restarting in `onend` will loop or fail immediately (Web Speech uses remote STT for many browsers). */
  function isNonRecoverableError(code) {
    return (
      code === 'network' ||
      code === 'not-allowed' ||
      code === 'service-not-allowed' ||
      code === 'audio-capture'
    )
  }

  function ensure() {
    if (!Ctor) throw createUnsupportedError()
    if (recognition) return recognition

    recognition = new Ctor()
    recognition.lang = lang
    recognition.interimResults = interimResults
    recognition.continuous = continuous

    recognition.onresult = (event) => {
      try {
        let interim = ''
        let finalText = ''

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i]
          const text = res?.[0]?.transcript ?? ''
          if (!text) continue
          if (res.isFinal) finalText += text
          else interim += text
        }

        const interimClean = interim.trim()
        if (interimClean && interimClean !== lastInterim) {
          lastInterim = interimClean
          onPartial(interimClean)
        }

        const finalClean = finalText.trim()
        if (finalClean) {
          lastInterim = ''
          onFinal(finalClean)
        }
      } catch (err) {
        onError(err)
      }
    }

    recognition.onerror = (event) => {
      const code = event?.error ?? ''
      // `stop()` after `active` was cleared often emits `aborted`; do not treat as user-facing failure.
      if (code === 'aborted' && !active) return
      if (isNonRecoverableError(code)) active = false
      onError(event)
    }

    // Some browsers will end recognition automatically after a pause.
    recognition.onend = () => {
      if (!active) return
      // Best-effort restart for a "hold-to-talk" experience where the button
      // stays down; if the browser blocks restart, surface the error upstream.
      try {
        recognition?.start()
      } catch (err) {
        active = false
        onError(err)
      }
    }

    return recognition
  }

  return {
    isSupported() {
      return Boolean(Ctor)
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

    start() {
      const r = ensure()
      if (active) return
      active = true
      lastInterim = ''
      r.lang = lang
      r.interimResults = interimResults
      r.continuous = continuous
      r.start()
    },

    stop() {
      active = false
      lastInterim = ''
      recognition?.stop()
    }
  }
}

