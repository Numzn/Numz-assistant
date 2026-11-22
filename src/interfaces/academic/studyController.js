import { CaptureError } from '../screenshot/nativeCapture.js'
import { AcademicApiError } from './academicApi.js'

/**
 * Academic study in the page, with no screen of its own: this decides what happens when a person starts, pauses, resumes and ends a study
 * session; when the desktop app's watcher reports that the screen changed; when a question is recognised, answered, asked again more
 * simply, or turned into a note; and when they tell NUMZ AI what helped. The page never takes a picture and never decides what an
 * assessment is: the person declares the kind of session, and the server enforces it.
 *
 *   idle ─ start ─▶ active ⇄ paused ─ stop ─▶ idle           (a session that ends on the server, by time or by a restart, ends here too)
 *
 * Screen reading is a separate, visible switch (`watch`): on only when the person asked for it AND the desktop app can do it, off after a
 * page reload until they turn it on again, stopped for good if the page stops asking the app for results.
 * Answers are added to the conversation that is open now (`onExchange`); the server saves them there too.
 */

const POLL_MS = 1500
/** Questions answered by themselves from one screen (more are listed with an Explain button). */
const AUTO_ANSWER_LIMIT = 3
/** A picture the server could not take yet (too soon, busy, a failed read, the network) is sent again after these waits, then dropped. */
const RETRY_WAITS_MS = [4000, 8000]
const RETRYABLE = ['capture-rate-limited', 'capture-busy', 'read-failed', 'network']

