/**
 * The Smart Camera's vision port: the one place a picture leaves this server, to the vision provider the owner
 * configured. Nothing else in the camera knows which provider that is.
 *
 *   vision = { configured, name, read({ messages, image, signal }) -> string, answer({ messages, image, signal }) -> string }
 *
 * `messages` is a system message and a user message of plain text (see cameraPrompts.js); `image` is { bytes, mimeType }.
 * Both calls are the same request (a text prompt plus a picture, a text reply): `read` and `answer` differ only in the
 * prompt they are given.
 *
 * Configured only when ALL of these are set (the key belongs in .env.secrets, like AI_API_KEY):
 *   CAMERA_VISION_PROVIDER   'openai' | 'anthropic' | 'openai-compatible'
 *   CAMERA_VISION_API_KEY    the provider's key
 *   CAMERA_VISION_MODEL      a model that accepts pictures. There is deliberately no default: it decides what each
 *                            picture costs and how well glare or a moire pattern is read.
 *   CAMERA_VISION_BASE_URL   optional for 'openai' and 'anthropic' (a gateway or proxy); required for 'openai-compatible'
 *   CAMERA_VISION_REASONING_EFFORT   optional, 'openai' only: minimal | low | medium | high. A model that thinks before
 *                            it answers is slower and dearer; reading a question needs little thinking.
 *
 * 'openai' is OpenAI itself and sends the parameters its newer models accept (max_completion_tokens, no temperature:
 * they refuse max_tokens and any temperature but the default). 'openai-compatible' is for any other service that speaks
 * the same protocol (max_tokens, temperature 0).
 *
 * Errors carry the HTTP status and a fixed message, never the provider's own words (they can echo the request or the
 * key). The request shapes below follow the providers' public documentation and are pinned by tests against a fake
 * fetch; they have NOT been exercised against a live provider.
 */

const MAX_REPLY_TOKENS = 1500
const ANTHROPIC_VERSION = '2023-06-01'

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** What the provider says the call used (counts only), for the usage records. */
function usageOf(body, name) {
  const usage = body?.usage
  if (!usage) return null
  return {
    promptTokens: usage.prompt_tokens ?? usage.input_tokens,
    completionTokens: usage.completion_tokens ?? usage.output_tokens,
    model: body.model,
    provider: name
  }
}

function failure(status) {
  return Object.assign(new Error(`The vision service answered ${status}`), { statusCode: status, name: 'VisionError' })
}

function split(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n')
  return { system, user }
}

async function post(fetchFn, url, headers, body, signal) {
  let res
  try {
    res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err
    throw Object.assign(new Error('The vision service could not be reached'), { name: 'VisionError' })
  }
  if (!res.ok) throw failure(res.status)
  try {
    return JSON.parse(await res.text())
  } catch {
    throw Object.assign(new Error('The vision service sent something that was not JSON'), { name: 'VisionError' })
  }
}

function anthropicAdapter({ apiKey, model, baseUrl, fetchFn }) {
  const root = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '')
  async function ask({ messages, image, signal, onUsage }) {
    const { system, user } = split(messages)
    const body = await post(
      fetchFn,
      `${root}/v1/messages`,
      { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      {
        model,
        max_tokens: MAX_REPLY_TOKENS,
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: Buffer.from(image.bytes).toString('base64') } },
              { type: 'text', text: user }
            ]
          }
        ]
      },
      signal
    )
    const reply = (Array.isArray(body?.content) ? body.content : []).filter((block) => block?.type === 'text').map((block) => block.text).join('')
    const used = usageOf(body, 'anthropic')
    if (used) onUsage?.(used)
    if (!text(reply)) throw Object.assign(new Error('The vision service returned no text'), { name: 'VisionError' })
    return reply
  }
  return { name: 'anthropic', read: ask, answer: ask }
}

const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high'])
const OPENAI_REPLY_TOKENS = 4000 // a ceiling that leaves room for a model that thinks first; only what is generated is paid for

function openAiAdapter({ apiKey, model, baseUrl, fetchFn, official = false, reasoningEffort = '' }) {
  const stripped = baseUrl.replace(/\/+$/, '')
  const root = stripped.endsWith('/v1') ? stripped : `${stripped}/v1`
  // OpenAI's newer models refuse max_tokens and any temperature but the default; other services expect the older shape.
  const limits = official
    ? { max_completion_tokens: OPENAI_REPLY_TOKENS, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }
    : { temperature: 0, max_tokens: MAX_REPLY_TOKENS }
  async function ask({ messages, image, signal, onUsage }) {
    const { system, user } = split(messages)
    const body = await post(
      fetchFn,
      `${root}/chat/completions`,
      { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      {
        model,
        ...limits,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: user },
              { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}` } }
            ]
          }
        ]
      },
      signal
    )
    const reply = body?.choices?.[0]?.message?.content
    const used = usageOf(body, official ? 'openai' : 'openai-compatible')
    if (used) onUsage?.(used)
    if (!text(reply)) throw Object.assign(new Error('The vision service returned no text'), { name: 'VisionError' })
    return reply
  }
  return { name: official ? 'openai' : 'openai-compatible', read: ask, answer: ask }
}

export function createUnconfiguredVision(missing = []) {
  return {
    configured: false,
    name: 'none',
    missing,
    async read() {
      throw Object.assign(new Error('Reading pictures is not set up'), { statusCode: 503 })
    },
    async answer() {
      throw Object.assign(new Error('Reading pictures is not set up'), { statusCode: 503 })
    }
  }
}

/** `env` is read once, here. Missing or unknown settings give an unconfigured vision that lists what is missing. */
export function createVisionFromEnv(env = process.env, { fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  const provider = text(env.CAMERA_VISION_PROVIDER).toLowerCase()
  if (!provider) return createUnconfiguredVision(['CAMERA_VISION_PROVIDER'])
  if (!['openai', 'anthropic', 'openai-compatible'].includes(provider)) return createUnconfiguredVision(['CAMERA_VISION_PROVIDER (openai, anthropic or openai-compatible)'])

  const apiKey = text(env.CAMERA_VISION_API_KEY)
  const model = text(env.CAMERA_VISION_MODEL)
  const baseUrl = text(env.CAMERA_VISION_BASE_URL) || (provider === 'openai' ? 'https://api.openai.com' : '')
  const effort = text(env.CAMERA_VISION_REASONING_EFFORT).toLowerCase()
  const missing = []
  if (!apiKey) missing.push('CAMERA_VISION_API_KEY')
  if (!model) missing.push('CAMERA_VISION_MODEL')
  if (provider === 'openai-compatible' && !baseUrl) missing.push('CAMERA_VISION_BASE_URL')
  if (missing.length) return createUnconfiguredVision(missing)

  const adapter =
    provider === 'anthropic'
      ? anthropicAdapter({ apiKey, model, baseUrl, fetchFn })
      : openAiAdapter({ apiKey, model, baseUrl, fetchFn, official: provider === 'openai', reasoningEffort: provider === 'openai' && REASONING_EFFORTS.has(effort) ? effort : '' })
  return { configured: true, missing: [], ...adapter }
}

/** One line for the start-up log: says what is set up or what is missing, never a value. */
export function describeVision(vision) {
  if (vision.configured) return `[camera] pictures are read by the ${vision.name} vision service`
  return vision.missing?.length && !(vision.missing.length === 1 && vision.missing[0] === 'CAMERA_VISION_PROVIDER')
    ? `[camera] Smart Camera is not configured: set ${vision.missing.join(', ')}`
    : '[camera] Smart Camera is not configured (no vision service): the page opens but cannot read pictures'
}
