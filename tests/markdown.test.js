import assert from 'node:assert/strict'
import test from 'node:test'
import { isSafeUrl, parseInline, parseMarkdown } from '../src/interfaces/chat/markdown.js'

/** Inline nodes -> a compact string, so expectations stay readable. */
function show(nodes) {
  return nodes
    .map((node) => {
      switch (node.t) {
        case 'text':
          return node.v
        case 'code':
          return `\`${node.v}\``
        case 'strong':
          return `**${show(node.c)}**`
        case 'em':
          return `*${show(node.c)}*`
        case 'link':
          return `[${show(node.c)}](${node.href})`
        case 'br':
          return '⏎'
        default:
          return `?${node.t}`
      }
    })
    .join('')
}
const inline = (text) => show(parseInline(text))

/** Blocks -> a compact outline. */
function outline(blocks) {
  return blocks.map((block) => {
    switch (block.type) {
      case 'paragraph':
        return `p:${show(block.inline)}`
      case 'heading':
        return `h${block.level}:${show(block.inline)}`
      case 'code':
        return `code(${block.lang}):${block.text}`
      case 'rule':
        return 'hr'
      case 'quote':
        return `quote[${outline(block.blocks).join(' | ')}]`
      case 'bullet':
      case 'ordered':
        return `${block.type}[${block.items.map((item) => show(item.inline) + (item.children.length ? `{${outline(item.children).join(' | ')}}` : '')).join(' ; ')}]`
      case 'table':
        return `table[${block.head.map(show).join(',')} / ${block.rows.map((row) => row.map(show).join(',')).join(' / ')}]`
      default:
        return `?${block.type}`
    }
  })
}
const md = (text) => outline(parseMarkdown(text))

test('inline: code, bold, italic and links', () => {
  assert.equal(inline('use `npm test` now'), 'use `npm test` now')
  assert.equal(inline('this is **bold** text'), 'this is **bold** text')
  assert.equal(inline('this is *italic* and _also_ italic'), 'this is *italic* and *also* italic')
  assert.equal(inline('**bold and *nested italic* inside**'), '**bold and *nested italic* inside**')
  assert.equal(inline('see [the docs](https://example.com/a?b=1) for more'), 'see [the docs](https://example.com/a?b=1) for more')
})

test('inline: markers that are not formatting stay as text', () => {
  assert.equal(inline('snake_case_name is one word'), 'snake_case_name is one word')
  assert.equal(inline('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24')
  assert.equal(inline('a * b'), 'a * b')
  assert.equal(inline('price is $5 ** not bold **'), 'price is $5 ** not bold **')
  assert.equal(inline('literal \\*stars\\* here'), 'literal *stars* here')
})

test('inline: a reply that is still arriving is shown as plain text until it closes', () => {
  assert.equal(inline('this is **bol'), 'this is **bol')
  assert.equal(inline('see [the do'), 'see [the do')
  assert.equal(inline('see [the docs](https://exa'), 'see [the docs](https://exa')
  assert.equal(inline('run `npm te'), 'run `npm te')
  assert.equal(inline('this is **bol'), 'this is **bol')
  assert.equal(inline('this is **bold**'), 'this is **bold**', 'and it becomes bold the moment it closes')
})

test('inline: code spans are literal (no formatting inside)', () => {
  assert.equal(inline('use `**not bold**` here'), 'use `**not bold**` here')
  assert.equal(inline('``a `tick` inside``'), '`a `tick` inside`')
})

test('links: only http, https and mailto become links', () => {
  assert.ok(isSafeUrl('https://example.com'))
  assert.ok(isSafeUrl('http://example.com/x'))
  assert.ok(isSafeUrl('mailto:a@b.co'))
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html;base64,AAAA', 'vbscript:x', '/relative', '//evil.test', 'file:///etc/passwd', '', null]) {
    assert.equal(isSafeUrl(bad), false, String(bad))
  }
  assert.equal(inline('[click](javascript:alert(1))'), 'click', 'an unsafe target keeps only its text')
  assert.equal(inline('[a](data:text/html,x)'), 'a')
  assert.equal(inline('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))'), '[wiki](https://en.wikipedia.org/wiki/Foo_(bar))', 'balanced parentheses stay in the url')
  assert.equal(inline('[a](https://x.test "a title") after'), '[a](https://x.test) after')
})

