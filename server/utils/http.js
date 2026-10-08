/**
 * Best-effort message from a failed upstream HTTP response: prefers a JSON
 * `error.message` / `error`, then the raw body, then the status line.
 */
export async function parseError(res) {
  const text = await res.text().catch(() => '')
  try {
    const data = JSON.parse(text)
    return data?.error?.message ?? data?.error ?? text
  } catch {
    return text || `${res.status} ${res.statusText}`
  }
}
