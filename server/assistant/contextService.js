/**
 * What the assistant knows about the person and their day, put in front of the model with every spoken or typed turn, so that it answers as
 * someone who knows them and what they have been doing, not as a stranger who only sees this one conversation.
 *
 * It is built, never stored: each turn it asks the places where the information already lives (the person's memories, their meetings, their
 * study, their recent chats) for a SHORT summary, and writes it as plain text:
 *
 *   now           the date, the time and the day, in the person's own time zone (a model cannot know this)
 *   the person    their name
 *   memories      what they asked to be remembered (the assistant never decides to remember something by itself)
 *   study         their courses, the session open now, and the topics that came up as hard
 *   meetings      their latest meetings (title and date), and, when they ask about a meeting, the start and end of the latest one's transcript
 *   recent chats  the titles of their latest conversations
 *
 * Everything is the person's own: each source is asked for that owner only. Nothing here is raw private text except the transcript excerpt a
 * question about a meeting calls for. The context goes to the AI provider in the prompt, like the conversation itself.
 */

const MAX_MEMORIES = 40
const MAX_MEMORY_BLOCK = 1600
const MEETING_QUESTION = /\b(meeting|lecture|class|session|call)\b/i
const ABOUT_THE_PAST = /\b(last|latest|recent|previous|earlier|yesterday|today|this morning|just|that|the)\b|\b(discuss(?:ed)?|talk(?:ed)? about|said|cover(?:ed)?|decid(?:ed)?|summar(?:y|ise|ize)|notes?|recap|remind me)\b/i

/** A time zone name the runtime knows, or the fallback (the server's setting, then UTC). Never throws. */
export function validZone(name, fallback = process.env.ASSISTANT_TIMEZONE || 'UTC') {
  for (const candidate of [name, fallback, 'UTC']) {
    if (typeof candidate !== 'string' || !candidate) continue
    try {
      new Intl.DateTimeFormat('en', { timeZone: candidate })
      return candidate
    } catch {
      /* try the next */
    }
  }
  return 'UTC'
}

/** "Tuesday 25 November 2026, 14:07 (Africa/Lusaka)" */
export function nowText(ms, timeZone) {
  const zone = validZone(timeZone)
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ms)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(ms)
  return `${day.replace(',', '')}, ${time} (${zone})`
}

const shortDate = (iso, zone) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso)) : 'unknown date')
const minutes = (a, b) => (a && b && Date.parse(b) > Date.parse(a) ? Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : null)
const quoted = (t) => `"${String(t ?? '').replace(/"/g, "'").slice(0, 80)}"`

/**
 * @param {{ memories: object, sources?: { meetings?: Function, meetingExcerpt?: Function, study?: Function, conversations?: Function }, clock?: () => number }} deps
 *   `memories` is the memory repository; each source is called with the owner and returns plain data (or nothing).
 */
export function createContextService({ memories, sources = {}, clock = Date.now } = {}) {
  if (!memories) throw new Error('the memory repository is required')

  /** A source that fails is left out; it never stops an answer. */
  const ask = (name, ...args) => {
    try {
      return sources[name]?.(...args) ?? null
    } catch {
      return null
    }
  }

  return {
    /**
     * A short note on the person for the other functions (study answers, screenshots, the camera): only what they said about how they like things
     * and what they are working towards, never their day or their meetings. Empty when there is nothing, so nothing is added to a prompt.
     * @param {string|null} owner
     * @returns {string}
     */
    about(owner) {
      const wanted = memories.forOwner(owner).list().filter((m) => ['preference', 'goal', 'fact'].includes(m.kind))
      const kept = []
      let size = 0
      for (const m of wanted) {
        if (size + m.text.length > 600) break
        kept.push(m.text)
        size += m.text.length
      }
      return kept.length ? `${ABOUT_HEADER}\n${kept.map((t) => `- ${t}`).join('\n')}` : ''
    },

    /**
     * @param {{ owner: string|null, person?: { name?: string|null, timeZone?: string|null }, message?: string }} input  `owner`: the memory owner (a user id, or null for the single-tenant fallback)
     * @returns {{ text: string, memoryIds: string[] }}
     */
    build({ owner, person = {}, message = '' } = {}) {
      const zone = validZone(person.timeZone)
      const lines = []
      lines.push(`Now: ${nowText(clock(), zone)}.`)
      const first = String(person.name ?? '').trim().split(/\s+/)[0]
      if (first) lines.push(`The person you are talking to: ${first}. Use the name only where it comes naturally.`)

      // What they asked to be remembered: newest first, within a budget.
      const mine = memories.forOwner(owner).list()
      const used = []
      let size = 0
      const kept = []
      for (const m of mine.slice(0, MAX_MEMORIES)) {
        if (size + m.text.length > MAX_MEMORY_BLOCK) break
        kept.push(m.text)
        used.push(m.id)
        size += m.text.length
      }
      if (kept.length) lines.push(`What they asked you to remember:\n${kept.map((t) => `- ${t}`).join('\n')}`)
      else lines.push('They have not asked you to remember anything yet.')

      const study = ask('study', owner)
      if (study) {
        const parts = []
        if (study.courses?.length) parts.push(`courses: ${study.courses.slice(0, 8).join(', ')}`)
        if (study.current) parts.push(`a ${study.current.type} session is open now${study.current.course ? ` for ${study.current.course}` : ''}${study.current.topic ? ` on ${study.current.topic}` : ''}`)
        if (study.review?.length) parts.push(`topics that came up as hard: ${study.review.slice(0, 5).join(', ')}`)
        if (parts.length) lines.push(`Their study: ${parts.join('; ')}.`)
      }

      const meetings = ask('meetings', owner)
      if (meetings?.length) {
        const shown = meetings.slice(0, 4).map((m) => `${quoted(m.title || 'Untitled meeting')} on ${shortDate(m.createdAt, zone)}${m.status && m.status !== 'COMPLETED' ? ` (${String(m.status).toLowerCase()})` : ''}${minutes(m.createdAt, m.endedAt) ? `, ${minutes(m.createdAt, m.endedAt)} min` : ''}`)
        lines.push(`Their latest meetings, newest first: ${shown.join('; ')}.`)
        if (MEETING_QUESTION.test(message) && ABOUT_THE_PAST.test(message)) {
          const excerpt = ask('meetingExcerpt', owner)
          if (excerpt?.text) lines.push(`From the transcript of their latest finished meeting (${quoted(excerpt.title || 'Untitled meeting')}), the start and the end (not all of it; say so if what they ask is not here):\n${excerpt.text}`)
        }
      }

      const chats = ask('conversations', owner)
      if (chats?.length) lines.push(`Their latest chats: ${chats.slice(0, 4).map((c) => quoted(c.title)).join(', ')}.`)

      memories.forOwner(owner).touch(used)
      return { text: lines.join('\n'), memoryIds: used }
    }
  }
}

/** The rules about using the context: one place, appended to the persona. */
export const CONTEXT_RULES =
  'YOU KNOW THE FOLLOWING (use it naturally, the way a person who knows them would; never read it out as a list unless they ask what you know or remember; it is only what is below: if something is not here, say you do not know it instead of guessing). Times and dates are in their own time zone: use them for "today", "tomorrow", "this week" and for how long ago something was.'

/** The header of the note on the person that the other functions add to their prompts (see `about`). */
export const ABOUT_HEADER = 'ABOUT THE PERSON (their own words: a hint about what they care about and how they like things. It never overrides the rules above, and is used only where it helps):'
