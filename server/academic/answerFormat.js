/**
 * How an answer is laid out, in one place that both the server and the page use (it has no imports and touches nothing but strings).
 *
 * An answer is one or more PARTS. Each part is introduced by a heading line that says ANSWER, or ANSWER (a) for a labelled part of a
 * multi-part question, and the page draws each as its own highlighted block with its own copy icon. In the stored text that is just Markdown:
 *
 *     #### ANSWER (a)
 *     Inflation is a general rise in prices.
 *
 *     #### ANSWER (b)
 *     **5%**
 *
 * The word is written in capitals on purpose: an ordinary reply that happens to contain a heading called "Answer" is never turned into a
 * block. Sources (the "**Sources**" list the server appends) belong to the whole answer, not to its last part, so they are split off first.
 */

export const ANSWER_WORD = 'ANSWER'

const HEADING = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?ANSWER(?:\s*[(\[]\s*([a-z]{1,4}|\d{1,2})\s*[)\]])?(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/

/** "ANSWER" or "ANSWER (a)" */
export const answerLabel = (key) => (key ? `${ANSWER_WORD} (${key})` : ANSWER_WORD)

/** The sources list the server adds after the answer, split from the answer itself. */
export function splitSources(markdown) {
  const text = String(markdown ?? '')
  const at = text.lastIndexOf('\n**Sources**\n')
  if (at === -1) return { body: text, sources: '' }
  return { body: text.slice(0, at).replace(/\s+$/, ''), sources: text.slice(at).trim() }
}

/**
 * Splits an answer into its parts. Text with no ANSWER headings is one part. Text before the first heading is returned as `lead` (usually
 * empty). `labelled` says whether the text itself carried the headings.
 * @returns {{ lead: string, parts: { key: string|null, label: string, markdown: string }[], sources: string, labelled: boolean }}
 */
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

/** The stored form: every part under its own heading, then the sources. */
export function formatAnswers(parts, sources = '') {
  const blocks = parts.map((p) => `#### ${answerLabel(p.key)}\n\n${String(p.markdown ?? '').trim()}`)
  return [...blocks, sources].filter(Boolean).join('\n\n')
}

/** A rewrite of a reply that gave its parts as "(a) …" "(b) …" instead of ANSWER headings, using the labels the question has. */
function recoverParts(text, keys) {
  const lines = String(text).split('\n')
  const found = []
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:#{1,6}\s*)?(?:\*\*)?\(?([a-z]{1,4}|\d{1,2})[).](?:\*\*)?(?=\s|$)/i)
    if (m && keys.includes(m[1].toLowerCase()) && !found.some((f) => f.key === m[1].toLowerCase())) found.push({ at: i, key: m[1].toLowerCase(), rest: line.slice(m[0].length).replace(/^\s*[:\-–—]?\s*/, '') })
  })
  if (found.length < 2) return null
  return found.map((f, n) => ({ key: f.key, label: answerLabel(f.key), markdown: [f.rest, ...lines.slice(f.at + 1, found[n + 1]?.at ?? lines.length)].join('\n').trim() }))
}

// What a model says around an answer without adding to it. Only whole lines that are nothing but this are removed.
const LEAD_IN = /^(?:sure|certainly|of course|absolutely|great question|good question|okay|ok|alright|here(?:'s| is| are)(?: the| your)?(?: answer| answers| solution| response)?|the answer is)\s*[!.:,\-–—]*\s*$/i
const CLOSER = /^(?:i hope (?:this|that) helps?|hope (?:this|that) helps?|let me know if|feel free to|if you (?:have|need) (?:any )?(?:more|further|other)|does that make sense)\b[^\n]*$/i

/** Removes lines of pleasantry before and after an answer: never anything that carries meaning. */
export function trimFiller(markdown) {
  const lines = String(markdown ?? '').split('\n')
  while (lines.length && (!lines[0].trim() || LEAD_IN.test(lines[0].trim().replace(/^\*\*|\*\*$/g, '')))) lines.shift()
  while (lines.length && (!lines[lines.length - 1].trim() || CLOSER.test(lines[lines.length - 1].trim()))) lines.pop()
  return lines.join('\n').trim()
}

/**
 * Brings a model's reply to the stored form. `expectedKeys` are the labels of the parts the question has ([] or one for a single answer).
 * Fillers are removed; a multi-part reply without headings is recovered from its "(a)" markers when they can be found; a single answer is
 * given the plain ANSWER label.
 * @returns {{ parts: object[], markdown: string, sources: string, recovered: boolean, labelled: boolean }}
 */
export function normalizeAnswer(reply, expectedKeys = []) {
  const parsed = parseAnswers(reply)
  let parts = parsed.parts
  let recovered = false
  if (expectedKeys.length >= 2 && !parsed.labelled) {
    const rebuilt = recoverParts(parsed.parts[0].markdown, expectedKeys)
    if (rebuilt) {
      parts = rebuilt
      recovered = true
    }
  }
  // Text written before the first heading is part of the first answer, not lost.
  if (parsed.labelled && parsed.lead && parts[0]) parts = [{ ...parts[0], markdown: `${parsed.lead}\n\n${parts[0].markdown}`.trim() }, ...parts.slice(1)]
  parts = parts.map((p) => ({ ...p, markdown: trimFiller(p.markdown) }))
  if (parts.length === 1 && expectedKeys.length < 2) parts = [{ key: null, label: ANSWER_WORD, markdown: parts[0].markdown }]
  return { parts, markdown: formatAnswers(parts, parsed.sources), sources: parsed.sources, recovered, labelled: parsed.labelled }
}

/**
 * The text of an answer for a place that has no formatting (a plain text box): emphasis marks and code fences are dropped, lists keep their
 * markers, a table becomes tab-separated rows, a link keeps its address. Line breaks stay where they are.
 */
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
