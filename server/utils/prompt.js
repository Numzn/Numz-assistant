/**
 * Helpers shared by the services that turn transcripts into LLM prompts and
 * parse the replies (lectureService, speechNotesService, rollingIntelligenceService).
 */

/** Seconds -> `mm:ss` (minutes keep counting past 59, e.g. 5400s -> `90:00`). */
export function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

/** One canonical segment as a prompt line: `[seg_0041 | 42:01-42:34 | speaker_00] text`. */
export function formatSegmentLine(seg) {
  return `[${seg.id} | ${formatTimestamp(seg.start)}-${formatTimestamp(seg.end)} | ${seg.speaker ?? 'unknown'}] ${seg.text}`
}

/** Models often wrap JSON in a ```json fence even when told not to. */
export function stripCodeFences(text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1] : trimmed
}
