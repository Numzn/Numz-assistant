/**
 * What NUMZ AI says about a meeting's findings, built ONLY from the server's intelligence state (the one copy the
 * meeting panel renders too). It never derives a finding, an owner or a deadline itself, and it says how current
 * and how settled what it reports is:
 *
 *   live, provisional   the meeting is open, or its transcript is not verified
 *   confirmed           the saved words themselves state it (an item's `status`)
 *   final               the meeting is closed and its transcript was verified
 *
 * Every reply has two forms: `reply`, Markdown for the chat, and `speech`, plain and short for the voice.
 */

const MAX_ITEMS = 8
const MAX_SPOKEN = 3

function clockTime(iso) {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`
}

const LABELS = {
  confirmed: 'stated in the transcript',
  inferred: 'model reading, provisional',
  uncertain: 'uncertain'
}

// In a verified final record a model's reading is still a reading, but it is no longer "provisional".
const SETTLED_LABELS = { ...LABELS, inferred: 'model reading, cited from the transcript' }

function itemLine(item, { owner = false, settled = false } = {}) {
  const labels = settled ? SETTLED_LABELS : LABELS
  const parts = []
  if (owner && item.kind === 'actionItem') {
    parts.push(item.owner?.name ? `owner: ${item.owner.name}` : 'owner not stated')
    parts.push(item.due ? `due: ${item.due}` : 'no deadline stated')
  }
  parts.push(labels[item.status] ?? item.status)
  parts.push(`at ${mmss(item.source?.start)}`)
  return `- ${item.text} — ${parts.join('; ')}`
}

/** How current and how settled the findings are, in one honest paragraph. -> { text, speech, current } */
export function describeProvenance(intel) {
  const t = intel.transcript ?? {}
  const a = intel.analysis ?? {}
  const lines = plural(t.segmentCount ?? 0, 'saved line', 'saved lines')
  const final = intel.final ?? {}

  if (final.status === 'ready' && t.state === 'verified') {
    return {
      current: true,
      text: `**Final — the transcript was verified** (${lines}).`,
      speech: `This is the final record. The transcript was verified, ${lines}.`
    }
  }
  if (intel.phase === 'ended') {
    return {
      current: false,
      text: `This meeting did not complete, so nothing here is final. It is based on ${lines}.`,
      speech: `This meeting did not complete, so nothing is final. It has ${lines}.`
    }
  }
  if (t.meetingStatus === 'COMPLETED' || intel.phase === 'closing' || intel.phase === 'closed' || intel.phase === 'final') {
    if (final.status === 'running' || final.status === 'pending') {
      return {
        current: false,
        text: `The meeting has ended and its final record is still being written. What follows is provisional (${lines}).`,
        speech: `The meeting has ended and the final record is still being written. This is provisional.`
      }
    }
    if (final.status === 'withheld') {
      const why =
        final.reason === 'transcript-unverified'
          ? 'its transcript could not be verified as complete'
          : final.reason === 'transcript-too-long'
          ? 'it is too long to summarise in one pass'
          : `it was withheld (${final.reason})`
      return {
        current: false,
        text: `The meeting has ended but there is **no final summary**: ${why}. What follows comes from the saved lines (${lines}) and is provisional.`,
        speech: `The meeting has ended but there is no final summary because ${why}. This is provisional.`
      }
    }
    if (final.status === 'failed') {
      return {
        current: false,
        text: `The meeting has ended, but the final summary could not be written${final.detail ? ` (${final.detail})` : ''}. What follows is provisional (${lines}).`,
        speech: 'The meeting has ended, but the final summary could not be written. This is provisional.'
      }
    }
    if (final.status === 'empty') {
      return { current: true, text: 'The meeting ended with no saved lines, so there is nothing to summarise.', speech: 'The meeting ended with no saved lines.' }
    }
  }

  // Open meeting: live and provisional. Say how current.
  const updated = clockTime(a.lastSuccessAt)
  const pending = a.pendingSegments ?? 0
  let how
  let spoken
  if (a.status === 'error') {
    how = `The notes update has been failing${a.error?.at ? ` since ${clockTime(a.error.at)}` : ''}` +
      `${a.error?.message ? ` (${a.error.message})` : ''}. ` +
      (updated ? `These findings are from the last successful update at ${updated} and **may be out of date**` : 'There are no model findings yet') +
      `; ${plural(pending, 'newer line is', 'newer lines are')} not analysed.`
    spoken = `The notes update is failing, so these findings may be out of date.`
  } else if (a.status === 'updating') {
    how = `An update is running now${updated ? `; the last one finished at ${updated}` : ''}. ${plural(pending, 'line is', 'lines are')} being analysed.`
    spoken = 'An update is running, so these findings are a little behind.'
  } else if (a.status === 'behind') {
    how = `${plural(pending, 'newer line is', 'newer lines are')} not analysed yet${updated ? `; last update ${updated}` : ''}.`
    spoken = `${plural(pending, 'newer line is', 'newer lines are')} not analysed yet.`
  } else if (a.status === 'idle') {
    how = 'Nothing has been said and saved yet.'
    spoken = 'Nothing has been said and saved yet.'
  } else {
    how = updated ? `Updated ${updated}.` : 'Up to date.'
    spoken = 'These are up to date.'
  }
  return {
    current: a.status === 'current' || a.status === 'idle',
    text: `**Live — provisional.** Based on ${lines}. ${how}`,
    speech: `This is live and provisional, based on ${lines}. ${spoken}`
  }
}

/** The label a finding carries, shared by the chat reply and the meeting panel so they cannot disagree. */
export function findingLabel(item, settled = false) {
  return (settled ? SETTLED_LABELS : LABELS)[item.status] ?? item.status
}

/** m:ss on the meeting timeline. */
export function timestamp(seconds) {
  return mmss(seconds)
}

/** The provenance paragraph without Markdown, for the panel. */
export function provenanceText(intel) {
  return describeProvenance(intel).text.replace(/\*\*/g, '').replace(/_/g, '')
}

/** Which findings to show: the final record's when it is ready, the live ones otherwise. One rule for every reader. */
export function selectFindings(intel) {
  return findingsOf(intel)
}

/** Whether what is shown is a verified final record (no "provisional" wording applies). */
export function isSettledFinal(intel) {
  return intel?.final?.status === 'ready' && intel?.transcript?.state === 'verified'
}

function findingsOf(intel) {
  const final = intel.final ?? {}
  if (final.status === 'ready' && final.findings) return { ...intel.findings, ...final.findings, notes: intel.findings?.notes ?? [] }
  return intel.findings ?? {}
}

function listSection(title, items, { owner = false, empty, settled = false }) {
  if (!items || items.length === 0) return { text: `${title}\n${empty}`, count: 0 }
  const shown = items.slice(0, MAX_ITEMS).map((item) => itemLine(item, { owner, settled }))
  const more = items.length > MAX_ITEMS ? [`- …and ${items.length - MAX_ITEMS} more in the meeting panel`] : []
  return { text: `${title}\n${[...shown, ...more].join('\n')}`, count: items.length }
}

function spokenList(items, noun, { owner = false } = {}) {
  if (!items || items.length === 0) return null
  const head = items.slice(0, MAX_SPOKEN).map((item) => {
    if (owner && item.kind === 'actionItem') {
      return `${item.text}${item.owner?.name ? `, owner ${item.owner.name}` : ', no owner stated'}${item.due ? `, ${item.due}` : ''}`
    }
    return item.text
  })
  const more = items.length > MAX_SPOKEN ? ` and ${items.length - MAX_SPOKEN} more` : ''
  return `${plural(items.length, noun, `${noun}s`)}: ${head.join('; ')}${more}.`
}

/**
 * topic: 'notes' | 'decisions' | 'questions' | 'actions' | 'owners' | 'final'
 * -> { reply, speech, tone }
 */
export function formatIntelligenceReply(topic, intel) {
  const provenance = describeProvenance(intel)
  const f = findingsOf(intel)
  const tone = provenance.current ? 'ok' : 'warn'
  const parts = [provenance.text]
  const spoken = [provenance.speech]
  const finalReady = intel.final?.status === 'ready' && intel.final.summary
  const settled = intel.final?.status === 'ready' && intel.transcript?.state === 'verified'

  if (topic === 'final' || topic === 'notes') {
    if (finalReady) {
      const summary = intel.final.summary
      parts.push(`**Summary**\n${summary.text}`)
      if (summary.status === 'uncertain' || summary.unsupportedTerms?.length) {
        parts.push(
          `_Check this summary: ${summary.unsupportedTerms?.length ? `it mentions ${summary.unsupportedTerms.join(', ')}, which do not appear in the transcript` : 'some of it is weakly supported by the transcript'}._`
        )
      }
      spoken.push(summary.text)
    }
  }

  if (topic === 'notes') {
    const topics = listSection('**Topics**', f.topics, { empty: 'No topics identified yet.', settled })
    const notes = listSection('**Notes**', f.notes, { empty: 'No notes yet.', settled })
    if (!finalReady) parts.push(topics.text, notes.text)
    else parts.push(topics.text)
    const countLine = `${plural((f.decisions ?? []).length, 'decision', 'decisions')}, ${plural((f.actionItems ?? []).length, 'action item', 'action items')}, ${plural((f.openQuestions ?? []).length, 'open question', 'open questions')}.`
    parts.push(`Also: ${countLine}`)
    const t = spokenList(f.topics, 'topic')
    if (t) spoken.push(t)
    const n = spokenList(f.notes, 'note')
    if (n) spoken.push(n)
    spoken.push(`Also ${countLine}`)
  } else if (topic === 'decisions') {
    const s = listSection('**Decisions**', f.decisions, { empty: 'No decisions have been stated yet.', settled })
    parts.push(s.text)
    spoken.push(spokenList(f.decisions, 'decision') ?? 'No decisions have been stated yet.')
  } else if (topic === 'questions') {
    const open = f.openQuestions ?? []
    if (open.length > 0) {
      parts.push(listSection('**Open questions**', open, { empty: '', settled }).text)
      spoken.push(spokenList(open, 'open question'))
    } else if (provenance.current && (intel.analysis?.status === 'current' || intel.final?.status === 'ready')) {
      parts.push('**Open questions**\nNo unanswered questions were found.')
      spoken.push('No unanswered questions were found.')
    } else {
      const asked = f.questionsAsked ?? []
      if (asked.length > 0) {
        parts.push(
          `**Questions asked** — I cannot tell which of these were answered until the notes update succeeds.\n${asked
            .slice(0, MAX_ITEMS)
            .map((item) => itemLine(item))
            .join('\n')}`
        )
        spoken.push(`${spokenList(asked, 'question asked')} I cannot tell which were answered yet.`)
      } else {
        parts.push('**Open questions**\nNone found so far.')
        spoken.push('No open questions found so far.')
      }
    }
  } else if (topic === 'actions') {
    const s = listSection('**Action items**', f.actionItems, { owner: true, empty: 'No action items have been stated yet.', settled })
    parts.push(s.text)
    spoken.push(spokenList(f.actionItems, 'action item', { owner: true }) ?? 'No action items have been stated yet.')
  } else if (topic === 'owners') {
    const items = f.actionItems ?? []
    if (items.length === 0) {
      parts.push('**Owners**\nNo action items have been stated yet, so nobody has been assigned anything.')
      spoken.push('No action items have been stated yet, so nobody is assigned anything.')
    } else {
      const named = items.filter((item) => item.owner?.name)
      const unnamed = items.filter((item) => !item.owner?.name)
      const lines = []
      for (const item of named) lines.push(`- **${item.owner.name}**: ${item.text}${item.due ? ` (${item.due})` : ''} — ${(settled ? SETTLED_LABELS : LABELS)[item.status] ?? item.status}, at ${mmss(item.source?.start)}`)
      for (const item of unnamed) lines.push(`- _no owner stated_: ${item.text} — at ${mmss(item.source?.start)}`)
      parts.push(`**Who is responsible**\n${lines.slice(0, MAX_ITEMS * 2).join('\n')}`)
      parts.push('_I only report an owner when a speaker named one; I do not guess from who was talking._')
      spoken.push(
        named.length
          ? `${named
              .slice(0, MAX_SPOKEN)
              .map((item) => `${item.owner.name}: ${item.text}`)
              .join('; ')}.${unnamed.length ? ` ${plural(unnamed.length, 'task has', 'tasks have')} no owner stated.` : ''}`
          : `Nobody was named as responsible for any of the ${plural(items.length, 'task', 'tasks')}.`
      )
    }
  } else if (topic === 'final') {
    parts.push(listSection('**Decisions**', f.decisions, { empty: 'None stated.', settled }).text)
    parts.push(listSection('**Action items**', f.actionItems, { owner: true, empty: 'None stated.', settled }).text)
    parts.push(listSection('**Open questions**', f.openQuestions, { empty: 'None found.', settled }).text)
    const d = spokenList(f.decisions, 'decision')
    const a = spokenList(f.actionItems, 'action item', { owner: true })
    const q = spokenList(f.openQuestions, 'open question')
    for (const piece of [d, a, q]) if (piece) spoken.push(piece)
  }

  return { reply: parts.filter(Boolean).join('\n\n'), speech: spoken.filter(Boolean).join(' '), tone }
}

/** The reply when there is no meeting, no state, or the state could not be fetched. */
export function noIntelligenceReply({ meetingOpen = false, error = null } = {}) {
  if (error) {
    return {
      reply: `I could not get the meeting's notes: ${error.message} Check the meeting panel.`,
      speech: 'I could not get the meeting notes right now.',
      tone: 'error'
    }
  }
  if (meetingOpen) {
    return {
      reply: 'The meeting is starting, and there is nothing to report yet. Ask again in a moment.',
      speech: 'The meeting is starting and there is nothing to report yet.',
      tone: 'info'
    }
  }
  return {
    reply: 'There is no meeting to ask about. Say "start a meeting" to begin one.',
    speech: 'There is no meeting to ask about.',
    tone: 'info'
  }
}
