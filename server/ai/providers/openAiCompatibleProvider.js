import { parseError } from '../../utils/http.js'

function getChoiceText(data) {
  return data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? ''
}

function getDeltaText(data) {
  return data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.text ?? ''
}

function normalizeOpenAiCompatibleBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return ''

  const withoutTrailingSlash = raw.replace(/\/$/, '')
  // Accept both:
  // - https://api.deepseek.com
  // - https://api.deepseek.com/v1
  // and normalize to the OpenAI-compatible root that contains `/v1`.
  return withoutTrailingSlash.endsWith('/v1') ? withoutTrailingSlash : `${withoutTrailingSlash}/v1`
}

export function createOpenAiCompatibleProvider({
  name,
  apiKey,
  baseUrl,
  model,
  defaultHeaders = {},
  streamUsage = true // ask for token counts in the last streamed chunk (OpenAI-compatible `stream_options.include_usage`)
}) {
  const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(baseUrl)

  function assertConfigured() {
    if (!apiKey) {
      const err = new Error(`${name} provider requires AI_API_KEY in .env.secrets`)
      err.statusCode = 503
      throw err
    }
    if (!normalizedBaseUrl) throw new Error(`${name} provider requires AI_BASE_URL`)
    if (!model) throw new Error(`${name} provider requires AI_MODEL`)
  }

  /** Tells the caller (the usage meter) what the provider says the call used. Counts only: nothing of the text. */
  function report(onUsage, data) {
    if (typeof onUsage !== 'function' || !data?.usage) return
    onUsage({
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      model: data.model ?? model,
      provider: name
    })
  }

  async function requestChat({ messages, stream = false, signal }) {
    assertConfigured()
    const res = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...defaultHeaders
      },
      body: JSON.stringify({
        model,
        messages,
        stream,
        ...(stream && streamUsage ? { stream_options: { include_usage: true } } : {})
      }),
      signal
    })

    if (!res.ok) {
      const err = new Error(await parseError(res))
      err.statusCode = res.status
      throw err
    }

    return res
  }

  return {
    name,

    async generate({ messages, signal, onUsage }) {
      const res = await requestChat({ messages, signal })
      const data = await res.json()
      report(onUsage, data)
      return getChoiceText(data).trim()
    },

    async *stream({ messages, signal, onUsage }) {
      const res = await requestChat({ messages, stream: true, signal })
      // A service that ignores `stream: true` and answers with one ordinary completion is read as one piece (the whole answer, no words before it).
      // This is decided before the body is taken up as a stream: a body that has a reader cannot also be read as text.
      if (/application\/json/i.test(String(res.headers?.get?.('content-type') ?? ''))) {
        const text = await res.text()
        let content = text
        try {
          const data = JSON.parse(text)
          report(onUsage, data)
          content = getChoiceText(data).trim()
        } catch {
          /* not a completion after all: what it said is passed on as it is */
        }
        yield { type: 'message', content }
        return
      }
      const reader = res.body?.getReader()
      if (!reader) {
        const content = await res.text()
        yield { type: 'message', content }
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let final = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const clean = line.trim()
          if (!clean || !clean.startsWith('data:')) continue
          const payload = clean.slice(5).trim()
          if (payload === '[DONE]') {
            yield { type: 'message', content: final }
            return
          }

          try {
            const data = JSON.parse(payload)
            report(onUsage, data)
            const token = getDeltaText(data)
            if (token) {
              final += token
              yield { type: 'token', token }
            }
          } catch {
            // Ignore malformed provider keepalive chunks.
          }
        }
      }

      yield { type: 'message', content: final }
    }
  }
}
