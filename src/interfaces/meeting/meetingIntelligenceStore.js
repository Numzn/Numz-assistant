import { MeetingApiError } from './meetingApi.js'

/**
 * The ONE copy of a meeting's intelligence in the browser.
 *
 * The meeting panel renders it and NUMZ AI chat answers from it, so the two cannot disagree. It fetches the
 * server's state object (GET .../intelligence/live) with the meeting's own ticket, and nothing else produces
 * findings on this side: the page never derives a decision, a question or an owner by itself.
 *
 *  - Polls while a meeting is open, at a modest rate (slower when the tab is hidden), asking only for changes
 *    (`since`). Failures back off. Polling stops when the meeting is closed and its final record has reached a
 *    terminal state, when the ticket is refused, or when the meeting is forgotten.
 *  - Only one request is ever in flight; a forced refresh joins it.
 *  - What it reports about itself (`error`, `fetchedAt`) is separate from what the server says about the
 *    analysis, so "the server could not update" and "this page could not ask" are never confused.
 */

const TERMINAL_FINAL = new Set(['ready', 'failed', 'withheld', 'empty'])

export function createIntelligenceStore({
  api,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  isHidden = () => globalThis.document?.hidden === true,
  intervalMs = 4000,
  hiddenIntervalMs = 20000,
  closedIntervalMs = 3000,
  maxIntervalMs = 30000,
  onChange = () => {}
} = {}) {
  let tracked = null // { meetingId, ticketToken }
  let data = null
  let error = null
  let fetchedAt = null
  let closed = false
  let timer = null
  let inFlight = null
  let failures = 0
  let kickedFinal = false
  let generation = 0 // a response for a meeting that is no longer tracked is discarded

  const snapshot = () => ({ data, error, fetchedAt, tracking: tracked !== null && timer !== null })

  function emit() {
    onChange(snapshot())
  }

  function finalState() {
    return data?.final?.status ?? null
  }

  function done() {
    return closed && TERMINAL_FINAL.has(finalState())
  }

  function nextDelay() {
    if (failures > 0) return Math.min(maxIntervalMs, intervalMs * 2 ** failures)
    if (closed) return closedIntervalMs
    return isHidden() ? hiddenIntervalMs : intervalMs
  }

  function schedule() {
    if (timer || !tracked || done() || error?.fatal) return
    timer = setTimer(() => {
      timer = null
      pollNow().catch(() => {})
    }, nextDelay())
    timer?.unref?.()
  }

  function adopt(payload) {
    if (payload?.unchanged) return false
    data = payload
    return true
  }

  async function fetchState(call) {
    if (inFlight) return inFlight
    const mine = generation
    const target = tracked
    inFlight = (async () => {
      try {
        const payload = await call(target)
        if (mine !== generation) return data
        const hadError = error !== null
        fetchedAt = now()
        error = null
        failures = 0
        const changed = adopt(payload)
        if (changed || hadError) emit()
        return data
      } catch (err) {
        if (mine !== generation) return data
        const refused = err instanceof MeetingApiError && [401, 403, 404].includes(err.status)
        error = {
          code: err instanceof MeetingApiError ? err.code : 'network',
          message: refused
            ? 'The server no longer accepts this meeting\'s ticket, so its notes cannot be refreshed.'
            : 'Could not reach the server for the meeting notes.',
          at: now(),
          fatal: refused
        }
        if (refused) stop()
        else failures += 1
        emit()
        return data
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  async function pollNow() {
    if (!tracked) return data
    const since = Number.isInteger(data?.revision) ? data.revision : null
    const result = await fetchState((t) => api.intelligence({ meetingId: t.meetingId, ticketToken: t.ticketToken, since }))
    // A meeting that closed before its final record existed (a restart lost it): ask for it once.
    if (closed && !kickedFinal && tracked && ['pending', 'not-started'].includes(finalState() ?? 'pending') && !error) {
      kickedFinal = true
      await refresh()
    }
    schedule()
    return result
  }

  function stop() {
    if (timer) clearTimer(timer)
    timer = null
  }

  async function refresh({ final = false } = {}) {
    if (!tracked) return null
    stop()
    const result = await fetchState((t) =>
      api.refreshIntelligence({ meetingId: t.meetingId, ticketToken: t.ticketToken, final })
    )
    emit()
    schedule()
    return result
  }

  return {
    get: snapshot,

    /** Follow this meeting (and forget any other). Fetches now, then on a schedule. */
    track({ meetingId, ticketToken }) {
      if (tracked?.meetingId === meetingId && tracked.ticketToken === ticketToken) return
      stop()
      generation += 1
      tracked = { meetingId, ticketToken }
      data = null
      error = null
      fetchedAt = null
      closed = false
      failures = 0
      kickedFinal = false
      emit()
      pollNow().catch(() => {})
    },

    /** The meeting has ended: keep going until its final record is settled, then stop. */
    markClosed() {
      if (!tracked) return
      closed = true
      stop()
      pollNow().catch(() => {})
    },

    /** Forget everything (the meeting was discarded, or a new one is starting). */
    untrack() {
      const had = tracked !== null || data !== null || error !== null
      stop()
      generation += 1
      tracked = null
      data = null
      error = null
      fetchedAt = null
      closed = false
      if (had) emit()
    },

    pollNow,
    refresh,

    /** Resolves with the state once the final record is settled (ready, failed, withheld or empty) or time is up. */
    async awaitFinal({ timeoutMs = 60000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
      const started = now()
      closed = true
      while (tracked && now() - started < timeoutMs) {
        await pollNow()
        if (done() || error?.fatal) break
        await sleep(closedIntervalMs)
      }
      return data
    },

    isFinalSettled: done
  }
}
