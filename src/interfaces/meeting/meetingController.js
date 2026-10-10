import { MeetingApiError } from './meetingApi.js'
import { normalizeCaptureMode } from '../voice/captureSources.js'
import { createIntelligenceStore } from './meetingIntelligenceStore.js'

/**
 * The browser's meeting flow as a small state machine, with no DOM and no globals, so it can be tested.
 *
 *   idle -> launching -> connecting -> live -> stopping -> ending -> done
 *                           |            |                   |
 *                           +---- problem (reconnect / try again / end) ----+
 *   unfinished (a meeting left open by an earlier page load) -> ending -> done
 *
 * The flow, in plain words: ask the server to start a meeting (launch code in, meeting and ticket out),
 * stream the microphone to the speech service through the relay with that ticket, show every line with
 * whether it was saved, and when the user stops, end the meeting and report what the server verified.
 *
 * Ending is retried for a short while on purpose: right after stopping, the speech service may still be
 * closing its session or delivering the last line, and the server refuses to end (409) until that is done.
 */

/** Must match server/websocket/liveSpeechRelay.js: the relay accepts a ticket only as [TICKET_PROTOCOL, token]. */
export const TICKET_PROTOCOL = 'numz.meeting-ticket.v1'
export const LIVE_SPEECH_PATH = '/api/v1/live-speech'

const MAX_LINES = 500
const DEFAULT_RETRY_DELAYS_MS = [1500, 2000, 3000, 4000, 5000, 5000]
const RETRYABLE_END = new Set(['speech-session-active', 'transcript-incomplete'])

/**
 * Error frames from the speech service that concern ONE line or ONE piece of audio. The service keeps (or
 * quarantines) what it could not deliver and carries on, so the recording must too: stopping the microphone
 * because a single line was refused would lose everything said afterwards. Anything not listed here, and
 * anything with no code at all (the connection dropped, the microphone failed), ends the recording.
 */
const RECOVERABLE_CODES = new Map([
  ['segment-rejected', 'A line was refused by the server and is not saved.'],
  ['persistence-failure', 'A line could not be saved yet; the speech service keeps it and will retry.'],
  ['asr-failure', 'The recognizer failed on a piece of audio.'],
  ['outbox-unavailable', 'The speech service could not keep a line on disk and holds it in memory only.'],
  ['finalize-failure', 'The last piece of speech could not be finished.'],
  ['transcript-invalid', 'The summary of the session could not be built; its lines were saved one by one.'],
  ['malformed-audio', 'A damaged piece of audio was skipped.']
])
const SAVED = new Set(['INSERTED', 'ALREADY_EXISTS'])
const RECORDING_OK = 'Recording. Each line is saved as you speak.'
const NOT_RECORDING = new Set(['ended', 'unavailable'])
const BUSY = new Set(['launching', 'connecting', 'live', 'stopping', 'ending'])

function emptyState() {
  return {
    phase: 'idle', // idle | launching | connecting | live | stopping | ending | done | problem | unfinished
    open: false, // a meeting exists on the server that this page has not finished
    meetingId: null,
    title: '',
    partial: '',
    lines: [], // { key, text, start, end, persisted } (the newest MAX_LINES)
    counts: { saved: 0, waiting: 0, notSaved: 0 },
    message: '',
    tone: 'info', // info | ok | warn | error
    canReconnect: false,
    canEnd: false,
    canDiscard: false,
    capture: 'microphone', // microphone | tab | both: where this meeting's audio comes from
    sources: [], // [{ id, label, state, detail }] what each source is doing (see captureSources.js)
    droppedSeconds: 0, // audio the connection could not carry; missing from the transcript
    launchReady: false, // the server accepts a start from this browser without the code being typed again
    intelligence: null, // the server's live intelligence state for this meeting (see meetingIntelligenceStore.js)
    intelligenceError: null, // this page could not get it (separate from what the server says about the analysis)
    result: null // { verified, storedSegments, unverifiedSessions } once done
  }
}

