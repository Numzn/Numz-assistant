/**
 * How the page reads an answer's layout: the ANSWER headings, the sources list and a plain-text rendering of an answer. This is the page's own
 * copy of the three functions of server/academic/answerFormat.js that the page needs (the browser may import one file from server/ and no
 * other, see tests/assistantStates.test.js); tests/answerFormatParity.test.js feeds both the same texts and fails if they ever disagree.
 */

export const ANSWER_WORD = 'ANSWER'

const HEADING = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?ANSWER(?:\s*[(\[]\s*([a-z]{1,4}|\d{1,2})\s*[)\]])?(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/

const answerLabel = (key) => (key ? `${ANSWER_WORD} (${key})` : ANSWER_WORD)

function splitSources(markdown) {
  const text = String(markdown ?? '')
  // What stands beside the answer rather than in it begins at the first of these: a note about the sources, or the list of sources.
  const marks = ['\n**Note**\n', '\n**Sources**\n'].map((m) => text.lastIndexOf(m)).filter((i) => i !== -1)
  const at = marks.length ? Math.min(...marks) : -1
  if (at === -1) return { body: text, sources: '' }
  return { body: text.slice(0, at).replace(/\s+$/, ''), sources: text.slice(at).trim() }
}

/** @returns {{ lead: string, parts: { key: string|null, label: string, markdown: string }[], sources: string, labelled: boolean }} */
export function parseAnswers(markdown) {
  const { body, sources } = splitSources(markdown)
  const lines = body.split('\n')
  const heads = []
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) return
    const m = line.match(HEADING)
    if (m) heads.push({ at: i, key: m[1] ? m[1].toLowerCase() : null })
  })
  if (!heads.length) return { lead: '', parts: [{ key: null, label: ANSWER_WORD, markdown: body.trim() }], sources, labelled: false }
  const parts = heads.map((head, n) => ({
    key: head.key,
    label: answerLabel(head.key),
    markdown: lines.slice(head.at + 1, heads[n + 1]?.at ?? lines.length).join('\n').trim()
  }))
  return { lead: lines.slice(0, heads[0].at).join('\n').trim(), parts, sources, labelled: true }
}

/** The text of an answer for a place that has no formatting: emphasis marks and code fences dropped, lists kept, a table as tab-separated rows. */
export function plainText(markdown) {
  const out = []
  let inFence = false
  for (const raw of String(markdown ?? '').split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(raw)) continue // a table's rule line
    let line = raw
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('\t')
    line = line
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
