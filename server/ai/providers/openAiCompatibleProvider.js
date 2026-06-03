function getChoiceText(data) {
  return data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? ''
}

function getDeltaText(data) {
  return data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.text ?? ''
}

async function parseError(res) {
  const text = await res.text().catch(() => '')
  try {
    const data = JSON.parse(text)
    return data?.error?.message ?? data?.error ?? text
  } catch {
    return text || `${res.status} ${res.statusText}`
  }
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
  defaultHeaders = {}
}) {
  const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(baseUrl)

  function assertConfigured() {
    if (!apiKey) throw new Error(`${name} provider requires AI_API_KEY`)
    if (!normalizedBaseUrl) throw new Error(`${name} provider requires AI_BASE_URL`)
    if (!model) throw new Error(`${name} provider requires AI_MODEL`)
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
        stream
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

    async generate({ messages, signal }) {
      const res = await requestChat({ messages, signal })
      const data = await res.json()
      return getChoiceText(data).trim()
    },

    async *stream({ messages, signal }) {
      const res = await requestChat({ messages, stream: true, signal })
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
