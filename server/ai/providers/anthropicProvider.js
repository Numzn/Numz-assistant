import Anthropic from '@anthropic-ai/sdk'

/**
 * The chat/notes/study text provider for Claude, through the official Anthropic SDK. It has the same shape as the OpenAI-compatible one
 * (`generate`, `stream`, `onUsage`), so the rest of the server does not know which model answers.
 *
 *   AI_PROVIDER=anthropic
 *   AI_API_KEY        an API key from console.anthropic.com (the Claude subscription does not include one)  -> .env.secrets
 *   AI_MODEL          default claude-opus-5-5; claude-sonnet-5-5 is the faster, cheaper step down
 *   AI_BASE_URL       optional, default https://api.anthropic.com (a gateway or proxy)
 *   AI_EFFORT         low | medium | high | xhigh | max | off     default medium on the Claude 5 models (off sends none)
 *   AI_MAX_TOKENS     the most one reply may use, thinking included    default 64000 (only what is generated is paid for)
 *   AI_FALLBACKS      off to turn off the server-side refusal fallback (on by default for the models that support it)
 */

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'
const DEFAULT_MAX_TOKENS = 64_000
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
/** Models that take `output_config.effort` (the default is only sent to these; an explicit AI_EFFORT is sent to any model). */
const EFFORT_MODELS = /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|opus-4-[678]|sonnet-4-6)/
/** Models the server-side refusal fallback is meant for. A request the model declines is re-run on a fallback inside the same call. */
const FALLBACK_MODELS = /^claude-(?:fable-5|mythos-5|opus-5|sonnet-5-5)/
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const REFUSED = "I can't help with that one."

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** The SDK adds /v1/messages itself, so a base URL may be given with or without /v1. */
function rootUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  return raw || undefined
}

function effortFor(model, setting) {
  const wanted = String(setting ?? '').trim().toLowerCase()
  if (wanted === 'off') return null
  if (EFFORTS.has(wanted)) return wanted
  return EFFORT_MODELS.test(model) ? 'medium' : null
}

const asText = (content) => (typeof content === 'string' ? content : content == null ? '' : String(content))

/**
 * Claude takes the system prompt as its own field, not as a message. Every system message becomes part of it; the rest go in order. The
 * conversation has to start with the person (a leading assistant turn, such as a greeting shown on screen, is left out) and cannot be empty.
 * @param {{ role: string, content: string }[]} messages
 */
export function toAnthropicRequest(messages) {
  const list = Array.isArray(messages) ? messages : []
  const system = list
    .filter((m) => m?.role === 'system')
    .map((m) => asText(m.content).trim())
    .filter(Boolean)
    .join('\n\n')
  const turns = list
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && asText(m.content).trim())
    .map((m) => ({ role: m.role, content: asText(m.content) }))
  while (turns.length && turns[0].role !== 'user') turns.shift()
  if (!turns.length) throw Object.assign(new Error('There is nothing to answer: the request has no message from the person.'), { statusCode: 400 })
  return { system, messages: turns }
}

/**
 * What a failed call means for the person and for the operator. A rejected key must not look like the person's own sign-in expired
 * (a 401 from here would), and the most likely first-day failure, an account with no API credit, deserves its own words.
 */