/** A key of 16 to 64 letters, digits, "_" and "-" (what the server's Idempotency-Key accepts). */
function randomLaunchKey() {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return `k${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** What a person needs to know about the sources, or '' when there is nothing to say (a quiet pause is not news). */
function describeSources(list) {
  const lost = list.filter((source) => NOT_RECORDING.has(source.state))
  const running = list.filter((source) => !NOT_RECORDING.has(source.state))
  const parts = []
  if (lost.length) {
    const what = lost.map((source) => `${source.label} is NOT being recorded${source.detail ? ` (${source.detail})` : ''}`)
    parts.push(
      `${what.join('. ')}.` +
        (running.length ? ` Recording continues from ${running.map((source) => source.label).join(' and ')}.` : '')
    )
  }
  for (const source of running.filter((entry) => entry.state === 'no-signal')) {
    parts.push(
      `${source.label}: no sound has reached the recorder yet. ` +
        'Check that it is not muted and that the right device or tab is selected.'
    )
  }
  return parts.join(' ')
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`
}

function describeLaunchError(err) {
  if (!(err instanceof MeetingApiError)) return 'Could not start the meeting.'
  if (err.status === 0) return 'Could not reach the server. Check the connection and try again.'
  if (err.code === 'launch-code-required') return 'Enter the launch code.'
  if (err.code === 'launch-code-invalid') return 'That launch code was not accepted.'
  if (err.status === 429) return 'Too many wrong codes. Wait a minute and try again.'
  if (err.status === 503) return 'Starting meetings is not set up on this server (no launch code is configured).'
  if (err.code === 'invalid-title') return 'The title is too long (120 characters at most).'
  return `Could not start the meeting (${err.code}).`
}

function describeConnectionError(err) {
  const name = err?.name ?? ''
  const message = String(err?.message ?? '')
  if (err?.code === 'audio-context-suspended') {
    return 'The browser is holding back audio until you interact with the page. Click anywhere on the page, then press Reconnect.'
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone is blocked. Allow it in the browser, then press Reconnect.'
  }
  if (name === 'NotFoundError') return 'No microphone was found. Plug one in, then press Reconnect.'
  if (/websocket|closed unexpectedly/i.test(message)) {
    return 'Lost the connection to the speech service. Press Reconnect to carry on with this meeting.'
  }
  return `${message || 'The recording stopped unexpectedly.'} Press Reconnect to carry on with this meeting.`
}

function describeEndError(err, meetingId) {
  if (!(err instanceof MeetingApiError)) return { message: 'Could not finish the meeting.', canDiscard: false }
  if (err.status === 0) return { message: 'Could not reach the server. Press Try again.', canDiscard: false }
  if (err.status === 409 && err.code === 'transcript-incomplete') {
    const missing = Number(err.details?.missingSegments) || 0
    return {
      message: missing
        ? `${plural(missing, 'line is', 'lines are')} not saved yet; the speech service is still sending them. Press Try again in a moment.`
        : 'Some lines are not saved yet. Press Try again in a moment.',
      canDiscard: false
    }
  }
  if (err.status === 409 && err.code === 'speech-session-active') {
    return { message: 'The recording is still closing. Press Try again in a moment.', canDiscard: false }
  }
  if (err.status === 401 || err.status === 403) {
    return {
      message: `This meeting's ticket is no longer accepted (tickets last 12 hours). Ask the operator to end meeting ${meetingId}.`,
      canDiscard: true
    }
  }
  if (err.status === 404) return { message: 'The server does not know this meeting any more.', canDiscard: true }
  return { message: `Could not finish the meeting (${err.code}).`, canDiscard: false }
}

