import { formatIntelligenceReply, noIntelligenceReply } from './meetingIntelligenceReply.js'

/**
 * Meeting commands for the Home screen, typed or spoken: "start a meeting", "stop the meeting", and questions about
 * the meeting's findings: "show me the notes so far", "what decisions have been made?", "what questions remain?",
 * "what action items have been assigned?", "who is responsible for each task?", "end the meeting and give me the
 * final summary".
 *
 * Deliberately small and strict:
 *  - A command is the WHOLE message (after politeness words). "How do I start a meeting with a customer?" is
 *    a question for the assistant, not a command, and goes there.
 *  - Starting a meeting opens the meeting panel. If this browser has already been unlocked (a person typed the
 *    launch code once and the server set its launch session), the meeting is started straight away; otherwise
 *    the code must be typed by a person there. Nothing here holds, guesses or sends a code, and the meeting
 *    ticket stays inside the meeting controller.
 *  - Stopping asks for confirmation first (a stray phrase must not end a recording).
 *  - What is said about the outcome comes from the meeting controller's own state. Nothing here ever says a
 *    meeting or transcript was saved or verified; it repeats what the backend confirmed, or says it is not
 *    confirmed.
 */

const OPENERS =
  /^(?:(?:hey|hi|hello|ok|okay|please|numz|can you|could you|would you|will you|i want to|i would like to|id like to|i need to|lets|let us|go ahead and|just)\s+)+/
const CLOSERS = /(?:\s+(?:please|now|for me|right now|thanks|thank you))+$/
const ARTICLES = '(?:(?:a|an|the|this|that|my|our|new|current)\\s+)*'

const START = new RegExp(`^(?:start|begin|open|launch|create|record|kick off|set up)\\s+${ARTICLES}meeting(?:\\s+(?:recording|transcript|transcription))?$`)
const STOP = new RegExp(
  `^(?:stop|end|finish|close|complete|conclude|wrap up|save)\\s+${ARTICLES}meeting(?:\\s+(?:recording|and save(?: it)?|and end))?$`
)
// "stop recording" does not say which recording. It only counts while a meeting is recording.
const STOP_LOOSE = /^(?:stop|end|finish)\s+(?:the\s+|this\s+|my\s+)?recording$/
// "End the meeting and give me the final summary": stop, then report the final record.
const STOP_AND_SUMMARISE = new RegExp(
  `^(?:stop|end|finish|close|complete|conclude|wrap up)\\s+${ARTICLES}meeting(?:\\s+(?:recording|and save(?: it)?))?` +
    `(?:\\s+(?:and|then))?\\s+(?:(?:give|show|send|read|tell|get)(?: me)?(?: the| a)?(?: final| full| meeting)?\\s+(?:summary|record|notes|minutes)|summari[sz]e(?: it| everything| the meeting)?)$`
)

// Questions about the findings. Whole message only, like every other command; anything else is the assistant's.
const ASK = [
  [
    'final',
    [
      /^(?:give|show|read|tell|get|send)(?: me)?(?: the| a)? (?:final|full) (?:summary|record|minutes|notes)$/,
      /^(?:the )?final (?:summary|record|minutes)$/,
      /^summari[sz]e(?: the| this)? meeting$/
    ]
  ],
  [
    'decisions',
    [
      /^(?:what|which) decisions (?:have|has) been (?:made|taken|reached|agreed)(?: so far| yet)?$/,
      /^(?:show|list|give|tell)(?: me)?(?: the| all)? decisions(?: made| so far)*$/,
      /^(?:any|are there any) decisions(?: so far| yet)?$/,
      /^what (?:did we|have we|has the team|has everyone) (?:decide|decided|agree|agreed)(?: on| to)?(?: so far)?$/,
      /^(?:the )?decisions(?: so far)?$/
    ]
  ],
  [
    'questions',
    [
      /^(?:what|which) questions (?:remain|remains|are (?:still )?(?:open|unanswered|outstanding)|have not been answered|are left)(?: unanswered| open)?(?: so far)?$/,
      /^(?:any|are there any) (?:open|unanswered|outstanding) questions(?: so far| yet)?$/,
      /^(?:show|list|give|tell)(?: me)?(?: the| all)? (?:open|unanswered|outstanding|remaining) questions$/,
      /^(?:the )?(?:open|unanswered|outstanding|remaining) questions$/,
      /^whats (?:still )?(?:unanswered|open|outstanding)$/
    ]
  ],
  [
    'owners',
    [
      /^who (?:is|are|has been|was) (?:responsible|assigned|in charge|doing what|owning)(?: for| to)?(?: each| every| which| what)?(?: task| tasks| action| actions| action items?| items?)?$/,
      /^who (?:owns|is doing|has) (?:what|each(?: task| action item| action)?|which task)$/,
      /^(?:who is )?(?:responsible|assigned) for (?:each|every|all)(?: the)? (?:task|tasks|action items?|actions?)$/,
      /^who (?:is|are) (?:responsible|assigned)$/
    ]
  ],
  [
    'actions',
    [
      /^(?:what|which) (?:action items|actions|tasks|todos|to dos) (?:have|has) been (?:assigned|given|agreed|identified|raised|set)(?: so far| yet)?$/,
      /^(?:show|list|give|tell)(?: me)?(?: the| all)? (?:action items|actions|tasks|todos|to dos)(?: so far)?$/,
      /^(?:what are the|whats the|the) (?:action items|actions|tasks|todos|to dos)(?: so far)?$/,
      /^(?:any|are there any) (?:action items|tasks|actions)(?: so far| yet)?$/
    ]
  ],
  [
    'notes',
    [
      /^(?:show|give|tell|read|get|display|pull up|let me see|let me have)(?: me)?(?: the| my| our)?(?: meeting| live| running)? (?:notes|summary|minutes)(?: so far| until now| up to now| right now| for now| now)?$/,
      /^(?:the )?(?:meeting )?notes(?: so far)?$/,
      /^(?:whats|what is) the (?:meeting )?(?:summary|notes)(?: so far)?$/,
      /^(?:catch me up|what has been said(?: so far)?|what have we (?:covered|discussed)(?: so far)?|whats been (?:said|discussed|covered)(?: so far)?)$/
    ]
  ]
]

