/**
 * What a person says to the assistant about its memory of them, in their own words, found by rule before the model is asked:
 *
 *   "remember that I study economics"        -> { type: 'remember', text: 'I study economics' }
 *   "forget that I study economics"          -> { type: 'forget', text: 'I study economics' }
 *   "what do you remember about me?"         -> { type: 'list' }
 *
 * Only an explicit request is acted on: the assistant never decides by itself to remember something. A question that merely mentions
 * remembering ("do you remember the meeting?") is not a command.
 */

const REMEMBER = /^(?:please\s+|hey\s+|ok(?:ay)?\s+|numz[,\s]+)*(?:please\s+)?(?:can you\s+|could you\s+|would you\s+|will you\s+)?(?:remember|make a note|note down|note|keep in mind|don['’]?t forget)\s+(?:that\s+|this[:,]?\s*|about\s+)?(.{3,400}?)[.!?\s]*$/i
const FORGET = /^(?:please\s+|hey\s+|ok(?:ay)?\s+|numz[,\s]+)*(?:please\s+)?(?:can you\s+|could you\s+|would you\s+|will you\s+)?(?:forget|delete|remove|erase)\s+(?:that\s+|about\s+|the memory (?:that|about|of)\s+|what i said about\s+)(.{3,400}?)[.!?\s]*$/i
const LIST = /^(?:please\s+|hey\s+|ok(?:ay)?\s+|numz[,\s]+)*(?:what|which|tell me what)\b[^?]{0,30}\b(?:do you|have you|you)\b[^?]{0,20}\b(?:remember|know|have|noted|saved)\b[^?]{0,30}\babout me\b/i
const FORGET_ALL = /^(?:please\s+|hey\s+|ok(?:ay)?\s+|numz[,\s]+)*(?:forget|erase|delete|clear)\s+(?:everything|all)(?:\s+you\s+(?:know|remember))?(?:\s+about me)?[.!?\s]*$/i

/** A question is never a command: "do you remember what I said?" is asking, not telling. */
const QUESTION = /\?\s*$|^(?:do|did|can|could|would|will|are|is|what|when|where|why|how|who)\b/i

export function parseMemoryCommand(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 600) return null
  if (FORGET_ALL.test(t)) return { type: 'forget-all' }
  if (LIST.test(t)) return { type: 'list' }
  const forget = t.match(FORGET)
  if (forget && !/^(?:do|did)\b/i.test(t)) return { type: 'forget', text: forget[1].trim() }
  if (QUESTION.test(t) && !/^(?:can|could|would|will)\s+you\b/i.test(t)) return null
  const remember = t.match(REMEMBER)
  if (remember) return { type: 'remember', text: tidy(remember[1]) }
  return null
}

/** The words as a memory: spoken "my name is Sam" stays; a leading "that" or a trailing "please" goes. */
function tidy(text) {
  return text.replace(/\s+please$/i, '').replace(/^that\s+/i, '').trim()
}

/** Which kind of memory a thing is, from how it is worded. */
export function kindOf(text) {
  const t = String(text).toLowerCase()
  if (/\b(i (?:prefer|like|love|hate|dislike|want you to|don['’]?t like)|always|never|call me|address me|speak|reply|answer me)\b/.test(t)) return 'preference'
  if (/\b(my goal|i want to|i['’]?m trying to|i am trying to|i plan to|i['’]?m working towards|aiming)\b/.test(t)) return 'goal'
  if (/\bmy (?:mum|mom|mother|dad|father|brother|sister|friend|wife|husband|partner|lecturer|professor|teacher|boss|colleague|son|daughter|cousin)\b/.test(t)) return 'person'
  if (/\b(i (?:am|['’]m|study|live|work|have)|my (?:name|course|degree|exam|birthday|job|company)|i['’]?m)\b/.test(t)) return 'fact'
  return 'note'
}
