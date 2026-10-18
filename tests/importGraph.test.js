import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Guards the page load: nothing the browser runs up front may statically reach Three.js or the Picovoice SDK.
 * They are 0.5 MB and 1.1 MB, they were 91% of the page, and one stray `import * as THREE` is enough to put
 * them back. The graph is followed from the entry scripts named by the pages; `import()` is not followed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRIES = ['src/main.js', 'src/history.js']

const FORBIDDEN_PACKAGES = [/^three($|\/)/, /^@picovoice\//]
const FORBIDDEN_LOCAL = ['src/orb/createOrb.js', 'src/interfaces/voice/porcupineSdk.js']
const FORBIDDEN_LOCAL_DIRS = ['src/engine/', 'src/animation/']

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** { statics: string[], dynamics: string[] } of module specifiers. */
export function specifiersOf(source) {
  const code = stripComments(source)
  const statics = []
  const dynamics = []
  for (const m of code.matchAll(/(?:^|[\n;])\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) statics.push(m[1])
  for (const m of code.matchAll(/(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g)) statics.push(m[1])
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) dynamics.push(m[1])
  return { statics, dynamics }
}

function resolveLocal(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

function walkStatic(entries) {
  const seen = new Map() // absolute file -> the file that first imported it
  const bare = [] // { from, specifier }
  const dynamicImports = []
  const queue = entries.map((entry) => [path.join(root, entry), null])
  while (queue.length) {
    const [file, parent] = queue.shift()
    if (seen.has(file)) continue
    seen.set(file, parent)
    if (!file.endsWith('.js')) continue
    const { statics, dynamics } = specifiersOf(fs.readFileSync(file, 'utf8'))
    for (const specifier of dynamics) dynamicImports.push({ from: file, specifier })
    for (const specifier of statics) {
      if (specifier.startsWith('.')) {
        const target = resolveLocal(file, specifier)
        assert.ok(target, `${path.relative(root, file)} imports ${specifier}, which does not exist`)
        queue.push([target, file])
      } else {
        bare.push({ from: file, specifier })
      }
    }
  }
  return { files: seen, bare, dynamicImports }
}

const rel = (file) => path.relative(root, file).split(path.sep).join('/')

test('the first page load cannot statically reach Three.js, the orb, or the Picovoice SDK', () => {
  const { files, bare } = walkStatic(ENTRIES)

  const badPackages = bare.filter(({ specifier }) => FORBIDDEN_PACKAGES.some((re) => re.test(specifier)))
  assert.deepEqual(
    badPackages.map(({ from, specifier }) => `${rel(from)} imports '${specifier}'`),
    [],
    'a heavy package is imported statically; use a dynamic import() (see src/orb/orbLoader.js)'
  )

  const reached = [...files.keys()].map(rel)
  const badLocal = reached.filter((f) => FORBIDDEN_LOCAL.includes(f) || FORBIDDEN_LOCAL_DIRS.some((dir) => f.startsWith(dir)))
  assert.deepEqual(badLocal, [], 'a module that pulls in a heavy package is imported statically')
})

test('the walk really covers the app (it would pass vacuously on an empty graph)', () => {
  const { files } = walkStatic(ENTRIES)
  const reached = new Set([...files.keys()].map(rel))
  for (const must of ['src/main.js', 'src/orb/orbLoader.js', 'src/interfaces/voice/porcupineWake.js', 'src/interfaces/voice/voiceOrchestrator.js', 'src/assistant/controller.js']) {
    assert.ok(reached.has(must), `${must} should be on the first-load path`)
  }
  assert.ok(reached.size > 25, `only ${reached.size} modules reached`)
})

test('the heavy parts are reachable, but only through import()', () => {
  const { dynamicImports } = walkStatic(ENTRIES)
  const dynamic = dynamicImports.map(({ from, specifier }) => `${rel(from)} -> ${specifier}`)
  assert.ok(dynamic.includes('src/orb/orbLoader.js -> ./createOrb.js'), dynamic.join('\n'))
  assert.ok(dynamic.includes('src/interfaces/voice/porcupineWake.js -> ./porcupineSdk.js'), dynamic.join('\n'))

  // And the lazy modules do import what they are there to hold.
  assert.ok(specifiersOf(fs.readFileSync(path.join(root, 'src/orb/createOrb.js'), 'utf8')).statics.includes('../core/core.js'))
  const sdk = specifiersOf(fs.readFileSync(path.join(root, 'src/interfaces/voice/porcupineSdk.js'), 'utf8')).statics
  assert.deepEqual(sdk.sort(), ['@picovoice/porcupine-web', '@picovoice/web-voice-processor'])
})

test('the import scanner handles the shapes the code uses', () => {
  const { statics, dynamics } = specifiersOf(`
    import a from './a.js'
    import { b,
      c } from "./b.js"
    import * as THREE from 'three'
    import './side-effect.css'
    export { d } from './d.js'
    // import nope from './comment.js'
    /* import nope2 from './block.js' */
    const lazy = () => import('./lazy.js')
    const url = 'http://example.com/not-an-import'
  `)
  assert.deepEqual(statics.sort(), ['./a.js', './b.js', './d.js', './side-effect.css', 'three'])
  assert.deepEqual(dynamics, ['./lazy.js'])
})