const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|stop it|stop and save|save it|save and stop|end it)$/
const NO = /^(?:no|nope|nah|cancel|never mind|nevermind|dont|do not|keep recording|keep going|continue|wait)$/
const TITLE = /^(.*?)\s+(?:called|named|titled)\s+(.+)$/i

const RECORDING = new Set(['connecting', 'live'])

export function normalize(text) {
  let value = String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let previous
  do {
    previous = value
    value = value.replace(OPENERS, '').replace(CLOSERS, '').trim()
  } while (value !== previous)
  return value
}

/** -> { type: 'start' | 'stop', loose?: true, summary?: true, title?: string } | { type: 'ask', topic } | { type: 'yes' | 'no' } | null */
export function parseCommand(text) {
  const raw = String(text ?? '').trim()
  if (!raw || raw.length > 160) return null

  const named = raw.match(TITLE)
  const head = normalize(named ? named[1] : raw)
  if (START.test(head)) {
    const title = named ? named[2].replace(/^["'“”‘’\s]+|["'“”‘’.!?\s]+$/g, '').slice(0, 120) : ''
    return title ? { type: 'start', title } : { type: 'start' }
  }
  if (named) return null // "stop the meeting called x" is not a thing we handle; let the assistant answer

  if (STOP_AND_SUMMARISE.test(head)) return { type: 'stop', summary: true }
  for (const [topic, patterns] of ASK) {
    if (patterns.some((pattern) => pattern.test(head))) return { type: 'ask', topic }
  }

  if (STOP.test(head)) return { type: 'stop' }
  if (STOP_LOOSE.test(head)) return { type: 'stop', loose: true }
  if (YES.test(head)) return { type: 'yes' }
  if (NO.test(head)) return { type: 'no' }
  return null
}

/**
 * meeting: { getState(), start({ title }), stop() }   the meeting controller (getState().launchReady: unlocked)
 * openPanel({ title? })                                opens the meeting panel (and may fill the title)
 */
export function createCommandRouter({
  meeting,
  openPanel,
  now = () => Date.now(),
  confirmTtlMs = 60_000,
  finalTimeoutMs = 60_000
} = {}) {
  let confirmUntil = 0
  let confirmSummary = false // the pending "stop" was "end the meeting and give me the final summary"

  const state = () => meeting.getState()
  const recording = () => RECORDING.has(state().phase)
  const isOpen = () => state().open === true || state().phase === 'launching'

  function reply(text, tone = 'info') {
    return { reply: text, tone }
  }

  /** What the backend confirmed, in the controller's own words. Never anything more. */
  function outcome() {
    const current = state()
    if (current.phase === 'done') return reply(current.message, current.tone === 'ok' ? 'ok' : 'warn')
    if (current.phase === 'problem' || current.phase === 'unfinished') return reply(current.message, 'error')
    if (current.phase === 'stopping' || current.phase === 'ending') {
      return reply('Stopping the meeting. The meeting panel shows the result once the server confirms it.', 'info')
    }
    return reply('The meeting is not confirmed as stopped yet. Check the meeting panel before you rely on it.', 'warn')
  }

  async function stopNow() {
    await meeting.stop()
    return outcome()
  }

  /** What the findings say, from the one state the meeting panel also shows. */
  async function answerAbout(topic) {
    const current = state()
    const known = typeof meeting.getIntelligence === 'function' ? meeting.getIntelligence() : null
    const hasMeeting = Boolean(known) || isOpen() || current.phase === 'done' || RECORDING.has(current.phase)
    if (!hasMeeting) return noIntelligenceReply()
    let intel = known
    let refreshed = false
    if (typeof meeting.refreshIntelligence === 'function') {
      try {
        const fresh = await meeting.refreshIntelligence()
        if (fresh) {
          intel = fresh
          refreshed = !state().intelligenceError
        }
      } catch {
        /* fall back to the last copy, and say so below */
      }
    }
    if (!intel) {
      return noIntelligenceReply({ meetingOpen: isOpen() || RECORDING.has(current.phase), error: state().intelligenceError })
    }
    const body = formatIntelligenceReply(topic, intel)
    if (!refreshed && state().intelligenceError) {
      const note = `I could not refresh the notes just now (${state().intelligenceError.message}), so this is the last copy I had.`
      return { reply: `${note}\n\n${body.reply}`, speech: `${note} ${body.speech}`, tone: 'warn' }
    }
    return body
  }

  /** Stop (the meeting's own end flow, with its verification), then the final record: only what really settled. */
  async function stopAndSummarise() {
    await meeting.stop()
    const base = outcome()
    if (state().phase !== 'done') return base // the end was refused or is still going on: no summary is claimed
    let intel = null
    try {
      intel = typeof meeting.awaitFinalIntelligence === 'function' ? await meeting.awaitFinalIntelligence({ timeoutMs: finalTimeoutMs }) : null
    } catch {
      intel = null
    }
    if (!intel) {
      const note = 'The meeting is saved, but I could not get its notes right now. Check the meeting panel.'
      return { reply: `${base.reply}\n\n${note}`, speech: `${base.reply} ${note}`, tone: 'warn' }
    }
    const body = formatIntelligenceReply('final', intel)
    const settled = intel.final && ['ready', 'failed', 'withheld', 'empty'].includes(intel.final.status)
    const tail = settled
      ? ''
      : '\n\n_The final record is still being written; ask "show me the final summary" in a moment, or see the meeting panel._'
    return {
      reply: `${base.reply}\n\n${body.reply}${tail}`,
      speech: `${base.reply} ${body.speech}`,
      tone: base.tone === 'ok' && body.tone === 'ok' ? 'ok' : 'warn'
    }
  }

  /** Starts the meeting with the launch session and says only what the controller's state confirms. */
  async function startNow(title) {
    openPanel({ title }) // so the status, the lines and any problem are in front of the user
    try {
      await meeting.start({ title })
    } catch {
      return reply('The meeting could not be started. Check the meeting panel.', 'error')
    }
    const current = state()
    if (current.phase === 'live') {
      return reply('The speech service confirmed the recording. The meeting panel shows each line and whether it was saved.', 'ok')
    }
    if (current.phase === 'launching' || current.phase === 'connecting') {
      return reply('Starting the meeting. The meeting panel shows when the speech service has confirmed it.', 'info')
    }
    if (current.phase === 'problem' || current.phase === 'unfinished') return reply(current.message, 'error')
    if (current.phase === 'idle' && current.message) return reply(current.message, current.tone === 'warn' ? 'warn' : 'error')
    return reply('The meeting is not confirmed as started. Check the meeting panel.', 'warn')
  }

  return {
    /** Resolves to { reply, tone } when the text was a meeting command, or null (send it to the assistant). */
    async handle(text) {
      const command = parseCommand(text)
      const waiting = confirmUntil > now()
      confirmUntil = 0 // anything but an answer to the question cancels it

      const summaryRequested = confirmSummary
      confirmSummary = false
      if (waiting && command?.type === 'yes') {
        if (!recording()) return reply('That meeting is no longer recording, so there is nothing to stop.', 'info')
        return summaryRequested ? stopAndSummarise() : stopNow()
      }
      if (waiting && command?.type === 'no') return reply('OK. The meeting keeps recording.', 'info')

      if (!command || command.type === 'yes' || command.type === 'no') return null

      if (command.type === 'ask') return answerAbout(command.topic)

      if (command.type === 'start') {
        if (recording()) return reply('A meeting is already recording. Type "stop meeting" to end it.', 'info')
        if (state().phase === 'launching') {
          return reply('The meeting is already starting. The meeting panel shows how it goes.', 'info')
        }
        if (state().launchReady === true && !isOpen() && typeof meeting.start === 'function') {
          return startNow(command.title)
        }
        openPanel({ title: command.title })
        if (isOpen()) {
          return reply('There is a meeting that was not finished. I opened the meeting panel so you can finish it.', 'warn')
        }
        const titled = command.title ? ` The title "${command.title}" is filled in.` : ''
        return reply(`I opened the meeting panel. Enter the launch code there to start recording.${titled}`, 'info')
      }

      // stop
      if (recording()) {
        confirmUntil = now() + confirmTtlMs
        confirmSummary = command.summary === true
        return reply(
          command.summary
            ? 'Stop and save the meeting, then give you the final summary? Reply "yes" to confirm, or "no" to keep recording.'
            : 'Stop and save the meeting? Reply "yes" to confirm, or "no" to keep recording.',
          'info'
        )
      }
      if (command.summary) return answerAbout('final') // not recording: the last meeting's record, if there is one
      if (command.loose) return null // "stop recording" with no meeting recording is not about a meeting
      if (isOpen()) {
        openPanel({})
        return reply('That meeting is not recording. I opened the meeting panel so you can finish or retry it.', 'info')
      }
      return reply('No meeting is recording right now.', 'info')
    }
  }
}
