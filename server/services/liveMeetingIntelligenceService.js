import { MeetingDomainError } from '../meetings/meetingDomain.js'
import { extractSignals } from '../intelligence/meetingSignals.js'
import { groundNotes } from '../intelligence/grounding.js'
import { createRollingIntelligenceTracker } from './rollingIntelligenceService.js'
import { describeTranscript } from './meetingIntelligenceService.js'

/**
 * Live meeting intelligence: the pipeline from a persisted transcript segment to findings a person can read.
 *
 *   persisted segment  ->  that meeting's tracker  ->  (debounced) model update  ->  grounded against the saved
 *   transcript  ->  merged with what the words themselves state  ->  one state object per meeting, read by the
 *   meeting panel and by NUMZ AI chat alike (GET .../intelligence/live).
 *
 * What it guarantees:
 *  - Only segments the canonical store has ACCEPTED are fed in: the feed is the store's own
 *    TranscriptSegmentPersisted event, and a runtime started late loads what is persisted. Nothing here ever sees
 *    audio, partial text or a segment that was refused.
 *  - One runtime per meeting, keyed by meeting id. Nothing is shared between meetings.
 *  - A model failure, a bad answer or a restart loses nothing: the canonical transcript is never written by this
 *    module, and segments that were not merged stay pending and go again.
 *  - Findings are checked against the saved transcript before they are shown (intelligence/grounding.js);
 *    the model's reading is `inferred` at best, only explicit wording is `confirmed`.
 *  - The state says how current it is: when it last succeeded, how many saved lines it has not absorbed yet,
 *    whether an update is running or failing. A stale answer is never presented as current.
 *  - At closure it drains what is pending, and writes the final record only from a VERIFIED transcript.
 *
 * Deliberately in memory: intelligence is derived from the transcript, which is the record. After a restart a
 * meeting's runtime is rebuilt from the saved segments on first use and the model catches up in batches.
 */

const SCHEMA_VERSION = '1.0'

const DEFAULTS = Object.freeze({
  debounceMs: 8_000, // the first pending segment starts a clock; the update runs when it elapses
  flushAtSegments: 12, // ...or at once when this many are waiting
  retryBackoffMs: [15_000, 30_000, 60_000],
  refreshTimeoutMs: 30_000, // how long a forced refresh waits for the model
  finalAttempts: 2,
  maxModelBatch: 60, // segments per model call; a backlog is worked off a batch at a time
  maxSegmentsForFinal: 2000,
  keepFinishedMs: 6 * 60 * 60 * 1000,
  maxRuntimes: 30
})

const OVERLAP_KINDS = new Set(['question', 'actionItem', 'decision'])

function asFinding(signal) {
  return {
    id: signal.id,
    kind: signal.kind,
    text: signal.text,
    status: signal.status,
    basis: signal.basis,
    pattern: signal.pattern,
    source: signal.source,
    evidence: [{ segmentId: signal.source.segmentIds[0], text: signal.text }],
    speaker: signal.speaker ?? null,
    owner: signal.owner ?? undefined,
    due: signal.due ?? undefined,
    caveats: signal.caveats ?? []
  }
}

/** Deterministic findings win over a model's reading of the same line; the rest of the model's are kept. */
function mergeFindings(deterministic, modelItems, kind) {
  const claimed = new Set(deterministic.flatMap((item) => item.source.segmentIds))
  const kept = modelItems.filter(
    (item) => item.kind === kind && !(OVERLAP_KINDS.has(kind) && item.source.segmentIds.some((id) => claimed.has(id)))
  )
  return [...deterministic, ...kept]
}

const byTime = (a, b) => (a.source.start ?? 0) - (b.source.start ?? 0)

function categoryOf(items, category) {
  return items.filter((item) => item.category === category)
}

