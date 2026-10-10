/**
 * Draws the tree from markdown.js as DOM. Elements are made with createElement/createTextNode only: nothing in a
 * reply is ever parsed as HTML. Links open in a new tab with noopener noreferrer.
 */

import { parseMarkdown } from './markdown.js'

const COPIED_MS = 1500

export function renderMarkdown(container, text, doc = container.ownerDocument ?? document) {
  container.replaceChildren(...blockNodes(parseMarkdown(text), doc))
}

function el(doc, tag, className, children = []) {
  const node = doc.createElement(tag)
  if (className) node.className = className
  for (const child of children) node.append(child)
  return node
}

function inlineNodes(nodes, doc) {
  return nodes.map((node) => {
    switch (node.t) {
      case 'code':
        return el(doc, 'code', 'inline', [doc.createTextNode(node.v)])
      case 'strong':
        return el(doc, 'strong', '', inlineNodes(node.c, doc))
      case 'em':
        return el(doc, 'em', '', inlineNodes(node.c, doc))
      case 'link': {
        const a = el(doc, 'a', '', inlineNodes(node.c, doc))
        a.href = node.href
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        return a
      }
      case 'br':
        return doc.createElement('br')
      default:
        return doc.createTextNode(node.v ?? '')
    }
  })
}

function codeBlock(block, doc) {
  const label = el(doc, 'span', 'lang', [doc.createTextNode(block.lang || 'code')])
  const copy = el(doc, 'button', 'copy', [doc.createTextNode('Copy')])
  copy.type = 'button'
  copy.setAttribute('aria-label', 'Copy code')
  copy.addEventListener('click', async () => {
    let result = 'Copied'
    try {
      await globalThis.navigator.clipboard.writeText(block.text)
    } catch {
      result = 'Not copied'
    }
    copy.textContent = result
    setTimeout(() => (copy.textContent = 'Copy'), COPIED_MS)
  })
  const code = el(doc, 'code', '', [doc.createTextNode(block.text)])
  return el(doc, 'div', 'code-block', [el(doc, 'div', 'code-head', [label, copy]), el(doc, 'pre', '', [code])])
}

function listNode(block, doc) {
  const list = doc.createElement(block.type === 'ordered' ? 'ol' : 'ul')
  if (block.type === 'ordered' && block.start !== 1) list.start = block.start
  for (const item of block.items) {
    list.append(el(doc, 'li', '', [...inlineNodes(item.inline, doc), ...blockNodes(item.children, doc)]))
  }
  return list
}

function tableNode(block, doc) {
  const head = el(doc, 'thead', '', [el(doc, 'tr', '', block.head.map((cell) => el(doc, 'th', '', inlineNodes(cell, doc))))])
  const body = el(
    doc,
    'tbody',
    '',
    block.rows.map((row) => el(doc, 'tr', '', row.map((cell) => el(doc, 'td', '', inlineNodes(cell, doc)))))
  )
  return el(doc, 'div', 'table-wrap', [el(doc, 'table', '', [head, body])])
}

function blockNodes(blocks, doc) {
  return blocks.map((block) => {
    switch (block.type) {
      case 'heading':
        return el(doc, `h${Math.min(6, block.level + 2)}`, '', inlineNodes(block.inline, doc))
      case 'code':
        return codeBlock(block, doc)
      case 'bullet':
      case 'ordered':
        return listNode(block, doc)
      case 'quote':
        return el(doc, 'blockquote', '', blockNodes(block.blocks, doc))
      case 'rule':
        return doc.createElement('hr')
      case 'table':
        return tableNode(block, doc)
      default:
        return el(doc, 'p', '', inlineNodes(block.inline, doc))
    }
  })
}
