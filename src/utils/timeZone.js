/** The person's own time zone, so the assistant knows what "today" and "this evening" are for them. */
export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}
