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

  // Streaming-chunk state (enqueueChunk/beginStream/endStream): chunks queue
  // natively via the browser's speech queue (no cancel() between them, unlike
  // speak()), so a reply can start being heard on its first sentence instead
  // of waiting for the whole thing to finish generating. onStart fires once,
  // for the first chunk; onEnd fires once, after the true last chunk ends.
  let streamChunkCount = 0
  let lastChunkPromise = Promise.resolve()

  /**
   * Shared by speak() and enqueueChunk(): builds the utterance with the given
   * options and preferred voice. Resolves null for empty text; throws if
   * speech synthesis isn't supported.
   */
  async function buildUtterance(text, opts) {
    if (!synth || typeof w?.SpeechSynthesisUtterance !== 'function') {
      throw createUnsupportedError()
    }

    const clean = typeof text === 'string' ? text.trim() : ''
    if (!clean) return null

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

    return utter
  }

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
      streamChunkCount = 0
      lastChunkPromise = Promise.resolve()
    },

    beginStream() {
      streamChunkCount = 0
      lastChunkPromise = Promise.resolve()
    },

    /**
     * Enqueue one chunk (e.g. one sentence) of a streaming reply. Chunks
     * play in order via the browser's native speech queue. Returns a
     * promise that resolves when THIS chunk finishes (callers generally
     * don't need to await it — await endStream() instead).
     * @param {string} text
     * @param {{ voiceName?: string, lang?: string, rate?: number, pitch?: number, volume?: number }} opts
     */
    async enqueueChunk(text, opts = {}) {
      const utter = await buildUtterance(text, opts)
      if (!utter) return

      const isFirst = streamChunkCount === 0
      streamChunkCount++

      const chunkPromise = new Promise((resolve, reject) => {
        utter.onstart = () => {
          if (isFirst) onStart()
        }
        utter.onend = () => resolve()
        utter.onerror = (event) => {
          onError(event)
          reject(event)
        }
        try {
          synth.speak(utter) // no cancel() first — queues after anything already speaking
        } catch (err) {
          onError(err)
          reject(err)
        }
      })
      lastChunkPromise = chunkPromise
      return chunkPromise
    },

    /** Waits for the true last enqueued chunk to finish, then fires onEnd once. */
    async endStream() {
      const finalChunk = lastChunkPromise
      try {
        await finalChunk
      } finally {
        onEnd()
      }
    },

    /**
     * @param {string} text
     * @param {{ voiceName?: string, lang?: string, rate?: number, pitch?: number, volume?: number }} opts
     */
    async speak(text, opts = {}) {
      const utter = await buildUtterance(text, opts)
      if (!utter) return

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

