import { looksLikeText, signatureDistance, signatureOf, createStabilityTracker } from './frameAnalysis.js'

/**
 * The Smart Camera's flow as a state machine with no screen, camera or network of its own: a `device` (the camera)
 * and an `api` (the server) are handed in, and the page calls tick() a few times a second.
 *
 *   READY -> QUESTION_DETECTED -> CAPTURING -> EXTRACTING -> ANALYSING -> ANSWER_READY -> WAITING_FOR_NEXT
 *
 * plus IDLE (camera off), STARTING (asking for the camera), AWAITING_CONFIRMATION (review mode: the question is
 * shown and waits for a tap), PAUSED and ERROR. The rules it keeps:
 *
 *   - A picture is sent only when the camera has held still, the scene looks like text, and a minimum time has passed
 *     since the last send. The server reads it; the server alone says whether the question is new, so the same
 *     question is never answered twice whatever the camera does.
 *   - "Looks like a picture already sent" can NOT mean "never send again": measured on rendered quiz screens, two
 *     different questions in one layout sit as close together as sensor noise ("12 + 7" and "13 + 7" differ by 0.003),
 *     while the same page jostled by a hand sits further apart than two different pages. So an unchanged-looking scene
 *     is re-checked on a growing interval (15 s, 30 s, 60 s, then every 60 s), a changed-looking one is sent as soon as
 *     the minimum gap allows, and the worst a wrong guess costs is a delay of a minute (or one extra read), never a
 *     question skipped for good. The manual capture covers the delay.
 *   - Pictures are sent only while `scanning` is true, and `scanning` is what the page's indicator shows: never
 *     while paused, stopped, in error, at the session's limit, or with no vision service behind it.
 *   - Nothing is retried that cannot succeed; what can is retried with a growing pause, and then becomes an error the
 *     person can retry (a manual capture does).
 *   - Nothing here keeps a picture: it is taken, sent, and forgotten.
 */

export const CAMERA_STATES = Object.freeze({
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  READY: 'READY',
  QUESTION_DETECTED: 'QUESTION_DETECTED',
  CAPTURING: 'CAPTURING',
  EXTRACTING: 'EXTRACTING',
  ANALYSING: 'ANALYSING',
  ANSWER_READY: 'ANSWER_READY',
  WAITING_FOR_NEXT: 'WAITING_FOR_NEXT',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR'
})

const S = CAMERA_STATES
const SCANNING = new Set([S.READY, S.QUESTION_DETECTED, S.CAPTURING, S.EXTRACTING, S.ANALYSING, S.ANSWER_READY, S.WAITING_FOR_NEXT, S.AWAITING_CONFIRMATION])
const WATCHING = new Set([S.READY, S.WAITING_FOR_NEXT])

const DEFAULTS = {
  auto: true,
  stableMs: 700, // held still this long before a picture is considered
  stillBelow: 0.12, // layout change between frames below this is "still"
  changeAbove: 0.15, // a picture this far from every recent one looks different: sent without waiting for a re-check
  minGapMs: 2000, // never two sends closer than this
  recheckMs: 15_000, // an unchanged-looking scene is read again after this...
  recheckMaxMs: 60_000, // ...doubling each time nothing new turns up, up to this
  idleStopMs: 5 * 60_000, // the camera switches itself off after this long with nothing sent
  recentPictures: 6,
  retryDelaysMs: [1000, 2500],
  maxReads: 100
}

const CAMERA_PROBLEMS = {
  NotAllowedError: 'The camera is blocked. Allow it in the browser, then try again.',
  SecurityError: 'The camera is blocked. Allow it in the browser, then try again.',
  NotFoundError: 'No camera was found on this device.',
  NotReadableError: 'The camera is in use by another app. Close it and try again.',
  OverconstrainedError: 'This device has no camera that can be used here.',
  InsecureContextError: 'The camera only works on a secure (https) connection. Open this page over https.'
}

const SMALLER = { maxEdge: 800, quality: 0.6 }

function initialState() {
  return {
    phase: S.IDLE,
    auto: DEFAULTS.auto,
    scanning: false, // pictures may be sent right now: what the on-screen indicator shows
    cameraOn: false,
    visionConfigured: true,
    limitReached: false,
    canRetry: false,
    message: '',
    tone: 'info',
    sessionId: null,
    current: null, // the question last read: { questionId, text, options, type, subject, confidence, hasDiagram }
    answer: null, // the server's answer to it
    history: [], // newest first: { questionId, text, answer, markdown, at }
    counts: { reads: 0, answers: 0, duplicates: 0, skipped: 0 }
  }
}

