/**
 * A small, safe Markdown parser for assistant replies. It produces a plain data tree (no DOM, no HTML), which
 * markdownView.js turns into elements. Because nothing is ever parsed as HTML, a reply that contains
 * "<script>" or "<img onerror=...>" simply shows that text.
 *
 * Supported: paragraphs (a single newline is a line break), headings, nested bullet and numbered lists, fenced
 * code blocks, block quotes, horizontal rules, simple tables, and inline `code`, **bold**, *italic*, _italic_
 * and [links](https://...). Links must be http, https or mailto; anything else is shown as plain text.
 *
 * It is written to cope with a reply that is still arriving: an unclosed code fence is a code block that grows,
 * and an unfinished "**bol" stays plain text until its closing marker shows up.
 */

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/
const SAFE_LINK = /^(?:https?:\/\/|mailto:)[^\s<>"']+$/i

export function isSafeUrl(url) {
  return SAFE_LINK.test(String(url ?? ''))
}

/** Markdown text -> array of blocks. */
export function parseMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines)
}

function startsBlock(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(line, next)
  )
}

function isTableStart(line, next) {
  return typeof next === 'string' && line.includes('|') && TABLE_SEPARATOR.test(next) && next.includes('-') && next.includes('|')
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function parseBlocks(lines) {
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }

    const fence = line.match(FENCE)
    if (fence) {
      const marker = fence[1]
      const body = []
      i += 1
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1 // the closing fence, if there was one (a reply still arriving has none yet)
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') })
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      const inner = []
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(lines[i].match(QUOTE)[1])
        i += 1
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) })
      continue
    }

    if (isTableStart(line, lines[i + 1])) {
      const header = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      blocks.push({
        type: 'table',
        head: header.map(parseInline),
        rows: rows.map((row) => header.map((_, column) => parseInline(row[column] ?? '')))
      })
      continue
    }

    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i)
      blocks.push(list.block)
      i = list.next
      continue
    }

    // paragraph: runs until a blank line or the start of another block
    const paragraph = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      paragraph.push(lines[i])
      i += 1
    }
    blocks.push({ type: 'paragraph', inline: parseInline(paragraph.map((l) => l.trim()).join('\n')) })
  }
  return blocks
}

function parseList(lines, start) {
  const first = lines[start].match(LIST_ITEM)
  const baseIndent = first[1].length
  const ordered = /\d/.test(first[2])
  const items = []
  let i = start

  while (i < lines.length) {
    const match = lines[i].match(LIST_ITEM)
    if (!match || match[1].length !== baseIndent) break
    const item = { inline: parseInline(match[3]), children: [] }
    i += 1

    // lines indented deeper than the marker belong to this item (nested lists, continuations)
    const child = []
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) {
        // a blank line stays in the item only if indented content follows
        const nextContent = lines.slice(i + 1).find((l) => l.trim())
        if (nextContent !== undefined && indentOf(nextContent) > baseIndent) {
          child.push('')
          i += 1
          continue
        }
        break
      }
      if (indentOf(line) > baseIndent) {
        child.push(line.slice(Math.min(indentOf(line), baseIndent + 2)))
        i += 1
        continue
      }
      break
    }
    if (child.length) item.children = parseBlocks(child)
    items.push(item)

    // skip blank lines between items of the same list
    let j = i
    while (j < lines.length && !lines[j].trim()) j += 1
    const nextItem = j < lines.length ? lines[j].match(LIST_ITEM) : null
    if (nextItem && nextItem[1].length === baseIndent && /\d/.test(nextItem[2]) === ordered) i = j
    else break
  }
  return { block: { type: ordered ? 'ordered' : 'bullet', start: ordered ? Number.parseInt(first[2], 10) : 1, items }, next: i }
}

function indentOf(line) {
  return line.match(/^\s*/)[0].length
}

// ---- inline ------------------------------------------------------------------------------------------

