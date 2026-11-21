import { costMicroUsd, estimateTokens } from './pricing.js'
import { quotasFor } from '../auth/rolePolicy.js'

/**
 * Every cost-bearing call goes through here, once: begin() before it (the checks), the handle's finish()/fail() after it (the record).
 *
 *   checks    emergency stop (global or per feature) -> per-minute rate -> concurrent calls (per person and overall)
 *             -> the daily allowance for that kind of call -> spending thresholds (per person, and overall per day / month)
 *   record    one row in ai_usage: who, what kind, which model, tokens / pictures / seconds, an estimated cost, how it ended,
 *             how long it took. Counts and sizes only: never a prompt, a reply, a picture or a sound.
 *   handle    carries an AbortSignal that fires on a time limit, on abort() and when the caller's own signal (a closed browser
 *             connection, an interrupted socket) fires, so a call nobody is waiting for stops costing money.
 *
 * Emergency stop: AI_KILL_SWITCH=on in the environment, or the runtime flags `all`, `chat`, `voice`, `camera`
 * (scripts/ai-admin.js pause|resume, or an administrator in the app). A paused feature answers 503 `ai-paused` before anything is sent.
 */

export class AiLimitError extends Error {
  constructor(statusCode, code, message, { retryAfterSeconds = null } = {}) {
    super(message)
    this.name = 'AiLimitError'
    this.statusCode = statusCode
    this.code = code
    this.expose = true
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export const FEATURE_OF = Object.freeze({
  chat: 'chat',
  stream: 'chat',
  meeting_intel: 'chat',
  stt: 'voice',
  vision_read: 'camera',
  vision_answer: 'camera',
  health_probe: 'admin'
})
const CHAT_KINDS = ['chat', 'stream']
const FEATURES = ['all', 'chat', 'voice', 'camera']

const dayStart = (ms) => new Date(Math.floor(ms / 86_400_000) * 86_400_000).toISOString()
const monthStart = (ms) => {
  const d = new Date(ms)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}
const usd = (micro) => (micro === null || micro === undefined ? null : micro / 1_000_000)

export function createMeter({ database, clock = Date.now, env = process.env, logger = console, timeoutMs = 60_000 } = {}) {
  const insert = database.prepare(
    `INSERT INTO ai_usage (ts, user_id, kind, provider, model, tokens_in, tokens_out, audio_seconds, images, est_cost_micro_usd, status, duration_ms, request_id, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const countSince = database.prepare(`SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND ts >= ? AND kind IN (SELECT value FROM json_each(?))`)
  const secondsSince = database.prepare(`SELECT COALESCE(SUM(audio_seconds), 0) AS s FROM ai_usage WHERE user_id = ? AND ts >= ? AND kind = 'stt'`)
  const costSince = database.prepare(`SELECT COALESCE(SUM(est_cost_micro_usd), 0) AS c FROM ai_usage WHERE ts >= ? AND (? IS NULL OR user_id = ?)`)
  const flagRows = database.prepare(`SELECT key, value FROM ai_runtime_flags`)
  const setFlag = database.prepare(
    `INSERT INTO ai_runtime_flags (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  )

  const recent = new Map() // owner -> timestamps (ms) of calls in the last minute
  const inflight = new Map() // owner -> number
  let inflightAll = 0
  const warned = new Set()
  const limitEnv = (name) => {
    const n = Number.parseFloat(env[name])
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const maxConcurrentAll = () => Math.max(1, Number.parseInt(env.AI_MAX_CONCURRENT ?? '8', 10) || 8)

  function stopped(kind) {
    if (String(env.AI_KILL_SWITCH ?? '').toLowerCase() === 'on') return true
    const on = new Set(flagRows.all().filter((r) => r.value === 'on').map((r) => r.key))
    return on.has('all') || on.has(FEATURE_OF[kind] ?? '')
  }

  function warnOnce(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    logger.warn(`[usage] ${message}`)
  }

  function begin(identity, kind, { requestId = null, conversationId = null, signal: outer = null, timeout = timeoutMs } = {}) {
    if (!(kind in FEATURE_OF)) throw new Error(`unknown usage kind: ${kind}`)
    const owner = identity.ownerKey
    const quotas = quotasFor(identity.role, env)
    const now = clock()
    const since = dayStart(now)

    if (stopped(kind)) throw new AiLimitError(503, 'ai-paused', 'The AI is switched off for now.', { retryAfterSeconds: 60 })

    const stamps = (recent.get(owner) ?? []).filter((t) => now - t < 60_000)
    if (stamps.length >= quotas.perMinute) {
      throw new AiLimitError(429, 'rate-limited', 'That is too many requests in a minute. Wait a little.', { retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - stamps[0])) / 1000)) })
    }
    if ((inflight.get(owner) ?? 0) >= quotas.concurrent) {
      throw new AiLimitError(429, 'too-many-at-once', 'Wait for the answer in progress first.', { retryAfterSeconds: 2 })
    }
    if (inflightAll >= maxConcurrentAll()) throw new AiLimitError(503, 'ai-busy', 'The assistant is busy. Try again in a moment.', { retryAfterSeconds: 5 })

    if (kind === 'chat' || kind === 'stream') {
      if (countSince.get(owner, since, JSON.stringify(CHAT_KINDS)).n >= quotas.chatPerDay) {
        throw new AiLimitError(429, 'daily-limit', 'You have reached the day\'s limit for questions. It resets at midnight UTC.', { retryAfterSeconds: 3600 })
      }
    } else if (kind === 'vision_read') {
      if (countSince.get(owner, since, JSON.stringify(['vision_read'])).n >= quotas.visionPerDay) {
        throw new AiLimitError(429, 'daily-limit', 'You have reached the day\'s limit for camera reads. It resets at midnight UTC.', { retryAfterSeconds: 3600 })
      }
    } else if (kind === 'stt') {
      if (secondsSince.get(owner, since).s >= quotas.sttSecondsPerDay) {
        throw new AiLimitError(429, 'daily-limit', 'You have reached the day\'s limit for speech. It resets at midnight UTC.', { retryAfterSeconds: 3600 })
      }
    }

    const perPerson = limitEnv('AI_DAILY_COST_LIMIT_USD_PER_USER')
    const perDay = limitEnv('AI_DAILY_COST_LIMIT_USD')
    const perMonth = limitEnv('AI_MONTHLY_COST_LIMIT_USD')
    for (const [limit, since2, who, code, status] of [
      [perPerson, since, owner, 'spend-limit', 429],
      [perDay, since, null, 'ai-spend-limit', 503],
      [perMonth, monthStart(now), null, 'ai-spend-limit', 503]
    ]) {
      if (limit === null) continue
      const spent = usd(costSince.get(since2, who, who).c)
      if (spent >= limit) throw new AiLimitError(status, code, 'The spending limit for this period has been reached.', { retryAfterSeconds: 3600 })
      if (spent >= limit * 0.8) warnOnce(`${code}:${who ?? 'all'}:${since2}`, `${who ? 'a person' : 'all users'} have used ${Math.round((spent / limit) * 100)}% of a spending limit`)
    }

    stamps.push(now)
    recent.set(owner, stamps)
    inflight.set(owner, (inflight.get(owner) ?? 0) + 1)
    inflightAll++

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('The model did not answer in time'), { name: 'TimeoutError' })), timeout)
    timer.unref?.()
    const onOuter = () => controller.abort(outer.reason)
    if (outer) outer.aborted ? onOuter() : outer.addEventListener('abort', onOuter, { once: true })

    let settled = false
    const used = { tokensIn: 0, tokensOut: 0, audioSeconds: 0, images: 0, provider: null, model: null }
    const startedAt = now

    function settle(status, extra = {}) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outer?.removeEventListener?.('abort', onOuter)
      inflight.set(owner, Math.max(0, (inflight.get(owner) ?? 1) - 1))
      inflightAll = Math.max(0, inflightAll - 1)
      const finalUsed = { ...used, ...extra }
      try {
        insert.run(
          new Date(clock()).toISOString(),
          owner,
          kind,
          finalUsed.provider,
          finalUsed.model,
          finalUsed.tokensIn,
          finalUsed.tokensOut,
          finalUsed.audioSeconds,
          finalUsed.images,
          costMicroUsd({ kind, ...finalUsed }, env),
          status,
          Math.max(0, clock() - startedAt),
          requestId,
          conversationId
        )
      } catch (err) {
        logger.error('[usage] a call could not be recorded', err?.message ?? err)
      }
    }

    return {
      signal: controller.signal,
      /** Pass to the provider as onUsage: { promptTokens, completionTokens, model, provider }. */
      usage(report = {}) {
        if (Number.isFinite(report.promptTokens)) used.tokensIn = report.promptTokens
        if (Number.isFinite(report.completionTokens)) used.tokensOut = report.completionTokens
        if (report.model) used.model = String(report.model).slice(0, 80)
        if (report.provider) used.provider = String(report.provider).slice(0, 40)
      },
      /** When a provider reported nothing, estimate from sizes (never from the text itself leaving this function). */
      estimate({ inText = '', outText = '' } = {}) {
        if (!used.tokensIn) used.tokensIn = estimateTokens(inText)
        if (!used.tokensOut) used.tokensOut = estimateTokens(outText)
      },
      finish(extra = {}) {
        settle('ok', extra)
      },
      fail(err) {
        const timedOut = err?.name === 'TimeoutError' || controller.signal.reason?.name === 'TimeoutError'
        settle(timedOut ? 'timeout' : outer?.aborted ? 'aborted' : 'error')
      },
      abort(reason) {
        controller.abort(reason)
        settle('aborted')
      }
    }
  }

  function summary(identity) {
    const quotas = quotasFor(identity.role, env)
    const since = dayStart(clock())
    return {
      day: since.slice(0, 10),
      used: {
        chat: countSince.get(identity.ownerKey, since, JSON.stringify(CHAT_KINDS)).n,
        vision: countSince.get(identity.ownerKey, since, JSON.stringify(['vision_read'])).n,
        sttSeconds: Math.round(secondsSince.get(identity.ownerKey, since).s)
      },
      limits: { chat: quotas.chatPerDay, vision: quotas.visionPerDay, sttSeconds: quotas.sttSecondsPerDay, perMinute: quotas.perMinute, concurrent: quotas.concurrent }
    }
  }

  /** Per-person totals for the last `days` days (counts and money only), for administrators. */
  function report(days = 7) {
    const from = new Date(clock() - Math.max(1, Math.min(90, days)) * 86_400_000).toISOString()
    return database
      .prepare(
        `SELECT user_id AS userId, COUNT(*) AS calls,
                SUM(kind IN ('chat','stream')) AS chat, SUM(kind = 'vision_read') AS vision, ROUND(COALESCE(SUM(audio_seconds),0)) AS sttSeconds,
                COALESCE(SUM(tokens_in),0) AS tokensIn, COALESCE(SUM(tokens_out),0) AS tokensOut,
                COALESCE(SUM(est_cost_micro_usd),0) AS costMicroUsd, SUM(status != 'ok') AS notOk
           FROM ai_usage WHERE ts >= ? GROUP BY user_id ORDER BY calls DESC`
      )
      .all(from)
  }

  function flags() {
    return { killSwitchEnv: String(env.AI_KILL_SWITCH ?? '').toLowerCase() === 'on', on: flagRows.all().filter((r) => r.value === 'on').map((r) => r.key) }
  }

  function setPaused(feature, on, by = null) {
    if (!FEATURES.includes(feature)) throw new Error(`feature must be one of ${FEATURES.join(', ')}`)
    setFlag.run(feature, on ? 'on' : 'off', new Date(clock()).toISOString(), by)
  }

  return { begin, summary, report, flags, pause: (feature = 'all', by) => setPaused(feature, true, by), resume: (feature = 'all', by) => setPaused(feature, false, by), FEATURES }
}

/** What a route uses when no meter was supplied (tests of a single route). The server always supplies the real one. */
export const NO_METER = Object.freeze({
  begin(_identity, _kind, { signal } = {}) {
    return { signal: signal ?? new AbortController().signal, usage() {}, estimate() {}, finish() {}, fail() {}, abort() {} }
  }
})