export function createCameraSession({
  device,
  api,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ...overrides
}) {
  const config = { ...DEFAULTS, ...overrides }
  let state = initialState()
  state.auto = config.auto
  const listeners = new Set()

  let limits = { maxReads: config.maxReads }
  let tracker = createStabilityTracker({ stillBelow: config.stillBelow, stableMs: config.stableMs })
  let previous = null // the signature of the last sampled frame
  let recent = [] // signatures of pictures already sent, newest last
  let lastReadAt = Number.NEGATIVE_INFINITY
  let lastActivityAt = 0 // the last time something happened that the person did or caused: not a re-check that found nothing
  let recheckGap = config.recheckMs
  let busy = false
  let epoch = 0 // bumped by pause, stop and clear: work started before then is abandoned
  let abort = null
  let pendingAnswer = null // { questionId } the answer of which failed or awaits a tap
  let deviceOn = false // the camera is open (in an ERROR it may or may not be)

  const snapshot = () => ({
    ...state,
    cameraOn: deviceOn,
    scanning: SCANNING.has(state.phase) && state.visionConfigured && !state.limitReached
  })

  function set(patch) {
    state = { ...state, ...patch }
    const view = snapshot()
    for (const listener of listeners) listener(view)
  }

  function say(message, tone = 'info') {
    if (state.message !== message || state.tone !== tone) set({ message, tone })
  }

  function problem(message, { canRetry = true, ...extra } = {}) {
    set({ phase: S.ERROR, message, tone: 'error', canRetry, ...extra })
  }

  function describeFailure(err) {
    switch (err?.code) {
      case 'vision-not-configured':
        return { message: 'Reading pictures is not set up on this server yet.', canRetry: false, visionConfigured: false }
      case 'assistant-auth-required':
      case 'assistant-auth-misconfigured':
        return { message: 'Sign in again to keep using the camera.', canRetry: true }
      case 'session-limit':
        return { message: `This session reached its limit of ${limits.maxReads} pictures. Clear the history to start another.`, canRetry: false, limitReached: true }
      case 'invalid-image':
      case 'image-too-large':
        return { message: 'That picture could not be used. Try again, a little further from the screen.', canRetry: true }
      default:
        return { message: 'Could not reach the server. Check the connection and try again.', canRetry: true }
    }
  }

  // ---- the server, with patience --------------------------------------------------------------------------

  async function newServerSession() {
    const created = await api.createSession()
    limits = { maxReads: created.limits?.maxReads ?? config.maxReads }
    set({ sessionId: created.sessionId, visionConfigured: created.visionConfigured !== false })
    return created
  }

  /** Calls the server, retrying what can succeed on a second try. Throws AbortError, or the error that gave up. */
  async function withPatience(call, myEpoch) {
    let recreated = false
    for (let attempt = 0; ; attempt++) {
      try {
        return await call()
      } catch (err) {
        if (err?.name === 'AbortError' || myEpoch !== epoch) throw Object.assign(new Error('abandoned'), { name: 'AbortError' })
        if (err?.code === 'session-not-found' && !recreated) {
          recreated = true
          await newServerSession()
          continue
        }
        if (!err?.transient || attempt >= config.retryDelaysMs.length) throw err
        await sleep(err.retryAfterMs || config.retryDelaysMs[attempt])
        if (myEpoch !== epoch) throw Object.assign(new Error('abandoned'), { name: 'AbortError' })
      }
    }
  }

  // ---- reading a picture ---------------------------------------------------------------------------------------

  function remember(signature) {
    if (!signature) return
    recent = [...recent.filter((entry) => signatureDistance(entry, signature) >= config.changeAbove / 2), signature].slice(-config.recentPictures)
  }

  async function readPicture(now, signature) {
    if (state.counts.reads >= limits.maxReads) {
      problem(describeFailure({ code: 'session-limit' }).message, { canRetry: false, limitReached: true })
      return
    }
    busy = true
    const myEpoch = epoch
    abort = new AbortController()
    lastReadAt = now
    remember(signature)
    set({ counts: { ...state.counts, reads: state.counts.reads + 1 }, canRetry: false, answer: null })
    try {
      set({ phase: S.CAPTURING, message: 'Taking the picture…', tone: 'info' })
      let image
      try {
        image = await device.captureImage({})
      } catch {
        return problem('The camera could not take the picture. Try again.')
      }
      if (myEpoch !== epoch) return
      if (!state.sessionId) await newServerSession()

      set({ phase: S.EXTRACTING, message: 'Reading the question…', tone: 'info' })
      let result
      try {
        result = await withPatience(() => api.read(state.sessionId, image, { signal: abort.signal }), myEpoch)
      } catch (err) {
        if (err?.code !== 'image-too-large') throw err
        // The picture was too big for the server: take it again, smaller, once.
        image = await device.captureImage(SMALLER)
        if (myEpoch !== epoch) return
        result = await withPatience(() => api.read(state.sessionId, image, { signal: abort.signal }), myEpoch)
      }
      if (myEpoch !== epoch) return
      await handleReading(result, now, myEpoch)
    } catch (err) {
      if (err?.name === 'AbortError' || myEpoch !== epoch) return
      const failure = describeFailure(err)
      problem(failure.message, failure)
    } finally {
      busy = false
    }
  }

  async function handleReading(result, now, myEpoch) {
    switch (result?.status) {
      case 'new': {
        recheckGap = config.recheckMs
        set({ current: { questionId: result.questionId, ...result.question }, answer: null, tone: 'info' })
        pendingAnswer = { questionId: result.questionId }
        if (state.auto) return answerQuestion({}, now, myEpoch)
        set({ phase: S.AWAITING_CONFIRMATION, message: 'Check the question, then answer it.' })
        return
      }
      case 'duplicate':
        recheckGap = Math.min(recheckGap * 2, config.recheckMaxMs)
        set({ phase: S.WAITING_FOR_NEXT, counts: { ...state.counts, duplicates: state.counts.duplicates + 1 } })
        say('That question was already read. Show the next one.', 'info')
        return
      case 'unclear':
        recheckGap = Math.min(recheckGap * 2, config.recheckMaxMs)
        set({ phase: S.WAITING_FOR_NEXT })
        say(`The text was unclear${result.reason ? `: ${result.reason}` : ''}. Hold the camera steady and a little closer.`, 'warn')
        return
      default:
        recheckGap = Math.min(recheckGap * 2, config.recheckMaxMs)
        set({ phase: S.WAITING_FOR_NEXT })
        say(result?.reason || 'That does not look like a question. Point the camera at one.', 'info')
    }
  }

  async function answerQuestion({ text } = {}, now, myEpoch = epoch) {
    if (!pendingAnswer) return
    busy = true
    abort = abort ?? new AbortController()
    const { questionId } = pendingAnswer
    const body = text !== undefined && text !== state.current?.text ? { questionId, text } : { questionId }
    try {
      set({ phase: S.ANALYSING, message: 'Working out the answer…', tone: 'info', canRetry: false })
      const result = await withPatience(() => api.answer(state.sessionId, body, { signal: abort.signal }), myEpoch)
      if (myEpoch !== epoch) return
      pendingAnswer = null
      const asked = body.text ?? state.current?.text ?? ''
      const entry = { questionId, text: asked, answer: result.answer, markdown: result.markdown ?? '', at: now }
      lastActivityAt = now ?? lastActivityAt
      set({
        answer: result,
        current: state.current ? { ...state.current, text: asked } : state.current,
        history: [entry, ...state.history.filter((item) => item.questionId !== questionId)],
        counts: { ...state.counts, answers: state.counts.answers + 1 },
        phase: S.ANSWER_READY,
        message: 'Answer ready.',
        tone: 'ok'
      })
      set({ phase: S.WAITING_FOR_NEXT, message: 'Ready for the next question.' })
    } catch (err) {
      if (err?.name === 'AbortError' || myEpoch !== epoch) return
      const failure = describeFailure(err)
      problem(failure.message.replace('Could not reach the server.', 'Could not get the answer.'), failure)
    } finally {
      busy = false
    }
  }

  // ---- the loop the page drives ------------------------------------------------------------------------------

  async function tick(now) {
    // A camera left paused is not left open for ever: the same quiet spell applies, counted from the pause.
    if (state.phase === S.PAUSED && now - lastActivityAt >= config.idleStopMs) {
      stop('The camera was switched off after being paused for a while.')
      return undefined
    }
    if (!WATCHING.has(state.phase) || busy) return undefined
    const frame = device.sampleFrame()
    if (!frame) return undefined

    if (now - lastActivityAt >= config.idleStopMs) {
      stop('The camera was switched off after a quiet spell.')
      return undefined
    }

    const signature = signatureOf(frame.gray, frame.width, frame.height)
    const motion = previous ? signatureDistance(previous, signature) : 1
    previous = signature
    const { stable } = tracker.push(motion, now)

    if (!state.visionConfigured || state.limitReached) return undefined
    if (!stable) {
      say('Hold the camera steady on the question.')
      return undefined
    }
    if (!looksLikeText(frame.gray, frame.width, frame.height)) {
      say('Point the camera at a question.')
      return undefined
    }
    // A scene that looks like a picture already sent waits for its re-check; one that looks different waits only for the gap.
    const looksSent = recent.some((seen) => signatureDistance(seen, signature) < config.changeAbove)
    if (now - lastReadAt < (looksSent ? Math.max(config.minGapMs, recheckGap) : config.minGapMs)) return undefined

    set({ phase: S.QUESTION_DETECTED, message: 'A question. Hold still…', tone: 'info' })
    return readPicture(now, signature)
  }

  // ---- what the person can do ----------------------------------------------------------------------------------

  async function start({ now = 0 } = {}) {
    if (state.phase !== S.IDLE && !(state.phase === S.ERROR && !deviceOn)) return
    epoch += 1
    previous = null
    recent = []
    lastReadAt = Number.NEGATIVE_INFINITY
    lastActivityAt = now
    tracker.reset()
    set({ ...initialState(), auto: state.auto, history: state.history, counts: { ...state.counts }, phase: S.STARTING, message: 'Starting the camera…', tone: 'info' })
    try {
      await device.start()
    } catch (err) {
      problem(CAMERA_PROBLEMS[err?.name] ?? 'The camera could not be started.', { canRetry: true })
      return
    }
    deviceOn = true
    try {
      await newServerSession()
    } catch (err) {
      device.stop()
      deviceOn = false
      const failure = describeFailure(err)
      problem(failure.message, failure)
      return
    }
    if (!state.visionConfigured) {
      set({ phase: S.READY, message: 'Reading pictures is not set up on this server yet, so nothing will be scanned.', tone: 'warn' })
      return
    }
    set({ phase: S.READY, message: 'Point the camera at a question.', tone: 'info' })
  }

  function stop(message = '') {
    epoch += 1
    abort?.abort()
    abort = null
    busy = false
    pendingAnswer = null
    if (deviceOn) device.stop()
    deviceOn = false
    tracker.reset()
    previous = null
    set({ phase: S.IDLE, message, tone: 'info', canRetry: false, current: null })
  }

  function pause(now) {
    if (!SCANNING.has(state.phase)) return
    if (now !== undefined) lastActivityAt = now // the quiet spell of a paused camera is counted from here
    epoch += 1
    abort?.abort()
    abort = null
    busy = false
    tracker.reset()
    previous = null
    set({ phase: S.PAUSED, message: 'Paused. Nothing is being scanned or sent.', tone: 'info' })
  }

  function resume(now) {
    if (state.phase !== S.PAUSED && !(state.phase === S.ERROR && state.canRetry && !pendingAnswer)) return
    tracker.reset()
    previous = null
    // Carrying on counts as activity: without this a long pause would be taken for a long quiet spell.
    if (now !== undefined) lastActivityAt = now
    set({ phase: S.READY, message: 'Point the camera at a question.', tone: 'info', canRetry: false })
  }

  async function captureNow(now = 0) {
    const allowed = WATCHING.has(state.phase) || (state.phase === S.ERROR && state.canRetry && !pendingAnswer)
    if (!allowed || busy || !state.visionConfigured || state.limitReached) return undefined
    lastActivityAt = now // the person asked: that counts as being here
    return readPicture(now, previous)
  }

  async function confirm({ text } = {}, now) {
    const waiting = state.phase === S.AWAITING_CONFIRMATION || (state.phase === S.ERROR && pendingAnswer)
    if (!waiting || busy) return undefined
    abort = new AbortController()
    return answerQuestion({ text }, now ?? lastActivityAt, epoch)
  }

  /** "Try again" after an error: does whichever one thing failed (open the camera, take the picture, work out the answer). */
  async function retry(now = lastActivityAt) {
    if (state.phase !== S.ERROR || !state.canRetry) return undefined
    if (pendingAnswer) return confirm({}, now)
    if (!deviceOn) return start({ now })
    return captureNow(now)
  }

  function skip() {
    if (state.phase !== S.AWAITING_CONFIRMATION) return
    pendingAnswer = null
    set({ phase: S.WAITING_FOR_NEXT, current: null, counts: { ...state.counts, skipped: state.counts.skipped + 1 }, message: 'Skipped. Show the next question.', tone: 'info' })
  }

  function setAuto(auto) {
    set({ auto: auto === true })
  }

  async function clearHistory() {
    epoch += 1
    abort?.abort()
    busy = false
    pendingAnswer = null
    const id = state.sessionId
    if (id) {
      try {
        await api.clear(id)
      } catch {
        // Not an error of the whole session: scanning can carry on, and the person can press Clear again.
        say('Could not clear the history on the server. Try again.', 'error')
        return
      }
    }
    recent = []
    lastReadAt = Number.NEGATIVE_INFINITY
    set({
      sessionId: null,
      history: [],
      current: null,
      answer: null,
      counts: { reads: 0, answers: 0, duplicates: 0, skipped: 0 },
      limitReached: false,
      canRetry: false,
      phase: deviceOn && state.phase !== S.PAUSED && state.phase !== S.IDLE ? S.READY : state.phase,
      message: 'History cleared.',
      tone: 'info'
    })
  }

  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot())
      return () => listeners.delete(listener)
    },
    start,
    stop,
    pause,
    resume,
    tick,
    captureNow,
    confirm,
    retry,
    skip,
    setAuto,
    clearHistory
  }
}
