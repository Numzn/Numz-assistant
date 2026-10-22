/**
 * Helpers shared by the services that turn transcripts into LLM prompts and
 * parse the replies (lectureService, speechNotesService, meetingSummaryService, rollingIntelligenceService).
 *
 * Only the mechanics are shared. What each service asks for, what it accepts and what it does with a reply it
 * cannot use stay in that service: study notes, the final meeting record and the rolling tracker differ on all
 * three on purpose (tests/notesGeneration.test.js pins how).
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

/**
 * Reads a model's reply as the one JSON document it was asked for, fence or no fence. Bad JSON is a result, not a
 * throw: `{ ok: true, value }` or `{ ok: false, error }` with JSON.parse's own message. Any JSON value is `ok`
 * (an array, a number, null); whether that is usable is for the caller to decide.
 *
 * By default the reply must be a string: anything else is a TypeError for the caller (study notes always did
 * that). With `coerce`, a reply that is missing or not text is read as text (`String(reply ?? '')`, so undefined
 * and null are empty) and cannot throw at all; the final meeting record and the rolling tracker use that.
 */
export function parseModelJson(reply, { coerce = false } = {}) {
  let candidate
  if (coerce) {
    try {
      candidate = stripCodeFences(String(reply ?? ''))
    } catch (err) {
      return { ok: false, error: err.message }
    }
  } else {
    candidate = stripCodeFences(reply)
  }
  try {
    return { ok: true, value: JSON.parse(candidate) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * The answer of the two generators that return notes rather than throw: `{ schemaVersion, notes }` when the
 * reply was JSON, and `{ schemaVersion, notes: null, raw, parseError }` when it was not, so the caller can show
 * the reply that failed. `raw` is the reply exactly as the model sent it.
 */
export function notesResult(schemaVersion, reply, parsed) {
  return parsed.ok
    ? { schemaVersion, notes: parsed.value }
    : { schemaVersion, notes: null, raw: reply, parseError: parsed.error }
}
