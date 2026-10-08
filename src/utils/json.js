/** JSON.parse that reports failure instead of throwing: `{ ok: true, value }` or `{ ok: false, error }`. */
export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, error: err }
  }
}

/** Reads a fetch Response body as JSON; an empty body is `{}`, a non-JSON body is `{ raw: text }`. */
export async function parseJsonBody(res) {
  const text = await res.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}
