import { parseReading } from './cameraModelOutput.js'
import { buildReadMessages } from './cameraPrompts.js'
import { pictureKind } from './pictureKind.js'
import { validateReading } from './questionIdentity.js'

/**
 * Sends one picture to the configured vision provider, exactly as the camera would, and says what happened in words a
 * person can act on (scripts/camera-vision-check.js prints it). It is how a new key is proved to work without a phone.
 *
 * It never returns the key or any text the provider sent back: a provider's error can echo the request, and the only
 * things reported about a failure are the stage it failed at, its HTTP status and advice written here.
 *
 * -> { ok: true, stage: 'done', provider, ms, question }
 *  | { ok: false, stage: 'configuration' | 'picture' | 'provider' | 'reply' | 'reading', advice, ...details }
 */

const ADVICE_BY_STATUS = [
  [(s) => s === 401 || s === 403, 'The provider rejected the request: check CAMERA_VISION_API_KEY, and that the key may use this model.'],
  [(s) => s === 404, 'The provider does not know this model or address: check CAMERA_VISION_MODEL and CAMERA_VISION_BASE_URL.'],
  [(s) => s === 400, 'The provider refused the request: this model may not accept pictures, the picture may have been too large, or a setting (such as CAMERA_VISION_REASONING_EFFORT) may not be supported by this model. Check CAMERA_VISION_MODEL and remove any optional setting.'],
  [(s) => s === 429, 'The provider says there are too many requests, or the account is out of quota or credit. Wait a little, then check the account.'],
  [(s) => s >= 500, 'The provider had a problem or is overloaded. Try again in a moment.']
]

function adviceForFailure(err, status) {
  if (status !== null) return ADVICE_BY_STATUS.find(([matches]) => matches(status))?.[1] ?? `The provider answered with status ${status}.`
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'The provider did not answer in time. It may be slow or overloaded; try again.'
  return 'The provider could not be reached: check CAMERA_VISION_BASE_URL and the network.'
}

export async function runVisionCheck({ vision, picture, now = Date.now, timeoutMs = 40_000 } = {}) {
  if (!vision?.configured) {
    const missing = vision?.missing ?? []
    // With no provider chosen yet the other settings cannot be known: name them all.
    const everything = !missing.length || missing[0].startsWith('CAMERA_VISION_PROVIDER')
    return {
      ok: false,
      stage: 'configuration',
      missing,
      advice: everything
        ? 'Set CAMERA_VISION_PROVIDER (openai, anthropic or openai-compatible), CAMERA_VISION_API_KEY and CAMERA_VISION_MODEL in .env.secrets (and CAMERA_VISION_BASE_URL for openai-compatible), then restart the server.'
        : `Set ${missing.join(', ')} in .env.secrets, then restart the server.`
    }
  }
  const mimeType = Buffer.isBuffer(picture) ? pictureKind(picture) : null
  if (!mimeType) return { ok: false, stage: 'picture', advice: 'Use a JPEG, PNG or WebP picture.' }

  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    }, timeoutMs)
  })
  const started = now()
  let raw
  try {
    raw = await Promise.race([Promise.resolve().then(() => vision.read({ messages: buildReadMessages(), image: { bytes: picture, mimeType }, signal: controller.signal })), deadline])
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : null
    return { ok: false, stage: 'provider', provider: vision.name, status, advice: adviceForFailure(err, status) }
  } finally {
    clearTimeout(timer)
  }
  const ms = now() - started

  const parsed = parseReading(raw)
  if (!parsed.ok) {
    return { ok: false, stage: 'reply', provider: vision.name, ms, advice: 'The model answered, but not as the JSON the camera expects. Try a stronger model in CAMERA_VISION_MODEL.' }
  }
  const verdict = validateReading(parsed.reading)
  if (!verdict.ok) {
    return {
      ok: false,
      stage: 'reading',
      provider: vision.name,
      ms,
      reading: verdict.status,
      advice: verdict.status === 'not-a-question' ? 'The provider works, but it found no question in that picture. Try a picture of a question.' : 'The provider works, but it could not read the question with confidence. Try a sharper, closer picture.'
    }
  }
  const { text, options, type, subject, confidence, hasDiagram } = parsed.reading
  return { ok: true, stage: 'done', provider: vision.name, ms, question: { text, options, type, subject, confidence, hasDiagram } }
}