function explain(err, logger) {
  if (err?.name === 'AbortError') return err
  if (err instanceof Anthropic.APIUserAbortError) return Object.assign(new Error('The request was cancelled'), { name: 'AbortError' })
  if (!(err instanceof Anthropic.APIError) || !Number.isInteger(err.status)) return err
  const detail = String(err.error?.error?.message ?? err.message ?? '').slice(0, 300)
  const refuse = (statusCode, code, message) => {
    logger?.warn?.(`[ai] anthropic ${err.status}: ${detail}`)
    return Object.assign(new Error(message), { statusCode, code, expose: true, cause: err })
  }
  if (err.status === 401 || err.status === 403) return refuse(502, 'ai-provider-rejected', "The AI provider rejected the server's API key.")
  if (err.status === 400 && /credit balance/i.test(detail)) return refuse(503, 'ai-provider-no-credit', 'The AI provider account has no credit left. Add credit and try again.')
  if (err.status === 404) return refuse(502, 'ai-provider-model', `The AI provider does not know that model. ${detail}`.trim())
  if (err.status === 429) {
    const wait = Number.parseFloat(err.headers?.get?.('retry-after'))
    const busy = refuse(429, 'ai-provider-busy', 'The AI provider is busy. Try again in a moment.')
    if (Number.isFinite(wait) && wait > 0) busy.retryAfterSeconds = wait
    return busy
  }
  if (err.status === 529) return refuse(503, 'ai-provider-busy', 'The AI provider is overloaded. Try again in a moment.')
  err.statusCode = err.status
  return err
}

export function createAnthropicProvider({
  apiKey,
  baseUrl,
  model = DEFAULT_ANTHROPIC_MODEL,
  effort,
  maxTokens,
  fallbacks,
  maxRetries, // the SDK's own default (2) unless given
  logger = console
} = {}) {
  const name = 'anthropic'
  const reply = positiveInt(maxTokens, DEFAULT_MAX_TOKENS)
  const level = effortFor(model, effort)
  const useFallbacks = String(fallbacks ?? 'on').toLowerCase() !== 'off' && FALLBACK_MODELS.test(model)
  let client

  function open(messages, signal) {
    if (!apiKey) throw Object.assign(new Error(`${name} provider requires AI_API_KEY in .env.secrets`), { statusCode: 503 })
    if (!model) throw new Error(`${name} provider requires AI_MODEL`)
    const { system, messages: turns } = toAnthropicRequest(messages)
    client ??= new Anthropic({ apiKey, baseURL: rootUrl(baseUrl), ...(maxRetries === undefined ? {} : { maxRetries }) })
    const params = {
      model,
      max_tokens: reply,
      messages: turns,
      ...(system ? { system } : {}),
      ...(level ? { output_config: { effort: level } } : {})
    }
    // Thinking is left to the model (it is on by default for the Claude 5 models and cannot be switched off on Opus 5.5).
    return useFallbacks
      ? client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
      : client.messages.stream(params, { signal })
  }

  /** Counts only: nothing of the text. Cached input is input too. */
  function report(onUsage, message) {
    const used = message?.usage
    if (typeof onUsage !== 'function' || !used) return
    onUsage({
      promptTokens: (used.input_tokens ?? 0) + (used.cache_creation_input_tokens ?? 0) + (used.cache_read_input_tokens ?? 0),
      completionTokens: used.output_tokens ?? 0,
      model: message.model ?? model,
      provider: name
    })
  }

  const textOf = (message) =>
    (Array.isArray(message?.content) ? message.content : [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')

  /** A model that declined and said nothing still has to answer the person with something they can hear. */
  const spoken = (text, message) => (!text.trim() && message?.stop_reason === 'refusal' ? REFUSED : text)

  return {
    name,

    async generate({ messages, signal, onUsage }) {
      const stream = open(messages, signal)
      try {
        const message = await stream.finalMessage()
        report(onUsage, message)
        return spoken(textOf(message), message).trim()
      } catch (err) {
        throw explain(err, logger)
      }
    },

    async *stream({ messages, signal, onUsage }) {
      const stream = open(messages, signal)
      let final = ''
      let finished = false
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            final += event.delta.text
            yield { type: 'token', token: event.delta.text }
          }
        }
        const message = await stream.finalMessage()
        report(onUsage, message)
        final = spoken(final, message)
        finished = true
      } catch (err) {
        throw explain(err, logger)
      } finally {
        // The listener stopped early (the page closed, the answer was cut off): stop paying for tokens nobody reads.
        if (!finished) stream.controller?.abort()
      }
      yield { type: 'message', content: final }
    }
  }
}