test('HTML in a reply is plain text, never markup', () => {
  assert.equal(inline('<script>alert(1)</script>'), '<script>alert(1)</script>')
  assert.equal(inline('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>')
  assert.deepEqual(md('<b onclick="x()">hi</b>'), ['p:<b onclick="x()">hi</b>'])
  const tree = JSON.stringify(parseMarkdown('<script>alert(1)</script> [x](https://a.test)'))
  assert.ok(!tree.includes('"t":"html"') && !tree.includes('"type":"html"'))
})

test('paragraphs, with a single newline kept as a line break', () => {
  assert.deepEqual(md('first line\nsecond line\n\nnew paragraph'), ['p:first line⏎second line', 'p:new paragraph'])
})

test('headings', () => {
  assert.deepEqual(md('# One\n## Two **bold**\n###### Six\n####### seven hashes'), ['h1:One', 'h2:Two **bold**', 'h6:Six', 'p:####### seven hashes'])
})

test('bullet and numbered lists', () => {
  assert.deepEqual(md('- one\n- two\n- three'), ['bullet[one ; two ; three]'])
  assert.deepEqual(md('* a\n* b'), ['bullet[a ; b]'])
  assert.deepEqual(md('1. first\n2. second\n3) third'), ['ordered[first ; second ; third]'], '"3)" and "3." both number a list')
  assert.equal(parseMarkdown('3. three\n4. four')[0].start, 3, 'a list that starts at 3 says so')
})

test('nested lists and list items with a continuation', () => {
  assert.deepEqual(md('- fruit\n  - apple\n  - pear\n- veg'), ['bullet[fruit{bullet[apple ; pear]} ; veg]'])
  assert.deepEqual(md('1. step one\n   - detail a\n   - detail b\n2. step two'), ['ordered[step one{bullet[detail a ; detail b]} ; step two]'])
})

test('a blank line between items keeps one list', () => {
  assert.deepEqual(md('- one\n\n- two'), ['bullet[one ; two]'])
})

test('a paragraph then a list, with no blank line between', () => {
  assert.deepEqual(md('Here are the steps:\n- one\n- two'), ['p:Here are the steps:', 'bullet[one ; two]'])
})

test('fenced code blocks keep their text exactly, including markdown inside', () => {
  assert.deepEqual(md('```js\nconst a = **1**\n- not a list\n```'), ['code(js):const a = **1**\n- not a list'])
  assert.deepEqual(md('~~~\nplain\n~~~'), ['code():plain'])
  assert.deepEqual(md('before\n\n```\ncode\n```\n\nafter'), ['p:before', 'code():code', 'p:after'])
})

test('an unclosed code fence is a code block that grows while the reply arrives', () => {
  assert.deepEqual(md('```python\nprint(1)'), ['code(python):print(1)'])
  assert.deepEqual(md('```python\nprint(1)\nprint(2)'), ['code(python):print(1)\nprint(2)'])
  assert.deepEqual(md('```python\nprint(1)\n```'), ['code(python):print(1)'])
})

test('a longer closing fence ends the block; a shorter one inside does not', () => {
  assert.deepEqual(md('````\n```\ninner\n```\n````'), ['code():```\ninner\n```'])
})

test('block quotes, which may hold other blocks', () => {
  assert.deepEqual(md('> quoted **text**\n> more'), ['quote[p:quoted **text**⏎more]'])
  assert.deepEqual(md('> - a\n> - b'), ['quote[bullet[a ; b]]'])
})

test('horizontal rules are not mistaken for lists', () => {
  assert.deepEqual(md('above\n\n---\n\nbelow'), ['p:above', 'hr', 'p:below'])
  assert.deepEqual(md('***'), ['hr'])
  assert.deepEqual(md('- - -'), ['hr'])
})

test('tables', () => {
  assert.deepEqual(md('| Name | Qty |\n|------|-----|\n| apple | 3 |\n| **pear** | 12 |'), ['table[Name,Qty / apple,3 / **pear**,12]'])
  assert.deepEqual(md('a | b\n--- | ---\n1 | 2'), ['table[a,b / 1,2]'])
  assert.deepEqual(md('| a | b |\n|---|---|\n| only one |'), ['table[a,b / only one,]'], 'a short row is padded')
})

test('a line with a pipe but no separator row is not a table', () => {
  assert.deepEqual(md('a | b | c'), ['p:a | b | c'])
})

test('a realistic reply', () => {
  const reply = [
    'Here is a plan:',
    '',
    '## Steps',
    '1. Install **Node** from [nodejs.org](https://nodejs.org)',
    '2. Run:',
    '```bash',
    'npm install',
    '```',
    '',
    '> Tip: use `npm ci` in CI.'
  ].join('\n')
  assert.deepEqual(md(reply), [
    'p:Here is a plan:',
    'h2:Steps',
    'ordered[Install **Node** from [nodejs.org](https://nodejs.org) ; Run:]',
    'code(bash):npm install',
    'quote[p:Tip: use `npm ci` in CI.]'
  ])
})

test('empty and odd input never throws', () => {
  for (const input of ['', '   ', '\n\n', null, undefined, '*', '**', '`', '```', '[', '[]()', '> ', '- ', '|', '#', '\\', '\r\n']) {
    assert.doesNotThrow(() => parseMarkdown(input), JSON.stringify(input))
  }
  assert.deepEqual(parseMarkdown(''), [])
})

test('a very long reply is parsed quickly (every token re-parses it while streaming)', () => {
  const big = Array.from({ length: 400 }, (_, i) => `- item ${i} with **bold** and \`code\` and [link](https://example.com/${i})`).join('\n')
  const started = performance.now()
  const blocks = parseMarkdown(big)
  const elapsed = performance.now() - started
  assert.equal(blocks[0].items.length, 400)
  assert.ok(elapsed < 250, `took ${elapsed.toFixed(0)} ms`)
})

test('pathological input does not hang', () => {
  const nasty = ['*'.repeat(5000), '_'.repeat(5000), '['.repeat(2000), '`'.repeat(3000), '**a '.repeat(2000), '> '.repeat(500) + 'x', '- '.repeat(2000)]
  for (const input of nasty) {
    const started = performance.now()
    parseMarkdown(input)
    assert.ok(performance.now() - started < 1500, `${input.slice(0, 8)}… took ${(performance.now() - started).toFixed(0)} ms`)
  }
})
