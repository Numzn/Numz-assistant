// End-to-end check of the UPDATE LINE in the real desktop app on Linux/X11: the real app, the real page, a stand-in list of versions on this
// computer (the app is told to ask it with NUMZ_UPDATE_URL, which a debug build honours).
//
//   Xvfb -> the REAL desktop app (Tauri/WebKitGTK) driven through WebDriver, showing the real NUMZ AI page
//        -> the page asks the app for updates; the app asks the stand-in list of versions and, when told to install, downloads from it
//
// What it proves: no line when the newest version is the one running; a line (with the versions) when a newer one is listed; "Not now" puts
// it away and it stays away after a reload; "Update now" downloads and then REFUSES an update whose signature is not made by the app's own
// key (nothing is installed, the line says why and offers another try); an update whose signature IS made by the key passes that check
// (it then fails later, because this Linux app is not an AppImage that can replace itself - the failure is a different one);
// and a page that is not the real site cannot ask for either command.
//
//   node desktop/e2e/update.mjs   (the app built with the test capability and the insecure-transport switch, see desktop/README.md)
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reporter, repo, startApp } from '../../scripts/camera-e2e/lib.mjs'
import { startFakeVision } from './fakeVision.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = process.env.NUMZ_DESKTOP_BIN || path.resolve(here, '../src-tauri/target/debug/numz-ai-desktop')
const DRIVER = path.join(os.homedir(), '.cargo/bin/tauri-driver')
const DISPLAY = process.env.E2E_DISPLAY || ':95'
const KEY = process.env.NUMZ_UPDATER_KEY || path.join(os.homedir(), '.numz-updater/updater.key')
const PASSWORD = process.env.NUMZ_UPDATER_PASSWORD_FILE || path.join(os.homedir(), '.numz-updater/updater.password')
const env = { ...process.env, DISPLAY, WEBKIT_DISABLE_COMPOSITING_MODE: '1', WEBKIT_DISABLE_DMABUF_RENDERER: '1', NO_AT_BRIDGE: '1' }
const { check, finish } = reporter()
const children = []
const track = (cmd, args, opts = {}) => {
  const c = spawn(cmd, args, { env, stdio: 'ignore', ...opts })
  children.push(c)
  return c
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numz-update-'))
const config = JSON.parse(fs.readFileSync(path.resolve(here, '../src-tauri/tauri.conf.json'), 'utf8'))

// ---- the stand-in list of versions, and what it serves ----------------------------------------------------------------------
const payload = Buffer.from('this is not an installer, it is a stand-in payload '.repeat(200))
/** A signature in minisign's format made with a throw-away key: well formed, and not made by the app's own key. */
function foreignSignature(bytes) {
  const { privateKey } = generateKeyPairSync('ed25519')
  const body = Buffer.concat([Buffer.from('ED'), Buffer.from('1122334455667788', 'hex'), sign(null, createHash('blake2b512').update(bytes).digest(), privateKey)])
  return Buffer.from(`untrusted comment: signature from tauri secret key\n${body.toString('base64')}\ntrusted comment: timestamp:1\nAAAA\n`).toString('base64')
}
/** A signature made by the app's REAL private key (on this host), exactly as a release is signed. */
function realSignature(file) {
  execFileSync('npx', ['--yes', '@tauri-apps/cli@2.12.4', 'signer', 'sign', '-f', KEY, file], { env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: fs.existsSync(PASSWORD) ? fs.readFileSync(PASSWORD, 'utf8').trim() : '' }, stdio: 'ignore' })
  return fs.readFileSync(`${file}.sig`, 'utf8').trim()
}
const served = { manifest: { version: config.version }, manifestAsked: 0, payloadAsked: 0 }
const lister = http.createServer((req, res) => {
  if (req.url.startsWith('/payload')) {
    served.payloadAsked++
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length })
    return res.end(payload)
  }
  served.manifestAsked++
  const m = served.manifest
  const body = m.version === config.version ? null : { version: m.version, notes: 'Faster answers, and an update line.', pub_date: '2026-11-24T00:00:00Z', platforms: { 'linux-x86_64': { signature: m.signature, url: `http://127.0.0.1:${lister.address().port}/payload` } } }
  if (!body) {
    res.writeHead(204)
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
})
await new Promise((r) => lister.listen(0, '127.0.0.1', r))

// ---- the page, in the app ---------------------------------------------------------------------------------------------------
execFileSync('npx', ['vite', 'build'], { cwd: repo, env: { ...process.env, VITE_PUBLIC_BASE: '/' }, stdio: 'ignore' })
track('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'])
for (let i = 0; i < 50; i++) {
  try {
    execFileSync('xdpyinfo', { env, stdio: 'ignore' })
    break
  } catch {
    await sleep(100)
  }
}
const vision = await startFakeVision()
const server = await startApp({ dir, port: 18477, stubPort: vision.port })
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: server.port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${server.port}` } }, (a) => {
    const h = { ...a.headers }
    if (h['content-security-policy']) h['content-security-policy'] = String(h['content-security-policy']).replace(/;?\s*upgrade-insecure-requests/i, '')
    res.writeHead(a.statusCode, h)
    a.pipe(res)
  })
  up.on('error', () => res.destroy())
  req.pipe(up)
})
await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${proxy.address().port}`
track(DRIVER, ['--port', '4457', '--native-port', '4458', '--native-driver', '/usr/bin/WebKitWebDriver'], { env: { ...env, NUMZ_AI_URL: `${base}/`, NUMZ_UPDATE_URL: `http://127.0.0.1:${lister.address().port}/latest.json` } })
const wd = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:4457${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`)
  return json.value
}
let sid = null
const run = (script) => wd('POST', `/session/${sid}/execute/sync`, { script, args: [] })
const lineState = () => run('const l = document.getElementById("updateLine"); return { hidden: l.hidden, text: l.textContent, buttons: [...l.querySelectorAll("button")].map((b) => b.textContent), bodyFlag: document.body.dataset.update }')
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e.message
    }
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label} (${JSON.stringify(last)?.slice(0, 200)})`)
}
const reload = async () => {
  await run('location.reload(); return true')
  await sleep(1500)
  await waitFor(() => run('return document.readyState==="complete" && !!document.getElementById("updateLine")'), 30000, 'the page to reload')
}
const clickLineButton = (label) => run(`const b = [...document.querySelectorAll("#updateLine button")].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true`)
const FIRST_LOOK_WAIT = 45000 // the page looks 15 s after it opens

