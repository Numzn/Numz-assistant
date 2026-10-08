/**
 * Wake-phrase text helpers shared by the local voice input (Web Speech wake)
 * and the voice orchestrator (legacy wake flow).
 */

export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * If `text` starts with one of the (already normalized) wake phrases, returns
 * what follows it ('' for a bare wake phrase); otherwise null.
 */
export function matchWakePhrase(text, normalizedPhrases) {
  const normalized = normalizeText(text)
  if (!normalized) return null

  for (const phrase of normalizedPhrases) {
    const index = normalized.indexOf(phrase)
    if (index === -1) continue
    const before = normalized.slice(0, index).trim()
    if (before) continue
    return normalized.slice(index + phrase.length).trim()
  }

  return null
}
