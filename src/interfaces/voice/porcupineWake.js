import { PorcupineWorker } from '@picovoice/porcupine-web'
import { WebVoiceProcessor } from '@picovoice/web-voice-processor'

/**
 * Thin Porcupine wake-word wrapper (browser, always-on mic via WebVoiceProcessor).
 */
export function createPorcupineWake({
  accessKey = '',
  keywordPublicPath = '',
  modelPublicPath = '/porcupine/porcupine_params_en.pv',
  keywordLabel = 'numz',
  sensitivity = 0.55,
  wakeDebounceMs = 1500,
  onWake = () => {}
} = {}) {
  /** @type {import('@picovoice/porcupine-web').PorcupineWorker | null} */
  let porcupine = null
  let armed = false
  let paused = false
  let lastWakeAt = 0

  function isConfigured() {
    return Boolean(String(accessKey ?? '').trim())
  }

  function isSupported() {
    return (
      isConfigured() &&
      typeof PorcupineWorker?.create === 'function' &&
      typeof WebVoiceProcessor?.subscribe === 'function'
    )
  }

  async function ensureEngine() {
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
        await WebVoiceProcessor.subscribe(engine)
        armed = true
        paused = false
      }
      return true
    },

    async disarm() {
      armed = false
      paused = false
      if (porcupine) {
        try {
          await WebVoiceProcessor.unsubscribe(porcupine)
        } catch {
          /* ignore */
        }
      }
    },

    async pause() {
      paused = true
      try {
        await WebVoiceProcessor.reset()
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
    }
  }
}