try {
  for (let i = 0; i < 100 && !sid; i++) {
    try {
      sid = (await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } })).sessionId
    } catch {
      await sleep(300)
    }
  }
  if (!sid) throw new Error('no WebDriver session')
  await waitFor(() => run('return document.readyState==="complete" && !!document.getElementById("updateLine")'), 40000, 'the page in the app')
  check('the page is open in the app, and the update line is there but hidden', (await run('return location.origin')) === base && (await lineState()).hidden === true)

  // 1. the newest version is the one running: no line.
  await waitFor(() => served.manifestAsked >= 1, FIRST_LOOK_WAIT, 'the first look for an update')
  await sleep(1500)
  check('the page looked for an update, and the one running is the newest: no line', served.manifestAsked >= 1 && (await lineState()).hidden === true, JSON.stringify(await lineState()))

  // 2. a newer version is listed (signed by a stranger): the line appears with the versions.
  served.manifest = { version: '9.9.0', signature: foreignSignature(payload) }
  await reload()
  const offered = await waitFor(async () => { const s = await lineState(); return s.hidden === false ? s : null }, FIRST_LOOK_WAIT, 'the update line')
  check('a newer version is offered: the line says which, and what you have, with the two buttons', /9\.9\.0/.test(offered.text) && new RegExp(config.version.replaceAll('.', '\\.')).test(offered.text) && offered.buttons.join('|') === 'Update now|Not now' && offered.bodyFlag === 'true', JSON.stringify(offered))
  check('the line takes one thin row at the top: the page moved down to make room', await run('const l = document.getElementById("updateLine").getBoundingClientRect(); const a = document.getElementById("app").getBoundingClientRect(); return l.top === 0 && l.height <= 40 && Math.abs(a.top - l.height) <= 2'))

  // 3. "Not now" puts it away, and it stays away after a reload (until the app is started again).
  await clickLineButton('Not now')
  check('"Not now" puts the line away', (await lineState()).hidden === true)
  const before = served.manifestAsked
  await reload()
  await waitFor(() => served.manifestAsked > before, FIRST_LOOK_WAIT, 'another look after the reload')
  await sleep(1500)
  check('and the same version is not offered again after a reload', (await lineState()).hidden === true)

  // 4. a newer one still: the update is downloaded, and refused because it is not signed with the app's own key.
  served.manifest = { version: '9.9.1', signature: foreignSignature(payload) }
  await reload()
  await waitFor(async () => (await lineState()).hidden === false, FIRST_LOOK_WAIT, 'the line for 9.9.1')
  check('a newer version than the one put away is offered', /9\.9\.1/.test((await lineState()).text))
  await clickLineButton('Update now')
  const refused = await waitFor(async () => { const s = await lineState(); return /not signed by NUMZ AI/.test(s.text) ? s : null }, 30000, 'the refusal')
  check('an update signed by someone else is downloaded and then REFUSED: the line says it was not signed, and offers another try', served.payloadAsked >= 1 && refused.buttons.join('|') === 'Try again|Not now', `${served.payloadAsked} downloads, ${JSON.stringify(refused)}`)
  check('nothing was installed: the app is still running the same version', (await run('return document.readyState')) === 'complete')

  // 5. signed with the app's own key: it passes the signature check (and then fails later, as a Linux binary that is not an AppImage cannot replace itself).
  if (fs.existsSync(KEY)) {
    const file = path.join(dir, 'payload.bin')
    fs.writeFileSync(file, payload)
    served.manifest = { version: '9.9.2', signature: realSignature(file) }
    await reload()
    await waitFor(async () => (await lineState()).hidden === false, FIRST_LOOK_WAIT, 'the line for 9.9.2')
    const asked = served.payloadAsked
    await clickLineButton('Update now')
    const outcome = await waitFor(async () => { const s = await lineState(); return /could not be installed|not signed/.test(s.text) ? s : null }, 30000, 'the outcome')
    check('an update signed with the app\'s own key PASSES the signature check (it fails afterwards, at installing, not at the signature)', served.payloadAsked > asked && /could not be installed/.test(outcome.text) && !/not signed/.test(outcome.text), JSON.stringify(outcome))
  } else {
    console.log('(skipped: the private key is not on this machine, so an update signed with it cannot be made)')
  }
} catch (err) {
  check('the run completed', false, String(err.message).slice(0, 300))
} finally {
  try {
    if (sid) await wd('DELETE', `/session/${sid}`)
  } catch {
    /* gone */
  }
  await new Promise((r) => proxy.close(r))
  await new Promise((r) => lister.close(r))
  await server.stop().catch(() => {})
  await vision.close().catch(() => {})
  for (const c of children.reverse()) c.kill('SIGTERM')
}
process.exit(finish() ? 0 : 1)
