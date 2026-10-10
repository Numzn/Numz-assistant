/**
 * Meeting commands for the Home screen, typed or spoken: "start a meeting", "stop the meeting".
 *
 * Deliberately small and strict:
 *  - A command is the WHOLE message (after politeness words). "How do I start a meeting with a customer?" is
 *    a question for the assistant, not a command, and goes there.
 *  - Starting a meeting only opens the meeting panel. The launch code must be typed by a person there; nothing
 *    here holds, guesses or sends it, and the meeting ticket stays inside the meeting controller.
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

/** -> { type: 'start' | 'stop', loose?: true, title?: string } | { type: 'yes' | 'no' } | null */
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

  if (STOP.test(head)) return { type: 'stop' }
  if (STOP_LOOSE.test(head)) return { type: 'stop', loose: true }
  if (YES.test(head)) return { type: 'yes' }
  if (NO.test(head)) return { type: 'no' }
  return null
}

/**
 * meeting: { getState(), stop() }   the meeting controller
 * openPanel({ title? })              opens the meeting panel (and may fill the title)
 */
export function createCommandRouter({ meeting, openPanel, now = () => Date.now(), confirmTtlMs = 60_000 } = {}) {
  let confirmUntil = 0

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

  return {
    /** Resolves to { reply, tone } when the text was a meeting command, or null (send it to the assistant). */
    async handle(text) {
      const command = parseCommand(text)
      const waiting = confirmUntil > now()
      confirmUntil = 0 // anything but an answer to the question cancels it

      if (waiting && command?.type === 'yes') {
        if (!recording()) return reply('That meeting is no longer recording, so there is nothing to stop.', 'info')
        return stopNow()
      }
      if (waiting && command?.type === 'no') return reply('OK. The meeting keeps recording.', 'info')

      if (!command || command.type === 'yes' || command.type === 'no') return null

      if (command.type === 'start') {
        if (recording()) return reply('A meeting is already recording. Type "stop meeting" to end it.', 'info')
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
        return reply('Stop and save the meeting? Reply "yes" to confirm, or "no" to keep recording.', 'info')
      }
      if (command.loose) return null // "stop recording" with no meeting recording is not about a meeting
      if (isOpen()) {
        openPanel({})
        return reply('That meeting is not recording. I opened the meeting panel so you can finish or retry it.', 'info')
      }
      return reply('No meeting is recording right now.', 'info')
    }
  }
}