export function createLiveMeetingIntelligence({
  meetingService,
  eventBus = null,
  generateRolling, // async (messages) => string       (default: the configured AI provider)
  generateFinal, // async ({ segments }) => { notes, parseError? }
  clock = () => Date.now(),
  timers = { setTimeout, clearTimeout },
  logger = console,
  ...options
} = {}) {
  if (!meetingService) throw new Error('meetingService is required')
  const config = { ...DEFAULTS, ...options }
  const runtimes = new Map() // meetingId -> runtime. Never shared between meetings.
  const listeners = []

  function iso(ms) {
    return ms == null ? null : new Date(ms).toISOString()
  }

  function runtimeFor(meetingId) {
    let rt = runtimes.get(meetingId)
    if (rt) {
      rt.touchedAt = clock()
      return rt
    }
    meetingService.getMeeting(meetingId) // 404 for a meeting that does not exist: nothing is created for it
    rt = {
      meetingId,
      tracker: createRollingIntelligenceTracker({
        ...(generateRolling ? { generate: generateRolling } : {}),
        maxBatch: config.maxModelBatch
      }),
      revision: 1,
      grounded: null, // { items, rejected } from the last usable model answer, grounded against the transcript
      lastSuccessAt: null,
      lastAttemptAt: null,
      error: null,
      failures: 0,
      timer: null,
      flushing: null,
      final: null,
      finalizing: null,
      closed: false,
      touchedAt: clock()
    }
    runtimes.set(meetingId, rt)
    evict()
    // Whatever is already persisted (the server restarted mid-meeting, or the first state request came late).
    rt.tracker.ingest(meetingService.getTranscript(meetingId))
    if (rt.tracker.hasPending()) schedule(rt)
    return rt
  }

  function evict() {
    if (runtimes.size <= config.maxRuntimes) return
    const finished = [...runtimes.values()]
      .filter((rt) => rt.closed && !rt.flushing && !rt.finalizing)
      .sort((a, b) => a.touchedAt - b.touchedAt)
    while (runtimes.size > config.maxRuntimes && finished.length) {
      const victim = finished.shift()
      clearTimer(victim)
      runtimes.delete(victim.meetingId)
    }
  }

  function bump(rt) {
    rt.revision += 1
    rt.touchedAt = clock()
  }

  function clearTimer(rt) {
    if (rt.timer) timers.clearTimeout(rt.timer)
    rt.timer = null
  }

  /** The first pending segment starts a clock; later ones do not move it, so latency is bounded under continuous talk. */
  function schedule(rt, delayMs = config.debounceMs) {
    if (rt.timer || rt.closed || rt.flushing) return
    rt.timer = timers.setTimeout(() => {
      rt.timer = null
      flush(rt).catch(() => {})
    }, delayMs)
    rt.timer?.unref?.()
  }

  function backoffFor(failures) {
    const steps = config.retryBackoffMs
    return steps[Math.min(Math.max(failures - 1, 0), steps.length - 1)]
  }

  /** One update, coalesced: callers that arrive while it runs wait for that same update. Never throws. */
  function flush(rt) {
    if (rt.flushing) return rt.flushing
    clearTimer(rt)
    if (!rt.tracker.hasPending()) return Promise.resolve(rt)
    rt.lastAttemptAt = clock()
    bump(rt) // "updating" is a state worth reporting
    rt.flushing = (async () => {
      try {
        const snapshot = await rt.tracker.snapshot()
        // Check the model against what is SAVED, not against what it was handed.
        rt.grounded = groundNotes(snapshot, meetingService.getTranscript(rt.meetingId))
        rt.lastSuccessAt = clock()
        rt.error = null
        rt.failures = 0
      } catch (err) {
        rt.failures += 1
        rt.error = {
          code: err?.code ?? (err?.statusCode === 503 ? 'provider-unavailable' : 'update-failed'),
          message: String(err?.message ?? 'The update failed').slice(0, 200),
          at: iso(clock()),
          attempts: rt.failures
        }
        logger.warn?.(`[live-intelligence] meeting=${rt.meetingId} update failed (${rt.error.code}): ${rt.error.message}`)
      } finally {
        rt.flushing = null
        bump(rt)
      }
      // Failed or not, segments that arrived meanwhile (or came back) are still pending: try again, later.
      if (rt.tracker.hasPending() && !rt.closed) schedule(rt, rt.error ? backoffFor(rt.failures) : config.debounceMs)
      return rt
    })()
    return rt.flushing
  }

  // ---- the feed ----------------------------------------------------------------------------------------

  /** A segment the canonical store has just accepted. Never throws into the persistence path. */
  function onPersisted({ meetingId, segment, status } = {}) {
    try {
      if (!meetingId || !segment || status !== 'INSERTED') return
      const rt = runtimeFor(meetingId)
      if (rt.closed) return
      if (rt.tracker.ingest([segment]) > 0) {
        bump(rt)
        if (rt.tracker.pendingCount() >= config.flushAtSegments) flush(rt).catch(() => {})
        else schedule(rt)
      }
    } catch (err) {
      logger.warn?.(`[live-intelligence] could not take a persisted segment: ${err?.message}`)
    }
  }

  function onClosed({ meetingId, status } = {}) {
    try {
      if (!meetingId) return
      const rt = runtimes.get(meetingId)
      if (status === 'COMPLETED') {
        finalize(meetingId).catch((err) => logger.warn?.(`[live-intelligence] finalize failed: ${err?.message}`))
      } else if (rt && ['FAILED', 'CANCELLED'].includes(status)) {
        rt.closed = true
        clearTimer(rt)
        bump(rt)
      }
    } catch (err) {
      logger.warn?.(`[live-intelligence] close handling failed: ${err?.message}`)
    }
  }

  function subscribe(name, handler) {
    if (eventBus?.on) {
      eventBus.on(name, handler)
      listeners.push([name, handler])
    }
  }
  subscribe('TranscriptSegmentPersisted', onPersisted)
  subscribe('MeetingCompleted', onClosed)
  subscribe('MeetingFailed', onClosed)
  subscribe('MeetingCancelled', onClosed)

  // ---- closing ------------------------------------------------------------------------------------------

  /**
   * Meeting closed: drain what is pending, then write the final record, but only from a verified transcript.
   * Idempotent and coalesced; a failed or withheld final can be asked for again.
   */
  function finalize(meetingId, { force = false } = {}) {
    const rt = runtimeFor(meetingId)
    if (rt.finalizing) return rt.finalizing
    if (rt.final && !force && ['ready', 'withheld', 'empty'].includes(rt.final.status)) return Promise.resolve(rt)
    rt.finalizing = (async () => {
      rt.closed = true
      clearTimer(rt)
      rt.final = { status: 'running', startedAt: iso(clock()) }
      bump(rt)
      try {
        // 1. whatever was persisted but not yet merged is drained (a couple of attempts; a provider outage must not
        //    hang closure). A runtime that never managed an update and has a long backlog (a restart late in the
        //    meeting) is not worked off batch by batch first: the final pass reads the whole transcript anyway, so
        //    that pending work is safely cancelled.
        const worthDraining = rt.lastSuccessAt !== null || rt.tracker.pendingCount() <= config.flushAtSegments
        for (let attempt = 0; worthDraining && attempt < config.finalAttempts && rt.tracker.hasPending(); attempt++) {
          await flush(rt)
        }
        // 2. the transcript's own verdict. Nothing is called verified here unless the existing integrity says so.
        const meeting = meetingService.getMeeting(meetingId)
        const integrity = meetingService.getIntegrity(meetingId)
        const segments = meetingService.getTranscript(meetingId)
        const transcript = describeTranscript(meeting, integrity, segments)
        if (meeting.status !== 'COMPLETED') {
          rt.final = { status: 'withheld', reason: 'meeting-not-completed', at: iso(clock()), transcript }
        } else if (segments.length === 0) {
          rt.final = { status: 'empty', reason: 'no-saved-lines', at: iso(clock()), transcript }
        } else if (transcript.state !== 'verified') {
          rt.final = { status: 'withheld', reason: `transcript-${transcript.state}`, at: iso(clock()), transcript }
        } else if (segments.length > config.maxSegmentsForFinal) {
          rt.final = { status: 'withheld', reason: 'transcript-too-long', at: iso(clock()), transcript }
        } else if (typeof generateFinal !== 'function') {
          rt.final = { status: 'failed', reason: 'final-summary-not-configured', at: iso(clock()), transcript }
        } else {
          const generated = await generateFinal({ schemaVersion: SCHEMA_VERSION, segments })
          if (!generated?.notes) {
            rt.final = {
              status: 'failed',
              reason: 'model-output-unusable',
              detail: String(generated?.parseError ?? 'The model did not return notes in the expected shape.').slice(0, 200),
              at: iso(clock()),
              transcript
            }
          } else {
            const grounded = groundNotes(generated.notes, segments)
            rt.final = {
              status: 'ready',
              at: iso(clock()),
              transcript,
              summary: grounded.summary,
              grounded,
              segments: segments.length
            }
          }
        }
      } catch (err) {
        rt.final = {
          status: 'failed',
          reason: err?.statusCode === 503 ? 'provider-unavailable' : 'final-failed',
          detail: String(err?.message ?? 'The final summary failed').slice(0, 200),
          at: iso(clock())
        }
        logger.warn?.(`[live-intelligence] meeting=${meetingId} final failed: ${rt.final.detail}`)
      } finally {
        rt.finalizing = null
        bump(rt)
      }
      return rt
    })()
    return rt.finalizing
  }

  // ---- reading ------------------------------------------------------------------------------------------

  function analysisOf(rt, transcript) {
    const pending = rt.tracker.pendingCount()
    let status = 'current'
    if (rt.flushing) status = 'updating'
    else if (rt.error && pending > 0) status = 'error'
    else if (pending > 0) status = 'behind'
    else if (transcript.segmentCount === 0) status = 'idle'
    return {
      status,
      lastSuccessAt: iso(rt.lastSuccessAt),
      lastAttemptAt: iso(rt.lastAttemptAt),
      pendingSegments: pending,
      mergedSegments: rt.tracker.mergedCount(),
      error: rt.error,
      nextAttempt: rt.timer ? 'scheduled' : null
    }
  }

  function findingsFor(rt, segments) {
    const signals = extractSignals(segments)
    const items = rt.grounded?.items ?? []
    const decisions = mergeFindings(signals.decisions.map(asFinding), items, 'decision')
    const actionItems = mergeFindings(signals.actionItems.map(asFinding), items, 'actionItem')
    return {
      topics: categoryOf(items, 'currentTopics').sort(byTime),
      decisions: decisions.sort(byTime),
      openQuestions: categoryOf(items, 'openQuestions').sort(byTime),
      questionsAsked: signals.questions.map(asFinding).sort(byTime),
      actionItems: actionItems.sort(byTime),
      notes: categoryOf(items, 'importantPoints').sort(byTime),
      rejected: rt.grounded?.rejected?.length ?? 0
    }
  }

  /**
   * The state of a meeting's intelligence. `since` is a revision the caller already has: nothing is rebuilt or
   * resent when it has not moved.
   */
  function getState(meetingId, { since } = {}) {
    const rt = runtimeFor(meetingId)
    if (Number.isFinite(since) && since === rt.revision) {
      return { schemaVersion: SCHEMA_VERSION, meetingId, revision: rt.revision, unchanged: true }
    }
    const meeting = meetingService.getMeeting(meetingId)
    const integrity = meetingService.getIntegrity(meetingId)
    const segments = meetingService.getTranscript(meetingId)
    const transcript = describeTranscript(meeting, integrity, segments)

    let phase = 'live'
    if (meeting.status === 'COMPLETED') {
      phase = rt.final?.status === 'ready' ? 'final' : rt.final?.status === 'running' || rt.finalizing ? 'closing' : 'closed'
    } else if (['FAILED', 'CANCELLED'].includes(meeting.status)) phase = 'ended'
    else if (['FINALIZING'].includes(meeting.status)) phase = 'closing'

    const analysis = analysisOf(rt, transcript)
    const findings = findingsFor(rt, segments)
    const finalIsReady = rt.final?.status === 'ready'

    const state = {
      schemaVersion: SCHEMA_VERSION,
      meetingId,
      basis: 'saved-canonical-transcript',
      revision: rt.revision,
      generatedAt: iso(clock()),
      phase,
      // Provisional until the meeting is closed AND its transcript verified.
      provisional: !(finalIsReady && transcript.state === 'verified'),
      transcript,
      analysis,
      findings,
      final: rt.final
        ? {
            status: rt.final.status,
            at: rt.final.at ?? rt.final.startedAt ?? null,
            reason: rt.final.reason ?? null,
            detail: rt.final.detail ?? null,
            summary: finalIsReady ? rt.final.summary : null,
            findings: finalIsReady ? finalFindings(rt, segments) : null
          }
        : { status: phase === 'live' ? 'not-started' : 'pending', at: null, reason: null, detail: null, summary: null, findings: null }
    }
    return state
  }

  function finalFindings(rt, segments) {
    const signals = extractSignals(segments)
    const items = rt.final.grounded.items
    return {
      topics: categoryOf(items, 'keyTopics').sort(byTime),
      decisions: mergeFindings(signals.decisions.map(asFinding), categoryOf(items, 'decisions'), 'decision').sort(byTime),
      actionItems: mergeFindings(signals.actionItems.map(asFinding), categoryOf(items, 'actionItems'), 'actionItem').sort(byTime),
      openQuestions: categoryOf(items, 'openQuestions').sort(byTime),
      questionsAsked: signals.questions.map(asFinding).sort(byTime),
      rejected: rt.final.grounded.rejected.length
    }
  }

  /**
   * Update now (an operator or the chat asked). Waits for the model, but only so long: the answer says whether the
   * update finished. For a closed meeting this (re)attempts the final record when it is missing or failed.
   */
  async function refresh(meetingId, { final = false } = {}) {
    const rt = runtimeFor(meetingId)
    const meeting = meetingService.getMeeting(meetingId)
    const wait = (promise) =>
      Promise.race([
        promise,
        new Promise((resolve) => {
          const t = timers.setTimeout(resolve, config.refreshTimeoutMs)
          t?.unref?.()
        })
      ])
    if (meeting.status === 'COMPLETED') {
      const needs = !rt.final || ['failed'].includes(rt.final.status) || final
      if (needs && !rt.finalizing) await wait(finalize(meetingId, { force: true }))
      else if (rt.finalizing) await wait(rt.finalizing)
    } else {
      await wait(flush(rt))
    }
    return getState(meetingId)
  }

  function dispose() {
    for (const [name, handler] of listeners) eventBus?.off?.(name, handler)
    listeners.length = 0
    for (const rt of runtimes.values()) clearTimer(rt)
    runtimes.clear()
  }

  return {
    getState,
    refresh,
    finalize,
    dispose,
    /** For tests and diagnostics. */
    _runtime: (meetingId) => runtimes.get(meetingId) ?? null,
    _onPersisted: onPersisted,
    config
  }
}

export { MeetingDomainError }