const initial = () => ({
  phase: 'idle', // 'idle' | 'starting' | 'active' | 'paused' | 'stopping'
  courses: [],
  session: null,
  watch: { available: false, status: 'off', excludedNow: false, looks: 0, reported: 0, skipped: 0, note: '' },
  questions: [], // { id, text, options, task, marks, signals, state: 'new'|'answering'|'answered'|'confirm'|'needs-course'|'failed', message?, candidates?, answer? }
  lastAnswer: null, // { answerId, questionId, courseId, topic, approach, markdown, sources, grounding, evidence, flags }
  reading: false, // a screen is on its way to be read
  content: [], // the segments of content seen in this session, once each: { id, kind, title, text, status, partial, continuesFrom, seenCount, questionId }
  lastRead: null, // { at, status: 'questions'|'content'|'same'|'none'|'unclear'|'held-back', count, arrival, summary } the last screen the server read
  message: '',
  tone: 'info',
  busy: false
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function describe(err) {
  if (err instanceof AcademicApiError) return { code: err.code, message: err.message, details: err.details }
  if (err instanceof CaptureError) return { code: err.code, message: err.message, details: null }
  return { code: 'failed', message: 'Something went wrong. Try again.', details: null }
}

export function createStudyController({ api, native, getConversationId = () => null, onExchange = () => {}, getExclusions = () => ({ apps: [], titles: [] }), wait = delay, now = Date.now } = {}) {
  let state = initial()
  let pollToken = 0
  const listeners = new Set()
  let working = false // a screen is being sent and read
  let queued = null // the newest screen that arrived meanwhile (an older one is let go)
  let retry = null // { picture, tries, due }: a screen to send again
  let answering = Promise.resolve() // automatic answers go one at a time

  function set(patch) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }
  const setWatch = (patch) => set({ watch: { ...state.watch, ...patch } })
  const say = (message, tone = 'info') => set({ message, tone })

  // ---- loading ------------------------------------------------------------------------------------------------------

  async function refreshCourses() {
    try {
      set({ courses: (await api.courses.list()).courses ?? [] })
    } catch (err) {
      say(describe(err).message, 'warn')
    }
  }

  async function init() {
    let watchAvailable = false
    if (native?.available) {
      try {
        watchAvailable = (await native.status()).modes.watch === true
      } catch {
        watchAvailable = false
      }
    }
    setWatch({ available: watchAvailable, status: 'off', note: native?.available ? (watchAvailable ? '' : 'This desktop session cannot read the screen automatically.') : 'Automatic screen reading needs the NUMZ AI desktop app.' })
    await refreshCourses()
    try {
      const { session } = await api.sessions.current()
      if (session) {
        // A session that survived a page reload is still the person's, but screen reading starts again only when they ask.
        set({ session, phase: session.status === 'paused' ? 'paused' : 'active', message: session.captureEnabled ? 'Screen reading is off after reloading. Turn it on when you want it.' : '' })
        // What the session has already seen comes back too, so the list is whole after a reload.
        api.content?.(session.id).then((r) => (r?.segments?.length ? mergeContent(r.segments) : null)).catch(() => {})
      }
    } catch {
      /* not signed in, or the server is away: the panel shows its own message when used */
    }
    return state
  }

  // ---- the session ------------------------------------------------------------------------------------------------------

  async function startWatching() {
    const exclusions = getExclusions()
    await native.watchStart({ excludeApps: exclusions.apps, excludeTitles: exclusions.titles })
    setWatch({ status: 'watching', excludedNow: false, looks: 0, reported: 0, skipped: 0 })
    poll(++pollToken)
  }

  /** @param {{ type: 'study'|'practice'|'restricted', courseId?: string, topic?: string, captureEnabled?: boolean, autoAnswer?: boolean, useResearch?: boolean }} options */
  async function start(options) {
    if (state.phase !== 'idle') return state
    set({ phase: 'starting', message: 'Starting…', tone: 'info', questions: [], lastAnswer: null })
    const wantsCapture = options.captureEnabled === true && options.type !== 'restricted'
    if (wantsCapture && !state.watch.available) {
      set({ phase: 'idle' })
      say(state.watch.note || 'Screen reading is not available here.', 'warn')
      return state
    }
    let session
    try {
      session = await api.sessions.start({ ...options, captureEnabled: wantsCapture, autoAnswer: wantsCapture && options.autoAnswer !== false })
    } catch (err) {
      set({ phase: 'idle' })
      say(describe(err).message, 'error')
      return state
    }
    set({ session, phase: 'active', message: '', tone: 'info' })
    if (session.captureEnabled) {
      try {
        await startWatching()
      } catch (err) {
        // The session is kept, but with screen reading off: what the person agreed to is not quietly changed into something else.
        try {
          set({ session: await api.sessions.update(session.id, { captureEnabled: false }) })
        } catch {
          /* the next call will say */
        }
        setWatch({ status: 'off' })
        say(`Screen reading could not start: ${describe(err).message}`, 'error')
      }
    }
    return state
  }

  /** Turn screen reading on again for the open session (after a reload, or if it could not start). */
  async function resumeWatching() {
    if (!state.session || state.session.sessionType === 'restricted' || !state.watch.available || state.watch.status !== 'off') return state
    try {
      if (!state.session.captureEnabled) set({ session: await api.sessions.update(state.session.id, { captureEnabled: true }) })
      await startWatching()
      say('Screen reading is on.', 'ok')
    } catch (err) {
      say(`Screen reading could not start: ${describe(err).message}`, 'error')
    }
    return state
  }

  async function pause() {
    if (state.phase !== 'active' || !state.session) return state
    try {
      set({ session: await api.sessions.pause(state.session.id), phase: 'paused' })
      await dropWaiting()
      if (state.watch.status === 'watching') await native.watchPause().catch(() => {})
      if (state.watch.status === 'watching') setWatch({ status: 'paused' })
      say('Paused. Nothing is being read.', 'info')
    } catch (err) {
      say(describe(err).message, 'error')
    }
    return state
  }

  async function resume() {
    if (state.phase !== 'paused' || !state.session) return state
    try {
      set({ session: await api.sessions.resume(state.session.id), phase: 'active' })
      if (state.watch.status === 'paused') {
        await native.watchResume().catch(() => {})
        setWatch({ status: 'watching' })
        poll(++pollToken)
      }
      say('', 'info')
    } catch (err) {
      say(describe(err).message, 'error')
    }
    return state
  }

  async function stop(reason = '') {
    if (!state.session) return state
    set({ phase: 'stopping' })
    pollToken++
    await dropWaiting()
    if (native?.available) await native.watchStop()
    try {
      await api.sessions.stop(state.session.id)
    } catch {
      /* it may already have ended */
    }
    set({ session: null, phase: 'idle', questions: [], lastAnswer: null, reading: false, lastRead: null, content: [], watch: { ...state.watch, status: 'off', excludedNow: false } })
    say(reason || 'The study session has ended. Nothing it held is kept.', 'info')
    return state
  }

  // ---- the watcher -----------------------------------------------------------------------------------------------------

  /** Lets go of every screen that is waiting to be sent: the native copy of a queued one and the page's copy of one to retry. */
  async function dropWaiting() {
    retry = null
    const waiting = queued
    queued = null
    if (waiting && native?.available) await native.discard(waiting.captureId).catch(() => {})
  }

  /** A screen from the watcher. One is sent at a time; if another arrives meanwhile only the newest is kept. The poll loop never waits for it. */
  function submit(pending) {
    retry = null // a newer screen replaces one that was waiting to be sent again
    if (working) {
      const older = queued
      queued = pending
      if (older && native?.available) native.discard(older.captureId).catch(() => {})
      return
    }
    run(() => prepare(pending))
  }

  function run(job) {
    working = true
    Promise.resolve()
      .then(job)
      .catch(() => {})
      .finally(() => {
        working = false
        const next = queued
        queued = null
        if (next && state.session) run(() => prepare(next))
      })
  }

  async function prepare(pending) {
    let out
    try {
      out = await native.exportCapture({ captureId: pending.captureId, maxSide: 1600, quality: 80 })
    } catch {
      return
    } finally {
      await native.discard(pending.captureId)
    }
    await deliver({ bytes: out.bytes, mimeType: out.mimeType }, 0)
  }

  const summary = (status, count, more = {}) => set({ lastRead: { at: now(), status, count, ...more } })

  async function deliver(picture, tries) {
    const session = state.session
    if (!session || state.phase !== 'active') return // nothing is read for a session that is paused or over
    set({ reading: true })
    let result
    try {
      result = await api.sendCapture(session.id, picture)
    } catch (err) {
      set({ reading: false })
      const d = describe(err)
      if (RETRYABLE.includes(d.code)) {
        if (tries < RETRY_WAITS_MS.length) retry = { picture, tries: tries + 1, due: now() + Math.max(err?.retryAfterMs ?? 0, RETRY_WAITS_MS[tries]) }
        else summary('held-back', 0) // it could not be read this time; the next change is read when it comes
        return
      }
      if (['session-ended', 'session-expired', 'session-required'].includes(d.code)) return void (await stop('The study session has ended.'))
      if (d.code === 'daily-limit' || err?.status === 429) {
        if (native?.available) await native.watchPause().catch(() => {})
        setWatch({ status: 'paused' })
        return say(`${d.message} Screen reading is paused.`, 'warn')
      }
      return say(d.message, 'warn')
    }
    set({ reading: false })
    if (state.session?.id !== session.id) return // the session ended while the screen was being read
    const segments = Array.isArray(result.segments) ? result.segments : []
    const more = { arrival: result.arrival ?? null, summary: result.summary ?? null }
    if (segments.length) mergeContent(segments)
    if (result.status !== 'recognised' && result.status !== 'duplicate') {
      summary(result.status === 'unclear' ? 'unclear' : 'none', 0, more)
      return
    }
    const known = (id) => state.questions.some((q) => q.id === id)
    // A question the session already has that was cut off before and is whole now: its text is updated and it is answered like a new one.
    const completed = result.questions.filter((q) => q.completed && known(q.id))
    for (const q of completed) patchQuestion(q.id, { text: q.text, options: q.options ?? [], task: q.task, partial: false, state: ['answering', 'answered'].includes(state.questions.find((x) => x.id === q.id)?.state) ? state.questions.find((x) => x.id === q.id).state : 'new' })
    const fresh = result.questions.filter((q) => !q.duplicate && !q.completed && !known(q.id))
    const added = fresh.map((q) => ({ id: q.id, text: q.text, options: q.options ?? [], task: q.task, marks: q.marks ?? null, partial: q.partial === true, signals: result.signals ?? [], state: 'new', context: result.context }))
    set({ questions: [...state.questions, ...added] })
    const freshSegments = segments.filter((x) => x.status !== 'seen').length
    summary(added.length || completed.length ? 'questions' : freshSegments ? 'content' : 'same', added.length + completed.length, more)
    const ready = [...completed.map((q) => q.id), ...added.filter((q) => !q.partial).map((q) => q.id)]
    if (added.length) say(`Found ${added.length === 1 ? 'a question' : `${added.length} questions`} on your screen.${added.some((q) => q.partial) ? ' One is cut off by the edge of the screen: it will be answered when the rest is visible.' : ''}`, 'ok')
    else if (completed.length) say('A question that was cut off is whole now.', 'ok')
    if (!session.autoAnswer || !ready.length) return
    if ((result.signals ?? []).length) return say('This screen may be an assessment, so nothing was answered automatically. Press Explain if it is practice.', 'warn')
    for (const id of ready.slice(0, AUTO_ANSWER_LIMIT)) answering = answering.then(() => answerQuestion(id)).catch(() => {})
    if (ready.length > AUTO_ANSWER_LIMIT) say(`Answering the first ${AUTO_ANSWER_LIMIT} of ${ready.length} questions. Press Explain on the rest.`, 'info')
  }

  /** The segments of the screen just read, into the list of everything seen in the session (each once; new ones at the end). */
  function mergeContent(segments) {
    const byId = new Map(state.content.map((c) => [c.id, c]))
    for (const segment of segments) byId.set(segment.id, { ...byId.get(segment.id), ...segment })
    set({ content: [...byId.values()].slice(-200) })
  }

  async function poll(token) {
    let failures = 0
    while (token === pollToken && ['watching', 'paused'].includes(state.watch.status)) {
      await wait(POLL_MS)
      if (token !== pollToken) return
      let polled
      try {
        polled = await native.watchPoll()
        failures = 0
      } catch {
        if (++failures >= 3) {
          setWatch({ status: 'off' })
          return say('Screen reading stopped: the desktop app did not answer.', 'warn')
        }
        continue
      }
      setWatch({ excludedNow: polled.excludedNow, looks: polled.stats.looks, reported: polled.stats.reported, skipped: polled.stats.skippedExcluded })
      if (polled.status === 'stopped') {
        setWatch({ status: 'off' })
        await dropWaiting()
        return say(polled.stoppedBecause === 'page-gone' ? 'Screen reading stopped because this page stopped checking in.' : 'Screen reading stopped.', 'warn')
      }
      // The screens are sent and read in the background: this loop is also the heartbeat that keeps the watcher alive, so it never waits for one.
      if (polled.pending) submit(polled.pending)
      else if (retry && !working && now() >= retry.due) {
        const again = retry
        retry = null
        run(() => deliver(again.picture, again.tries))
      }
    }
  }

  // ---- questions and answers -----------------------------------------------------------------------------------------------

  function patchQuestion(id, patch) {
    set({ questions: state.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)) })
  }

  function applyOutcome(question, outcome) {
    if (outcome.status === 'confirm-required') return patchQuestion(question.id, { state: 'confirm', signals: outcome.signals, message: outcome.message })
    if (outcome.status === 'needs-course') return patchQuestion(question.id, { state: 'needs-course', candidates: outcome.candidates, message: outcome.message })
    const answer = { answerId: outcome.answerId, questionId: outcome.questionId, courseId: outcome.courseId, topic: outcome.topic || state.session?.activeTopic || '', approach: outcome.approach, markdown: outcome.markdown, sources: outcome.sources, grounding: outcome.grounding, evidence: outcome.evidence, flags: outcome.flags, task: outcome.task }
    patchQuestion(question.id, { state: 'answered', answer, message: '' })
    set({ lastAnswer: answer })
    if (getConversationId() && outcome.savedToConversation) onExchange({ question: question.text, answer: outcome.markdown })
  }

  async function answerQuestion(id, { style = null, instruction = null, confirmPractice = false, courseId = null } = {}) {
    const question = state.questions.find((q) => q.id === id)
    if (!question || !state.session || state.phase === 'paused') return null
    patchQuestion(id, { state: 'answering', message: '' })
    try {
      const outcome = await api.answer(state.session.id, id, { conversationId: getConversationId(), style, instruction, confirmPractice, courseId })
      applyOutcome(question, outcome)
      return outcome
    } catch (err) {
      const d = describe(err)
      patchQuestion(id, { state: 'failed', message: d.message })
      if (['session-ended', 'session-expired'].includes(d.code)) await stop('The study session has ended.')
      return null
    }
  }

  /** A question typed by the person (no screen involved). */
  async function ask(text, { topic = null, courseId = null, style = null, instruction = null, confirmPractice = false } = {}) {
    const typed = String(text ?? '').trim()
    if (!typed || !state.session || state.phase === 'paused') return null
    set({ busy: true, message: 'Working on it…', tone: 'info' })
    try {
      const outcome = await api.ask(state.session.id, typed, { conversationId: getConversationId(), topic, courseId, style, instruction, confirmPractice })
      const question = { id: outcome.questionId ?? `typed-${Date.now()}`, text: typed, options: [], task: outcome.task ?? 'explain', signals: [], state: 'new' }
      set({ questions: [...state.questions, question] })
      applyOutcome(question, outcome)
      say('', 'info')
      return outcome
    } catch (err) {
      const d = describe(err)
      say(d.details?.offer === 'explain_concept' ? `${d.message}` : d.message, 'warn')
      return null
    } finally {
      set({ busy: false })
    }
  }

  /** What a restricted session may ask for: a concept, named. */
  async function explainConcept(concept, { courseId = null, style = null } = {}) {
    const typed = String(concept ?? '').trim()
    if (!typed || !state.session) return null
    set({ busy: true, message: 'Working on it…', tone: 'info' })
    try {
      const outcome = await api.concept(state.session.id, typed, { conversationId: getConversationId(), courseId, style })
      const question = { id: `concept-${Date.now()}`, text: `Explain the concept: ${typed}`, options: [], task: 'explain', signals: [], state: 'new' }
      set({ questions: [...state.questions, question] })
      applyOutcome(question, outcome)
      say('', 'info')
      return outcome
    } catch (err) {
      say(describe(err).message, 'warn')
      return null
    } finally {
      set({ busy: false })
    }
  }

  /** Content that is not a question, explained on request (it costs a call, so it is never done by itself). */
  async function explainSegment(id) {
    const segment = state.content.find((c) => c.id === id)
    if (!segment || !state.session) return null
    const label = segment.title ? `${segment.kind} "${segment.title}"` : segment.kind
    return ask(`Explain this ${label} from my screen:\n${segment.text}`.slice(0, 2000))
  }

  // ---- feedback ----------------------------------------------------------------------------------------------------------------

  /** kind: helpful | not_helpful | misunderstanding | correction (with note) | save_concept | simpler | deeper */
  async function feedback(kind, { note = null } = {}) {
    const last = state.lastAnswer
    if (!last) return null
    if (kind === 'simpler' || kind === 'deeper') {
      const question = state.questions.find((q) => q.id === last.questionId)
      return question ? answerQuestion(question.id, { style: kind }) : null
    }
    const courseId = last.courseId
    try {
      const body = kind === 'save_concept' ? { kind, courseId, topic: last.topic || 'saved explanation', text: last.markdown } : { kind, courseId, topic: last.topic || state.session?.activeTopic || 'this topic', note, approach: last.approach && ['step_by_step', 'example_first', 'concept_first', 'visual', 'simpler', 'deeper'].includes(last.approach) ? last.approach : null }
      const result = await api.feedback(body)
      if (kind === 'save_concept') say('Saved to your course materials.', 'ok')
      else if (result.recorded) say('Thanks. NUMZ AI will remember that.', 'ok')
      else say(result.reason === 'adaptive-learning-off' ? 'Adaptive learning is off, so nothing was remembered.' : result.reason === 'no-course' ? 'Choose a course for this session so it can remember how you learn.' : 'Noted.', 'info')
      return result
    } catch (err) {
      say(describe(err).message, 'warn')
      return null
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    init,
    refreshCourses,
    start,
    pause,
    resume,
    stop,
    resumeWatching,
    answerQuestion,
    ask,
    explainConcept,
    explainSegment,
    feedback,
    /** The page is closing: stop reading the screen. */
    async destroy() {
      pollToken++
      await dropWaiting()
      if (native?.available) await native.watchStop()
      listeners.clear()
    }
  }
}