export function createMeetingController({
  api,
  createLiveClient,
  storage,
  checkSupport = () => ({ ok: true }),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  now = () => Date.now(),
  newLaunchKey = randomLaunchKey,
  intelligenceOptions = {} // timers / intervals for the intelligence poller (tests)
}) {
  let state = emptyState()
  let captureMode = 'microphone' // kept for Reconnect
  let launchReady = false // survives a reset: it describes this browser, not one meeting
  let pendingLaunchKey = null // the key of a launch attempt whose outcome is not known yet
  const listeners = new Set()
  let client = null
  let stopping = null // the client being stopped: its last lines are still decoded and saved while it winds down
  let session = null // { meetingId, ticketToken, expiresAt, title, startedAt }
  let ending = false

  /** A clean form that still knows whether this browser is unlocked. */
  function blank() {
    const known = intelligence.get() // the last meeting's findings stay readable until another meeting starts
    return { ...emptyState(), launchReady, intelligence: known.data, intelligenceError: known.error }
  }

  function set(patch) {
    if ('launchReady' in patch) launchReady = patch.launchReady === true
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  // The one copy of the meeting's findings: the panel renders it, chat answers from it.
  const intelligence = createIntelligenceStore({
    api,
    now,
    ...intelligenceOptions,
    onChange: ({ data, error }) => set({ intelligence: data, intelligenceError: error })
  })

  function addLine(segment, persisted) {
    const kind = SAVED.has(persisted) ? 'saved' : persisted === 'FAILED' ? 'waiting' : 'notSaved'
    const line = {
      key: segment?.id ?? `line-${state.counts.saved + state.counts.waiting + state.counts.notSaved}`,
      text: String(segment?.text ?? ''),
      start: segment?.start ?? null,
      end: segment?.end ?? null,
      persisted: persisted ?? 'UNKNOWN'
    }
    const lines = [...state.lines, line]
    set({
      partial: '',
      lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines,
      counts: { ...state.counts, [kind]: state.counts[kind] + 1 }
    })
  }

  function handleConnectionProblem(live, err) {
    if (client !== live) return // already handled (the client reports an error and then also throws)
    client = null
    live.stop().catch(() => {}) // release the microphone and the socket
    set({
      phase: 'problem',
      partial: '',
      message: describeConnectionError(err),
      tone: 'error',
      canReconnect: true,
      canEnd: true,
      canDiscard: false
    })
  }

  /**
   * Whether the server will start a meeting for this browser without the code (it set a launch session after a
   * correct code). Asked of the server each time: the cookie is HttpOnly, so the page cannot know by itself.
   */
  async function refreshLaunchSession() {
    const status = typeof api.launchSession === 'function' ? await api.launchSession() : null
    set({ launchReady: status?.authenticated === true })
    return launchReady
  }

  /** The message while recording: all well, or all well apart from what the sources say. */
  function recordingStatus() {
    const note = describeSources(state.sources)
    return note ? { message: `${RECORDING_OK} ${note}`, tone: 'warn' } : { message: RECORDING_OK, tone: 'ok' }
  }

  async function connect() {
    set({
      sources: [],
      phase: 'connecting',
      message: 'Connecting. Allow the microphone if the browser asks.',
      tone: 'info',
      canReconnect: false,
      canEnd: false,
      canDiscard: false
    })
    const live = createLiveClient({
      meetingId: session.meetingId,
      meetingTicket: session.ticketToken,
      wsProtocols: [TICKET_PROTOCOL, session.ticketToken],
      captureMode
    })
    client = live
    live.setOnReady(({ persistence } = {}) => {
      if (client !== live) return
      if (persistence && persistence !== 'meeting') {
        handleConnectionProblem(live, new Error('The speech service is not saving this meeting.'))
        return
      }
      set({ phase: 'live', ...recordingStatus() })
    })
    live.setOnSources?.((list) => {
      if (client !== live) return
      set({ sources: Array.isArray(list) ? list : [] })
      if (state.phase === 'live') set(recordingStatus())
    })
    live.setOnDropped?.((info) => {
      if (client !== live) return
      const seconds = Math.round(Number(info?.seconds) || 0)
      set({
        droppedSeconds: seconds,
        message:
          `The connection is not keeping up: about ${seconds} s of audio were dropped and are missing from the ` +
          'transcript. Check the network.',
        tone: 'warn'
      })
    })
    live.setOnPartial((text) => client === live && set({ partial: String(text ?? '') }))
    live.setOnStabilizing((text) => client === live && set({ partial: String(text ?? '') }))
    // A line decoded while Stop waits for the speech service is saved on the server, so it is shown and counted
    // too (the last thing said used to be missing from the panel). Provisional text is not: Stop clears it.
    live.setOnFinalSegment((segment, persisted) => (client === live || stopping === live) && addLine(segment, persisted))
    live.setOnError((err) => {
      const explanation = RECOVERABLE_CODES.get(err?.code)
      if (!explanation) return handleConnectionProblem(live, err)
      if (client !== live && stopping !== live) return
      set({ message: `Recording continues. ${explanation} Check the counts below.`, tone: 'warn' })
    })
    try {
      await live.start()
    } catch (err) {
      handleConnectionProblem(live, err)
    }
  }

  function complete(meeting) {
    const integrity = meeting?.integrity ?? {}
    const storedSegments = (integrity.sessions ?? []).reduce((sum, entry) => sum + (entry.storedSegments ?? 0), 0)
    const verified = integrity.verified === true
    const unverifiedSessions = integrity.unverifiedSessions ?? 0
    const recordings = (integrity.sessions ?? []).length
    storage.clear()
    session = null
    intelligence.markClosed() // keeps asking until the final record is settled
    // "Verified" is true of a meeting that never recorded anything, but saying so would mislead.
    const nothingRecorded = recordings === 0
    // A recording that produced no lines is "verified" (0 of 0) and tells the person nothing they need.
    const nothingHeard = !nothingRecorded && storedSegments === 0 && verified
    set({
      phase: 'done',
      open: false,
      partial: '',
      canReconnect: false,
      canEnd: false,
      canDiscard: false,
      result: { verified, storedSegments, unverifiedSessions, recordings },
      tone: nothingRecorded ? 'info' : nothingHeard ? 'warn' : verified ? 'ok' : 'warn',
      message: nothingRecorded
        ? 'Meeting ended. Nothing was recorded.'
        : nothingHeard
        ? 'Meeting ended. No speech was transcribed, so there is nothing to save. ' +
          'Check that the microphone is not muted, or that the shared tab was playing sound.'
        : verified
        ? `Saved ${plural(storedSegments, 'line', 'lines')}. The transcript is complete and verified.`
        : `Ended with ${plural(storedSegments, 'line', 'lines')} saved, but NOT verified: ` +
          `${plural(unverifiedSessions, 'recording', 'recordings')} never confirmed how many lines it produced, ` +
          'so some lines may still be waiting on the speech service. Ask the operator to check this meeting.'
    })
  }

  async function finish() {
    if (!session || ending) return
    if (!['stopping', 'problem', 'unfinished'].includes(state.phase)) return
    ending = true
    try {
      for (let attempt = 0; ; attempt++) {
        set({
          phase: 'ending',
          message: attempt === 0 ? 'Saving the meeting…' : 'Waiting for the last lines to be saved…',
          tone: 'info',
          canReconnect: false,
          canEnd: false,
          canDiscard: false
        })
        try {
          complete(await api.end({ meetingId: session.meetingId, ticketToken: session.ticketToken }))
          return
        } catch (err) {
          const retryable = err instanceof MeetingApiError && err.status === 409 && RETRYABLE_END.has(err.code)
          if (retryable && attempt < retryDelaysMs.length) {
            await sleep(retryDelaysMs[attempt])
            continue
          }
          const { message, canDiscard } = describeEndError(err, session.meetingId)
          set({ phase: 'problem', message, tone: 'error', canReconnect: false, canEnd: true, canDiscard })
          return
        }
      }
    } finally {
      ending = false
    }
  }

  return {
    getState: () => state,
    refreshLaunchSession,
    /** The server's intelligence state for the current (or last) meeting, or null. The one copy. */
    getIntelligence: () => intelligence.get().data,
    /** Ask the server to update now (and, for a closed meeting, to retry the final record). -> state | null */
    refreshIntelligence: (options) => intelligence.refresh(options),
    /** Resolves once the final record is settled (ready, failed, withheld, empty) or the time limit passes. */
    awaitFinalIntelligence: (options) => intelligence.awaitFinal({ sleep, ...options }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Picks up a meeting an earlier page load left open, so it can be finished instead of lingering. */
    restore() {
      if (state.open || state.phase !== 'idle') return
      const saved = storage.read()
      if (!saved) return
      if (!(Date.parse(saved.expiresAt) > now())) {
        storage.clear()
        set({
          message: `An earlier meeting (${saved.meetingId}) was left open and its ticket has expired. Ask the operator to end it.`,
          tone: 'warn'
        })
        return
      }
      session = saved
      intelligence.track({ meetingId: saved.meetingId, ticketToken: saved.ticketToken })
      set({
        phase: 'unfinished',
        open: true,
        meetingId: saved.meetingId,
        title: saved.title ?? '',
        message: 'An earlier meeting was not finished. Finish it to save it as complete.',
        tone: 'warn',
        canEnd: true,
        canDiscard: true
      })
    },

    /** Forget the launch session on this browser, so the code has to be typed again. Not while a meeting is open. */
    async lock() {
      if (!launchReady || state.open || BUSY.has(state.phase)) return
      const done = typeof api.forgetLaunchSession === 'function' ? await api.forgetLaunchSession() : false
      if (done) set({ launchReady: false, message: 'Locked. The launch code is needed again to start a meeting.', tone: 'info' })
      else set({ message: 'Could not reach the server to lock this browser. It is still unlocked.', tone: 'warn' })
    },

    /**
     * code: typed by a person, or empty to rely on the launch session. title: optional.
     * capture: 'microphone' (default) | 'tab' | 'both'. Sharing a tab needs a click, so voice never asks for it.
     */
    async start({ code, title = '', capture = 'microphone' } = {}) {
      if (state.open || BUSY.has(state.phase)) return
      const trimmedCode = String(code ?? '').trim()
      if (!trimmedCode && !launchReady) await refreshLaunchSession() // the page may be stale
      if (!trimmedCode && !launchReady) {
        set({ ...blank(), message: 'Enter the launch code.', tone: 'warn' })
        return
      }
      // Check the browser before creating anything on the server: no meeting is launched for a page
      // that could never record (no secure connection, no audio worklet).
      const wanted = normalizeCaptureMode(capture)
      const support = checkSupport({ capture: wanted })
      if (!support.ok) {
        set({ ...blank(), message: support.reason, tone: 'error' })
        return
      }
      const cleanTitle = String(title ?? '').trim()
      captureMode = wanted
      intelligence.untrack() // another meeting's findings are never shown under this one
      set({ ...blank(), phase: 'launching', title: cleanTitle, capture: wanted, message: 'Starting the meeting…' })
      // One key per attempt: if the answer is lost and the user tries again, the server hands back the same
      // meeting instead of starting a second one.
      pendingLaunchKey ??= newLaunchKey()
      let launched
      try {
        launched = await api.launch({ code: trimmedCode, title: cleanTitle, idempotencyKey: pendingLaunchKey })
      } catch (err) {
        const outcomeUnknown = err instanceof MeetingApiError && (err.status === 0 || err.status >= 500)
        if (!outcomeUnknown) pendingLaunchKey = null
        const lapsed = !trimmedCode && err instanceof MeetingApiError && err.status === 401
        if (lapsed) {
          set({
            ...emptyState(),
            launchReady: false,
            title: cleanTitle,
            message: 'The launch session has ended. Enter the launch code to start the meeting.',
            tone: 'warn'
          })
          return
        }
        set({ ...blank(), title: cleanTitle, message: describeLaunchError(err), tone: 'error' })
        return
      }
      pendingLaunchKey = null
      session = {
        meetingId: launched.meetingId,
        ticketToken: launched.ticket.token,
        expiresAt: launched.ticket.expiresAt,
        title: cleanTitle,
        startedAt: new Date(now()).toISOString()
      }
      storage.write(session)
      set({ open: true, meetingId: session.meetingId })
      intelligence.track({ meetingId: session.meetingId, ticketToken: session.ticketToken })
      // A correct code makes the server set a launch session; learn that from the server, not by assuming it.
      // Alongside connecting, so it costs the recording nothing, and settled by the time start() returns.
      const unlockStatus = trimmedCode ? refreshLaunchSession().catch(() => {}) : null
      await connect()
      await unlockStatus
    },

    /** Stop recording, then end the meeting. */
    async stop() {
      if (!client || !['connecting', 'live'].includes(state.phase)) return
      const live = client
      client = null
      stopping = live
      set({ phase: 'stopping', partial: '', message: 'Finishing the last lines… this can take a few seconds.', tone: 'info' })
      try {
        await live.stop()
      } catch {
        // The speech service finishes the session by itself when the socket closes.
      } finally {
        stopping = null
      }
      await finish()
    },

    /** End the meeting without recording (after a problem), or retry an ending that was refused. */
    finish,

    /** Carry on with the same meeting after a dropped connection or a blocked microphone. */
    async reconnect() {
      if (state.phase !== 'problem' || !state.canReconnect || !session) return
      await connect()
    },

    /** Forget a meeting this page can no longer finish. It stays open on the server until an operator ends it. */
    discard() {
      if (!state.canDiscard || !session) return
      const meetingId = session.meetingId
      storage.clear()
      session = null
      client = null
      intelligence.untrack()
      set({
        ...blank(),
        message: `Forgot meeting ${meetingId}. It is still open on the server; ask the operator to end it.`,
        tone: 'warn'
      })
    },

    /** Back to the start form after a finished meeting. */
    reset() {
      if (state.phase !== 'done') return
      set(blank())
    }
  }
}
