import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The web fonts (about 70 KB) used to start downloading as soon as the stylesheet arrived, so on a slow connection
 * they shared the link with the page's script and delayed it. They now start only when enableWebFonts() adds
 * data-fonts to <html>, after the script has run. A browser fetches a font only when a rule uses its family, so the
 * guarantee is a matter of where those family names appear. These tests hold it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '')
const FAMILIES = ['Inter', 'Instrument Serif', 'JetBrains Mono']
const TOKENS = ['--font:', '--font-serif:', '--font-mono:']

/** The declarations inside the first block whose selector is exactly `selector`. */
function block(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `style.css has no "${selector}" block`)
  return match[1]
}

test('the default font tokens name no web font, so nothing downloads on first paint', () => {
  const tokens = block(':root')
  for (const token of TOKENS) assert.ok(tokens.includes(token), `${token} is defined in :root`)
  for (const family of FAMILIES) assert.equal(tokens.includes(family), false, `:root must not name "${family}"`)
})

test(':root[data-fonts] is what names the three web fonts', () => {
  const tokens = block(':root[data-fonts]')
  for (const token of TOKENS) assert.ok(tokens.includes(token), `${token} is redefined under data-fonts`)
  for (const family of FAMILIES) assert.ok(tokens.includes(`"${family}"`), `data-fonts uses "${family}"`)
})

test('no other rule uses a web font family directly (that would start the download early)', () => {
  const rest = css
    .replace(/@font-face\s*\{[^}]*\}/g, '')
    .replace(/:root\[data-fonts\]\s*\{[^}]*\}/, '')
  for (const family of FAMILIES) assert.equal(rest.includes(family), false, `"${family}" is named outside @font-face and :root[data-fonts]`)
  for (const family of FAMILIES) assert.ok(css.includes(`font-family: "${family}"`), `@font-face for ${family} is still there`)
})

test('both pages switch the fonts on, at the top level of their script, from the one helper', () => {
  for (const file of ['src/main.js', 'src/history.js']) {
    const source = read(file)
    assert.match(source, /import \{[^}]*\benableWebFonts\b[^}]*\} from '\.\/interfaces\/layout\/workspace\.js'/, `${file} imports it`)
    assert.match(source, /^enableWebFonts\(\)$/m, `${file} calls it as a top-level statement`)
  }
})
