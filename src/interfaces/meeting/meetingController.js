import { MeetingApiError } from './meetingApi.js'

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
    result: null // { verified, storedSegments, unverifiedSessions } once done
  }
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
  now = () => Date.now()
}) {
  let state = emptyState()
  const listeners = new Set()
  let client = null
  let stopping = null // the client being stopped: its last lines are still decoded and saved while it winds down
  let session = null // { meetingId, ticketToken, expiresAt, title, startedAt }
  let ending = false

  function set(patch) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

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

  async function connect() {
    set({
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
      wsProtocols: [TICKET_PROTOCOL, session.ticketToken]
    })
    client = live
    live.setOnReady(({ persistence } = {}) => {
      if (client !== live) return
      if (persistence && persistence !== 'meeting') {
        handleConnectionProblem(live, new Error('The speech service is not saving this meeting.'))
        return
      }
      set({ phase: 'live', message: 'Recording. Each line is saved as you speak.', tone: 'ok' })
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
    // "Verified" is true of a meeting that never recorded anything, but saying so would mislead.
    const nothingRecorded = recordings === 0
    set({
      phase: 'done',
      open: false,
      partial: '',
      canReconnect: false,
      canEnd: false,
      canDiscard: false,
      result: { verified, storedSegments, unverifiedSessions, recordings },
      tone: nothingRecorded ? 'info' : verified ? 'ok' : 'warn',
      message: nothingRecorded
        ? 'Meeting ended. Nothing was recorded.'
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

    async start({ code, title = '' } = {}) {
      if (state.open || BUSY.has(state.phase)) return
      const trimmedCode = String(code ?? '').trim()
      if (!trimmedCode) {
        set({ ...emptyState(), message: 'Enter the launch code.', tone: 'warn' })
        return
      }
      // Check the browser before creating anything on the server: no meeting is launched for a page
      // that could never record (no secure connection, no audio worklet).
      const support = checkSupport()
      if (!support.ok) {
        set({ ...emptyState(), message: support.reason, tone: 'error' })
        return
      }
      const cleanTitle = String(title ?? '').trim()
      set({ ...emptyState(), phase: 'launching', title: cleanTitle, message: 'Starting the meeting…' })
      let launched
      try {
        launched = await api.launch({ code: trimmedCode, title: cleanTitle })
      } catch (err) {
        set({ ...emptyState(), title: cleanTitle, message: describeLaunchError(err), tone: 'error' })
        return
      }
      session = {
        meetingId: launched.meetingId,
        ticketToken: launched.ticket.token,
        expiresAt: launched.ticket.expiresAt,
        title: cleanTitle,
        startedAt: new Date(now()).toISOString()
      }
      storage.write(session)
      set({ open: true, meetingId: session.meetingId })
      await connect()
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
      set({
        ...emptyState(),
        message: `Forgot meeting ${meetingId}. It is still open on the server; ask the operator to end it.`,
        tone: 'warn'
      })
    },

    /** Back to the start form after a finished meeting. */
    reset() {
      if (state.phase !== 'done') return
      set(emptyState())
    }
  }
}
