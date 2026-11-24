/**
 * Answers as blocks. Text that carries ANSWER headings (see server/academic/answerFormat.js) is drawn as one highlighted block per answer: a
 * small label (ANSWER, or ANSWER (b) for a part of a multi-part question), a small copy icon beside it, and the answer under them. The icon
 * copies THAT answer only, as formatted text (so lists, bold and tables survive a paste into a document) with a plain-text fallback for a
 * box that takes none.
 *
 * Everything is built with createElement and textContent. While an answer is still being written or checked the block says so and offers no
 * copy icon: what can be copied is what the person is going to be given.
 */

import { parseAnswers, plainText } from './answerSplit.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const COPIED_MS = 1500

const PENDING_TEXT = { writing: 'writing…', checking: 'checking…' }

function icon(doc, copied) {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const add = (tag, attrs) => {
    const node = doc.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    svg.append(node)
  }
  if (copied) add('path', { d: 'M3.5 8.5l3 3 6-7' })
  else {
    add('rect', { x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.5' })
    add('path', { d: 'M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1.5' })
  }
  return svg
}

/** The answer as the clipboard gets it: formatted (HTML, without the buttons the page added) and plain. */
export function clipboardFormsOf(body, markdown) {
  const clone = body.cloneNode(true)
  for (const head of clone.querySelectorAll('.code-head')) head.remove()
  return { html: `<div>${clone.innerHTML}</div>`, text: plainText(markdown) }
}

async function copyForms({ html, text }, body, doc) {
  const nav = globalThis.navigator
  try {
    if (nav?.clipboard?.write && globalThis.ClipboardItem) {
      await nav.clipboard.write([new globalThis.ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
      return true
    }
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the selection copy below */
  }
  try {
    // The oldest way, which still keeps the formatting: select the rendered answer and copy the selection.
    const range = doc.createRange()
    range.selectNodeContents(body)
    const selection = doc.defaultView?.getSelection?.()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const ok = doc.execCommand?.('copy') === true
    selection?.removeAllRanges()
    return ok
  } catch {
    return false
  }
}

/**
 * One answer block.
 * @param {{ label: string, markdown: string }} part
 * @param {{ renderBody: (container: Element, markdown: string, doc: Document) => void, pending?: 'writing'|'checking'|null }} options
 */
export function answerBlock(doc, part, { renderBody, pending = null }) {
  const block = doc.createElement('section')
  block.className = 'answer-block'
  block.dataset.answer = part.label
  if (pending) block.dataset.pending = pending

  const head = doc.createElement('div')
  head.className = 'answer-head'
  const label = doc.createElement('span')
  label.className = 'answer-label'
  label.textContent = part.label
  const state = doc.createElement('span')
  state.className = 'answer-state'
  state.setAttribute('role', 'status')
  state.setAttribute('aria-live', 'polite')
  state.textContent = pending ? PENDING_TEXT[pending] : ''
  head.append(label)

  const body = doc.createElement('div')
  body.className = 'answer-body'
  renderBody(body, part.markdown, doc)

  if (!pending) {
    const copy = doc.createElement('button')
    copy.type = 'button'
    copy.className = 'answer-copy'
    const name = part.label === 'ANSWER' ? 'Copy answer' : `Copy ${part.label.toLowerCase()}`
    copy.setAttribute('aria-label', name)
    copy.title = 'Copy'
    copy.append(icon(doc, false))
    let timer = null
    copy.addEventListener('click', async () => {
      const done = await copyForms(clipboardFormsOf(body, part.markdown), body, doc)
      copy.replaceChildren(icon(doc, done))
      copy.dataset.copied = done ? 'true' : 'failed'
      state.textContent = done ? 'Copied' : 'Not copied'
      clearTimeout(timer)
      timer = setTimeout(() => {
        copy.replaceChildren(icon(doc, false))
        delete copy.dataset.copied
        state.textContent = ''
      }, COPIED_MS)
    })
    head.append(copy)
  }
  head.append(state)
  block.append(head, body)
  return block
}

/**
 * Draws `text` into `container` as answer blocks. Text without ANSWER headings is left alone (returns false) unless `alwaysBlock` is set,
 * which draws it as the one answer it is (the study panel does: everything there is an answer).
 * @returns {boolean} whether the container was drawn
 */
export function renderAnswerBlocks(container, text, doc, { renderBody, alwaysBlock = false, pending = null } = {}) {
  const parsed = parseAnswers(text)
  if (!parsed.labelled && !alwaysBlock) return false
  const nodes = []
  const plain = (markdown, className) => {
    const node = doc.createElement('div')
    node.className = className
    renderBody(node, markdown, doc)
    return node
  }
  if (parsed.lead) nodes.push(plain(parsed.lead, 'answer-lead'))
  for (const part of parsed.parts) nodes.push(answerBlock(doc, part, { renderBody, pending }))
  if (parsed.sources) nodes.push(plain(parsed.sources, 'answer-sources'))
  container.replaceChildren(...nodes)
  return true
}

export { parseAnswers }