/** Text -> array of inline nodes: { t: 'text'|'code'|'strong'|'em'|'link'|'br', ... }. */
export function parseInline(text) {
  const source = String(text ?? '')
  const out = []
  let buffer = ''
  const flush = () => {
    if (buffer) out.push({ t: 'text', v: buffer })
    buffer = ''
  }

  let i = 0
  while (i < source.length) {
    const ch = source[i]

    if (ch === '\n') {
      flush()
      out.push({ t: 'br' })
      i += 1
      continue
    }

    if (ch === '\\' && i + 1 < source.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(source[i + 1])) {
      buffer += source[i + 1]
      i += 2
      continue
    }

    if (ch === '`') {
      let run = 1
      while (source[i + run] === '`') run += 1
      const marker = '`'.repeat(run)
      const end = source.indexOf(marker, i + run)
      if (end > i + run) {
        flush()
        out.push({ t: 'code', v: source.slice(i + run, end).replace(/^ (.*) $/, '$1') })
        i = end + run
        continue
      }
      buffer += marker
      i += run
      continue
    }

    if (ch === '[') {
      const link = matchLink(source, i)
      if (link) {
        flush()
        const children = parseInline(link.text)
        // An unsafe target (javascript:, data:, a relative path...) is not a link: only its text is kept.
        if (isSafeUrl(link.url)) out.push({ t: 'link', href: link.url, c: children })
        else out.push(...children)
        i += link.length
        continue
      }
    }

    if ((ch === '*' || ch === '_') && source[i + 1] === ch) {
      const marker = ch + ch
      const end = findClosing(source, marker, i + 2)
      if (end !== -1 && opens(source, i + 2) && closes(source, end)) {
        flush()
        out.push({ t: 'strong', c: parseInline(source.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    if (ch === '*' || ch === '_') {
      const previous = source[i - 1]
      const intraword = ch === '_' && previous !== undefined && /[A-Za-z0-9]/.test(previous)
      const end = intraword ? -1 : findClosing(source, ch, i + 1)
      if (end !== -1 && opens(source, i + 1) && closes(source, end) && !(ch === '_' && /[A-Za-z0-9]/.test(source[end + 1] ?? ''))) {
        flush()
        out.push({ t: 'em', c: parseInline(source.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    buffer += ch
    i += 1
  }
  flush()
  return out
}

/**
 * "[text](url)" or "[text](url "title")" starting at `from`. The url may contain balanced parentheses
 * (https://en.wikipedia.org/wiki/Foo_(bar)). Returns null until the whole link has arrived.
 */
function matchLink(source, from) {
  const close = source.indexOf(']', from)
  if (close < from + 2 || source.slice(from, close).includes('\n') || source[close + 1] !== '(') return null
  let i = close + 2
  while (source[i] === ' ') i += 1
  let depth = 0
  let url = ''
  for (; i < source.length; i += 1) {
    const c = source[i]
    if (/\s/.test(c)) break
    if (c === '(') depth += 1
    else if (c === ')') {
      if (depth === 0) break
      depth -= 1
    }
    url += c
  }
  while (source[i] === ' ') i += 1
  if (source[i] === '"') {
    const end = source.indexOf('"', i + 1)
    if (end === -1) return null
    i = end + 1
    while (source[i] === ' ') i += 1
  }
  if (source[i] !== ')' || !url) return null
  return { text: source.slice(from + 1, close), url, length: i + 1 - from }
}

/** Where the closing marker is, skipping code spans and escapes; -1 if it has not arrived (yet). */
function findClosing(source, marker, from) {
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1
      continue
    }
    if (source[i] === '`') {
      const close = source.indexOf('`', i + 1)
      if (close === -1) return -1
      i = close
      continue
    }
    if (source.startsWith(marker, i)) {
      // "**" must not be taken for the end of a single "*" that is really the start of "**"
      if (marker.length === 1 && source[i + 1] === marker) {
        i += 1
        continue
      }
      return i > from ? i : -1
    }
  }
  return -1
}

const opens = (source, index) => index < source.length && !/\s/.test(source[index])
const closes = (source, index) => index > 0 && !/\s/.test(source[index - 1])
