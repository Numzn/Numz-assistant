import { AcademicError } from './academicError.js'

/**
 * The Academic Integrity Controller: an application-level gate, not a request to the model to behave.
 *
 * What the application can know is what the PERSON declared when they started the session (study, practice or restricted): it cannot tell
 * from a screenshot whether something is a live examination, so it never guesses. The declared type is stored with the session, can never
 * be changed (the database refuses it; to change it the person ends the session and starts another, which is audited), and is checked HERE,
 * before any model is asked and before any screen is read:
 *
 *   study / practice   learning and practice: screens may be read and questions answered with the working shown.
 *   restricted         an assessment that does not allow assistance: no screen is captured or read, no question is answered. What remains
 *                      is teaching a concept in general terms (`explain_concept`), study help and feedback.
 *
 * Whatever the type, a session that is paused, ended or past its time does nothing.
 *
 * `assessmentSignals` is advisory only: a screen that SAYS it is an examination makes the application ask the person to confirm what kind
 * of session this is; it never switches the type itself.
 */

export const ACTIONS = Object.freeze(['capture', 'read_question', 'answer', 'explain_concept', 'research', 'feedback'])

const RESTRICTED_ALLOWS = new Set(['explain_concept', 'feedback'])

/** @returns {{ allowed: boolean, mode: 'full'|'practice'|'conceptual', code?: string, message?: string }} */
export function evaluate({ session, action, now = Date.now() }) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown academic action: ${action}`)
  if (!session) return { allowed: false, mode: 'conceptual', code: 'session-required', message: 'Start a study session first, and say whether it is study, practice or a restricted assessment.' }
  if (session.status === 'ended') return { allowed: false, mode: 'conceptual', code: 'session-ended', message: 'That study session has ended. Start a new one.' }
  if (session.status === 'paused') return { allowed: false, mode: 'conceptual', code: 'session-paused', message: 'The study session is paused. Resume it to carry on.' }
  if (session.expiresAt && Date.parse(session.expiresAt) < now) return { allowed: false, mode: 'conceptual', code: 'session-expired', message: 'The study session timed out. Start a new one.' }

  if (session.sessionType === 'restricted') {
    if (RESTRICTED_ALLOWS.has(action)) return { allowed: true, mode: 'conceptual' }
    return {
      allowed: false,
      mode: 'conceptual',
      code: 'restricted-assessment',
      message: 'This session is marked as a restricted assessment, so NUMZ AI will not read the screen or answer the question. It can still explain the underlying concepts in general terms, or go through the topic with you after the assessment.'
    }
  }
  return { allowed: true, mode: session.sessionType === 'practice' ? 'practice' : 'full' }
}

/** Evaluates and throws the refusal as an AcademicError (403) when the action is not allowed. Returns the verdict otherwise. */
export function enforce(args) {
  const verdict = evaluate(args)
  if (!verdict.allowed) throw new AcademicError(403, verdict.code, verdict.message, { details: { sessionType: args.session?.sessionType ?? null, offer: verdict.mode === 'conceptual' ? 'explain_concept' : null } })
  return verdict
}

const SIGNALS = [
  [/\b(closed[- ]book|open[- ]book exam)/i, 'closed-book'],
  [/\b(do not|don'?t|must not|no)\s+(use|consult|access)\s+(ai|artificial intelligence|chatgpt|assistants?|the internet|phones?|notes)/i, 'no-assistance-rule'],
  [/\b(invigilator|proctor(ed|ing)?|examination hall|exam hall)\b/i, 'invigilated'],
  [/\b(examination|exam|test|assessment|quiz)\s+(in progress|time remaining|ends in)\b/i, 'live-timer'],
  [/\btime (remaining|left)\s*[:\-]?\s*\d/i, 'live-timer'],
  [/\b(academic (honesty|integrity|misconduct)|honou?r code|plagiarism policy)\b/i, 'integrity-notice'],
  [/\b(final|midterm|mid-term|semester)\s+(examination|exam)\b/i, 'formal-exam']
]

/** Phrases on the screen that suggest a formal assessment. Returns the kinds found (no text), for the person to be asked about. */
export function assessmentSignals(...texts) {
  const joined = texts.flat().filter((t) => typeof t === 'string').join('\n')
  return [...new Set(SIGNALS.filter(([pattern]) => pattern.test(joined)).map(([, name]) => name))]
}
