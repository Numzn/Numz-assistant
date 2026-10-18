/**
 * Thin Porcupine wake-word wrapper (browser, always-on mic via WebVoiceProcessor).
 *
 * The SDK (about 1.1 MB) is fetched the first time the wake word is armed, never at page load, and never at
 * all when no access key is configured (isConfigured/isSupported need nothing from it).
 */
const defaultLoadSdk = () => import('./porcupineSdk.js')

export function createPorcupineWake({
  accessKey = '',
  keywordPublicPath = '',
  modelPublicPath = '/porcupine/porcupine_params_en.pv',
  keywordLabel = 'numz',
  sensitivity = 0.55,
  wakeDebounceMs = 1500,
  onWake = () => {},
  loadSdk = defaultLoadSdk
} = {}) {
  /** @type {import('@picovoice/porcupine-web').PorcupineWorker | null} */
  let porcupine = null
  let armed = false
  let paused = false
  let lastWakeAt = 0
  /** @type {Promise<{ PorcupineWorker: any, WebVoiceProcessor: any }> | null} */
  let sdkPromise = null
  /** The SDK once it has loaded; null before that (and nothing to undo then). */
  let sdk = null
  /** @type {Promise<any> | null} */
  let enginePromise = null

  function isConfigured() {
    return Boolean(String(accessKey ?? '').trim())
  }

  // The SDK needs WebAssembly and workers. Whether it will load is only known by trying, in arm().
  function isSupported() {
    return isConfigured() && typeof globalThis.WebAssembly === 'object' && typeof globalThis.Worker === 'function'
  }

  /** One load, shared by concurrent callers; a failed load is forgotten so a later arm() can try again. */
  function loadEngineSdk() {
    if (!sdkPromise) {
      sdkPromise = Promise.resolve()
        .then(() => loadSdk())
        .then((loaded) => {
          sdk = loaded
          return loaded
        })
        .catch((err) => {
          sdkPromise = null
          throw err
        })
    }
    return sdkPromise
  }

  /** One engine, however many arm() calls overlap (the SDK load makes the gap between them wider). */
  function ensureEngine() {
    if (!enginePromise) {
      enginePromise = createEngine().catch((err) => {
        enginePromise = null
        throw err
      })
    }
    return enginePromise
  }

  async function createEngine() {
    if (porcupine) return porcupine
    if (!isSupported()) {
      throw new Error('Porcupine not configured — set VITE_PICOVOICE_ACCESS_KEY and keyword assets')
    }

    const keywordPath = String(keywordPublicPath ?? '').trim()
    if (!keywordPath) {
      throw new Error(
        'Missing VITE_PORCUPINE_KEYWORD_PUBLIC_PATH — add .ppn from Picovoice Console to public/porcupine/'
      )
    }

    const porcupineModel = {
      publicPath: modelPublicPath,
      customWritePath: 'porcupine_model'
    }

    const keywordModel = {
      publicPath: keywordPath,
      label: keywordLabel,
      sensitivity
    }

    const { PorcupineWorker } = await loadEngineSdk()
    porcupine = await PorcupineWorker.create(
      accessKey,
      [keywordModel],
      () => {
        if (!armed || paused) return
        const now = Date.now()
        if (now - lastWakeAt < wakeDebounceMs) return
        lastWakeAt = now
        onWake({ keyword: keywordLabel, timestamp: now })
      },
      porcupineModel
    )

    return porcupine
  }

  return {
    isConfigured,
    isSupported,

    async arm() {
      if (!isSupported()) return false
      const engine = await ensureEngine()
      if (!armed) {
        // Marked before the await so an overlapping arm() does not subscribe the engine a second time.
        armed = true
        paused = false
        try {
          await sdk.WebVoiceProcessor.subscribe(engine)
        } catch (err) {
          armed = false
          throw err
        }
      }
      return true
    },

    async disarm() {
      armed = false
      paused = false
      if (porcupine && sdk) {
        try {
          await sdk.WebVoiceProcessor.unsubscribe(porcupine)
        } catch {
          /* ignore */
        }
      }
    },

    async pause() {
      paused = true
      if (!sdk) return // never armed: nothing is listening
      try {
        await sdk.WebVoiceProcessor.reset()
      } catch {
        /* ignore */
      }
    },

    async resume() {
      if (!armed) return
      paused = false
    },

    async release() {
      await this.disarm()
      if (porcupine) {
        try {
          porcupine.terminate()
        } catch {
          /* ignore */
        }
        porcupine = null
      }
      enginePromise = null
    }
  }
}
