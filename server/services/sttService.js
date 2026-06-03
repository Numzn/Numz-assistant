async function parseError(res) {
  const text = await res.text().catch(() => '')
  try {
    const data = JSON.parse(text)
    return data?.error?.message ?? data?.error ?? text
  } catch {
    return text || `${res.status} ${res.statusText}`
  }
}

function getEnv(key, env, fallback = '') {
  const val = env?.[key]
  return typeof val === 'string' && val ? val : fallback
}

export function resolveSttBackend({ headerBackend, env = process.env }) {
  const fromHeader = typeof headerBackend === 'string' ? headerBackend.toLowerCase() : ''
  if (fromHeader === 'local' || fromHeader === 'cloud') return fromHeader
  const fromEnv = getEnv('STT_BACKEND', env, 'cloud').toLowerCase()
  return fromEnv === 'local' ? 'local' : 'cloud'
}

/** @type {{ ok: boolean, checkedAt: number, data: Record<string, unknown> } | null} */
let audioHealthCache = null

function getHealthCacheTtlMs(env = process.env) {
  return Number(getEnv('AUDIO_HEALTH_CACHE_MS', env, '30000')) || 30000
}

/**
 * Check local Python audio sidecar health (cached).
 */
export async function checkAudioServiceHealth({ env = process.env, force = false } = {}) {
  const ttl = getHealthCacheTtlMs(env)
  const now = Date.now()
  if (!force && audioHealthCache && now - audioHealthCache.checkedAt < ttl) {
    return { ...audioHealthCache.data, cached: true }
  }
  const baseUrl = getEnv('AUDIO_SERVICE_URL', env, 'http://127.0.0.1:8765').replace(
    /\/$/,
    ''
  )
  const timeoutMs = Number(getEnv('AUDIO_SERVICE_TIMEOUT_MS', env, '5000')) || 5000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal })
    if (!res.ok) {
      const fail = { ok: false, error: `Health check failed: ${res.status}` }
      audioHealthCache = { ok: false, checkedAt: now, data: fail }
      return fail
    }
    const data = await res.json().catch(() => ({}))
    const result = { ok: Boolean(data?.ok), ...data, cached: false }
    audioHealthCache = { ok: result.ok, checkedAt: now, data: result }
    return result
  } catch (err) {
    const fail = {
      ok: false,
      error: err?.name === 'AbortError' ? 'Audio service timeout' : err?.message ?? 'Unreachable',
      cached: false
    }
    audioHealthCache = { ok: false, checkedAt: now, data: fail }
    return fail
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Local STT via Python sidecar (Silero VAD + faster-whisper).
 */
export async function transcribeAudioLocal({
  audioBuffer,
  mimeType,
  language,
  prompt,
  env = process.env
}) {
  const baseUrl = getEnv('AUDIO_SERVICE_URL', env, 'http://127.0.0.1:8765').replace(
    /\/$/,
    ''
  )
  const timeoutMs = Number(getEnv('AUDIO_SERVICE_TIMEOUT_MS', env, '30000')) || 30000

  const health = await checkAudioServiceHealth({ env })
  if (!health.ok) {
    const err = new Error(health.error ?? 'Audio service offline — run npm run dev:audio')
    err.code = 'audio-service-offline'
    throw err
  }

  const safeMime = mimeType && typeof mimeType === 'string' ? mimeType : 'audio/webm'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${baseUrl}/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': safeMime,
        'X-Stt-Lang': language ? String(language) : '',
        'X-Stt-Prompt': prompt ? String(prompt) : ''
      },
      body: audioBuffer,
      signal: controller.signal
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error ?? `Local STT failed: ${res.status}`)
    }

    if (data?.error === 'no-speech') {
      const err = new Error('no-speech')
      err.code = 'no-speech'
      throw err
    }

    const text = typeof data?.text === 'string' ? data.text.trim() : ''
    return {
      text,
      metrics: {
        durationMs: data?.durationMs,
        vadTrimmedMs: data?.vadTrimmedMs,
        vadMs: data?.vadMs,
        whisperMs: data?.whisperMs,
        elapsedMs: data?.elapsedMs
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cloud STT using an OpenAI-compatible endpoint.
 */
export async function transcribeAudioCloud({
  audioBuffer,
  mimeType,
  language,
  prompt,
  env = process.env
}) {
  const apiKey = getEnv('STT_API_KEY', env, getEnv('AI_API_KEY', env))
  const baseUrl = getEnv('STT_BASE_URL', env, getEnv('AI_BASE_URL', env, 'https://api.openai.com/v1'))
  const model = getEnv('STT_MODEL', env, 'whisper-1')

  if (!apiKey) throw new Error('STT requires STT_API_KEY (or AI_API_KEY)')
  if (!baseUrl) throw new Error('STT requires STT_BASE_URL (or AI_BASE_URL)')

  const normalizedBaseUrl = String(baseUrl).replace(/\/$/, '')
  const safeMime = mimeType && typeof mimeType === 'string' ? mimeType : 'audio/webm'
  const blob = new Blob([audioBuffer], { type: safeMime })

  const form = new FormData()
  form.set('file', blob, 'audio.webm')
  form.set('model', model)
  if (language) form.set('language', String(language))
  if (prompt) form.set('prompt', String(prompt))

  const res = await fetch(`${normalizedBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  })

  if (!res.ok) {
    throw new Error(await parseError(res))
  }

  const data = await res.json().catch(() => ({}))
  const text = data?.text
  return typeof text === 'string' ? text.trim() : ''
}

/**
 * Route to local or cloud STT based on STT_BACKEND env or x-stt-backend header.
 */
export async function transcribeAudio({
  audioBuffer,
  mimeType,
  language,
  prompt,
  backend,
  env = process.env
}) {
  const resolved = resolveSttBackend({ headerBackend: backend, env })
  if (resolved === 'local') {
    const result = await transcribeAudioLocal({ audioBuffer, mimeType, language, prompt, env })
    return result.text
  }
  return transcribeAudioCloud({ audioBuffer, mimeType, language, prompt, env })
}

/**
 * Local STT with timing metrics (for routes / debugging).
 */
export async function transcribeAudioLocalWithMetrics(opts) {
  return transcribeAudioLocal(opts)
}
