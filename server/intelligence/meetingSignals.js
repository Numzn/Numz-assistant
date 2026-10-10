/**
 * What a transcript says outright, found without a model: the questions asked, the commitments made, the
 * decisions stated. Every finding points at the segment it came from and keeps that segment's own words.
 *
 * Deliberately modest. These are English surface patterns, so they miss what is implied and they will
 * sometimes match something that is not what it looks like. Each finding says which kind of evidence it rests
 * on, so a reader can weigh it:
 *   confirmed  the words themselves state it ("we decided to ...", a sentence ending in "?")
 *   inferred   the wording suggests it without stating it ("let's ...", a question with no question mark)
 *   uncertain  the finding is there but the transcript under it is shaky (a low recognition confidence)
 * Who said it is never guessed: `speaker` is passed through only when the segment carries a real, unambiguous
 * label, and an owner is named only when the text names one or the speaker says "I will".
 */

const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday'
const DEADLINE = new RegExp(
  `\\b(?:by|before|until|on|this|next)\\s+(?:${WEEKDAYS}|tomorrow|tonight|today|end of (?:the )?(?:day|week|month)|` +
    `next week|next month|the \\d{1,2}(?:st|nd|rd|th)?)\\b`,
  'i'
)

// A question with no question mark: an auxiliary verb first ("can we ...", "is it ..."), or a question word
// followed by one ("what is ...", "how do we ..."). A bare question word is not enough: "What your country can
// do for you" and "When the team ships" are statements.
const AUX = '(?:can|could|should|would|will|do|does|did|is|are|am|was|were|have|has|shall|may|might)'
const INTERROGATIVE_OPENING = new RegExp(
  `^(?:${AUX}\\b|(?:what|who|whom|whose|when|where|why|how|which)\\s+${AUX}\\b)`,
  'i'
)

const ACTION_PATTERNS = [
  { name: 'first-person-commitment', status: 'confirmed', first: true, re: /\bI(?:'ll|’ll| will| am going to|'m going to|’m going to| can take| will take)\b/ },
  { name: 'group-commitment', status: 'confirmed', re: /\bwe(?:'ll|’ll| will| are going to|'re going to|’re going to)\b/i },
  // "Priya will draft it": a capitalised word that is not an ordinary one (see NOT_NAMES) followed by will/is going to.
  { name: 'named-commitment', status: 'confirmed', re: /\b([A-Z][a-z]{1,20})(?:,)? (?:will|is going to|can take)\b/, exclude: true },
  { name: 'explicit-action-item', status: 'confirmed', re: /\b(?:action item|to-?do|follow[- ]up|next steps?)\b/i },
  { name: 'request', status: 'inferred', re: /\b(?:can|could|would|will) you (?:please )?\w+/i },
  { name: 'obligation', status: 'inferred', re: /\b(?:needs? to|has to|have to|must)\b/i },
  { name: 'proposal', status: 'inferred', re: /\blet(?:'|’)?s\b/i }
]

const DECISION_PATTERNS = [
  { name: 'stated-decision', status: 'confirmed', re: /\b(?:we(?:'ve|’ve| have)? (?:decided|agreed)|(?:it|that)(?:'s|’s| is) (?:decided|settled|agreed)|the decision is|decided to|agreed to|settled on|approved)\b/i },
  { name: 'choice', status: 'inferred', re: /\b(?:we(?:'ll|’ll| will)|let(?:'|’)?s) go with\b/i }
]

const NAMED_OWNER = /\b([A-Z][a-z]{1,20})(?:,)? (?:will|can|could|is going to|should|to)\b/
const NOT_NAMES = new Set(
  ('We I You They He She It This That These Those There Then Please Let So And But Everyone Everybody Someone Somebody ' +
    'Anyone Anybody Nobody Nothing Something Anything Everything Tomorrow Today Tonight Yesterday Monday Tuesday ' +
    'Wednesday Thursday Friday Saturday Sunday January February March April May June July August September ' +
    'October November December Which What Who When Where Why How The A An').split(' ')
)
const LOW_CONFIDENCE = 0.4

function attributable(segment) {
  const speaker = segment.speaker
  if (typeof speaker !== 'string' || !speaker || speaker === 'overlap' || segment.uncertain === true) return null
  return speaker
}

function sourceOf(segment) {
  return { segmentIds: [segment.id], start: segment.start, end: segment.end }
}

function lowConfidence(segment) {
  return typeof segment.confidence === 'number' && segment.confidence < LOW_CONFIDENCE
}

function make(kind, segment, status, pattern, extra = {}) {
  const caveats = []
  let finalStatus = status
  if (lowConfidence(segment)) {
    caveats.push('low-asr-confidence')
    finalStatus = 'uncertain'
  }
  return {
    id: `${kind}:${segment.id}`,
    kind,
    text: String(segment.text ?? '').trim(),
    status: finalStatus,
    basis: 'explicit-wording',
    pattern,
    source: sourceOf(segment),
    speaker: attributable(segment),
    caveats,
    ...extra
  }
}

function ownerFor(segment, match) {
  const text = String(segment.text ?? '')
  const named = text.match(NAMED_OWNER)
  if (named && !NOT_NAMES.has(named[1])) return { name: named[1], evidence: 'named-in-text' }
  const speaker = attributable(segment)
  if (match.first && speaker) return { name: speaker, evidence: 'speaker-label' }
  return { name: null, evidence: null }
}

/** @param {{id:string,start:number,end:number,text:string,speaker?:string|null,uncertain?:boolean,confidence?:number|null}[]} segments */
export function extractSignals(segments) {
  const list = Array.isArray(segments) ? segments : []
  const questions = []
  const actionItems = []
  const decisions = []

  for (const segment of list) {
    const text = String(segment?.text ?? '').trim()
    if (!segment?.id || !text) continue

    if (/\?\s*$/.test(text)) questions.push(make('question', segment, 'confirmed', 'question-mark'))
    else if (INTERROGATIVE_OPENING.test(text) && text.split(/\s+/).length >= 3) {
      questions.push(make('question', segment, 'inferred', 'interrogative-opening'))
    }

    const action = ACTION_PATTERNS.find((pattern) => {
      const match = text.match(pattern.re)
      return match && !(pattern.exclude && NOT_NAMES.has(match[1]))
    })
    if (action) {
      const deadline = text.match(DEADLINE)
      actionItems.push(
        make('actionItem', segment, action.status, action.name, {
          owner: ownerFor(segment, action),
          due: deadline ? deadline[0] : null
        })
      )
    }

    const decision = DECISION_PATTERNS.find((pattern) => pattern.re.test(text))
    if (decision) decisions.push(make('decision', segment, decision.status, decision.name))
  }

  return { questions, actionItems, decisions }
}
