function createUnsupportedError() {
  return new Error('SpeechSynthesis is not supported in this browser')
}

async function waitForVoices(timeoutMs = 1200) {
  const synth = globalThis?.window?.speechSynthesis
  if (!synth) throw createUnsupportedError()

  const existing = synth.getVoices()
  if (existing?.length) return existing

  await new Promise((resolve) => {
    let done = false

    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve()
    }, timeoutMs)

    synth.onvoiceschanged = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
  })

  return synth.getVoices()
}

function pickVoice(voices, preferredName) {
  if (!preferredName) return null
  const lowered = preferredName.toLowerCase()
  return voices.find((v) => v?.name?.toLowerCase() === lowered) ?? null
}

export function createVoiceOutputSpeechSynthesis() {
  const w = globalThis?.window
  const synth = w?.speechSynthesis ?? null

  /** @type {() => void} */
  let onStart = () => {}
  /** @type {() => void} */
  let onEnd = () => {}
  /** @type {(err: unknown) => void} */
  let onError = () => {}

  return {
    isSupported() {
      return Boolean(synth) && typeof w?.SpeechSynthesisUtterance === 'function'
    },

    setOnStart(fn) {
      onStart = typeof fn === 'function' ? fn : () => {}
    },

    setOnEnd(fn) {
      onEnd = typeof fn === 'function' ? fn : () => {}
    },

    setOnError(fn) {
      onError = typeof fn === 'function' ? fn : () => {}
    },

    cancel() {
      if (!synth) return
      synth.cancel()
    },

    /**
     * @param {string} text
     * @param {{ voiceName?: string, lang?: string, rate?: number, pitch?: number, volume?: number }} opts
     */
    async speak(text, opts = {}) {
      if (!synth || typeof w?.SpeechSynthesisUtterance !== 'function') {
        throw createUnsupportedError()
      }

      const clean = typeof text === 'string' ? text.trim() : ''
      if (!clean) return

      const utter = new w.SpeechSynthesisUtterance(clean)
      if (opts.lang) utter.lang = opts.lang
      if (typeof opts.rate === 'number') utter.rate = opts.rate
      if (typeof opts.pitch === 'number') utter.pitch = opts.pitch
      if (typeof opts.volume === 'number') utter.volume = opts.volume

      try {
        const voices = await waitForVoices()
        const voice = pickVoice(voices, opts.voiceName)
        if (voice) utter.voice = voice
      } catch (err) {
        // Voice enumeration failures shouldn't block speech; proceed with default.
        onError(err)
      }

      return await new Promise((resolve, reject) => {
        utter.onstart = () => {
          try {
            onStart()
          } finally {
            // no-op
          }
        }

        utter.onend = () => {
          try {
            onEnd()
          } finally {
            resolve()
          }
        }

        utter.onerror = (event) => {
          onError(event)
          reject(event)
        }

        try {
          synth.cancel()
          synth.speak(utter)
        } catch (err) {
          onError(err)
          reject(err)
        }
      })
    }
  }
}

