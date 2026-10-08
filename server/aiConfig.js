export function getAiConfig(env = process.env) {
  const provider = (env.AI_PROVIDER ?? 'placeholder').toLowerCase()
  const model = env.AI_MODEL ?? ''
  const baseUrl = env.AI_BASE_URL ?? ''
  const hasApiKey = Boolean(String(env.AI_API_KEY ?? '').trim())

  return {
    provider,
    model,
    baseUrl,
    hasApiKey,
    configured: provider !== 'placeholder' && hasApiKey && Boolean(model) && Boolean(baseUrl)
  }
}

export function logAiConfig(env = process.env) {
  const cfg = getAiConfig(env)
  const keyStatus = cfg.hasApiKey ? 'present' : 'MISSING'
  console.log(
    `[ai] provider=${cfg.provider} model=${cfg.model || '(unset)'} baseUrl=${cfg.baseUrl || '(unset)'} apiKey=${keyStatus} configured=${cfg.configured}`
  )
  if (cfg.provider !== 'placeholder' && !cfg.hasApiKey) {
    console.warn('[ai] Add AI_API_KEY to /srv/projects/Numz-assistant/.env.secrets')
  }
  return cfg
}

export async function probeDeepSeek(env = process.env) {
  const cfg = getAiConfig(env)
  if (!cfg.hasApiKey) {
    return { ok: false, error: 'AI_API_KEY missing in .env.secrets', configured: false }
  }

  const base = String(cfg.baseUrl).replace(/\/$/, '')
  const url = `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`

  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        max_tokens: 16,
        stream: false
      })
    })

    const latencyMs = Date.now() - started
    const text = await res.text()
    let data = {}
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }

    if (!res.ok) {
      return {
        ok: false,
        configured: true,
        status: res.status,
        latencyMs,
        error: data?.error?.message ?? data?.error ?? text
      }
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ??
      data?.choices?.[0]?.text?.trim() ??
      ''

    return {
      ok: true,
      configured: true,
      status: res.status,
      latencyMs,
      model: cfg.model,
      reply
    }
  } catch (err) {
    return {
      ok: false,
      configured: true,
      latencyMs: Date.now() - started,
      error: err?.message ?? String(err)
    }
  }
}
