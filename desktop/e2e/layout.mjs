// Layout check of the Study / Meeting dock and the conversation in the REAL desktop app (Tauri + WebKitGTK, the engine a student on Linux
// actually has), in a real X window that a real window manager resizes: the same measurements as scripts/ui-layout-e2e (one shared function,
// scripts/ui-layout-e2e/measure.mjs), asked of a different engine.
//
//   Xvfb + openbox -> the REAL desktop app -> the REAL NUMZ AI server (per-person sign-in through the REAL numzlab-auth broker) with a
//   stand-in text model. Nothing about the page is faked; there is no screen reading here (that is desktop/e2e/study.mjs).
//
//   node desktop/e2e/layout.mjs      (needs what desktop/README.md lists; run ONE desktop e2e at a time: they share display :94 and ports 4455/4456)
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reporter, repo } from '../../scripts/camera-e2e/lib.mjs'
import { measureLayout } from '../../scripts/ui-layout-e2e/measure.mjs'
import { Browser, freePort, startStack } from '../../tests/helpers/aiRig.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = process.env.NUMZ_DESKTOP_BIN || path.resolve(here, '../src-tauri/target/debug/numz-ai-desktop')
const DRIVER = process.env.TAURI_DRIVER || path.join(os.homedir(), '.cargo/bin/tauri-driver')
const NATIVE_DRIVER = process.env.WEBKIT_DRIVER || '/usr/bin/WebKitWebDriver'
const DISPLAY = process.env.E2E_DISPLAY || ':94'
const dir = process.env.UI_LAYOUT_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'numz-desktop-layout-'))
fs.mkdirSync(dir, { recursive: true })
console.log('working in', dir)
const { check, finish } = reporter()
const children = []
const env = { ...process.env, DISPLAY, WEBKIT_DISABLE_COMPOSITING_MODE: '1', WEBKIT_DISABLE_DMABUF_RENDERER: '1', NO_AT_BRIDGE: '1' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const track = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  child.log = ''
  child.stdout.on('data', (c) => (child.log += c))
  child.stderr.on('data', (c) => (child.log += c))
  children.push(child)
  return child
}
process.on('exit', () => {
  for (const child of [...children].reverse()) child.kill('SIGTERM')
})
const x = (...args) => execFileSync(args[0], args.slice(1), { env, encoding: 'utf8' }).trim()
const waitFor = async (fn, ms = 20000, label = 'condition') => {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label} (${last instanceof Error ? last.message : JSON.stringify(last)})`)
}
const portOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })

// ---- the desktop -----------------------------------------------------------------------------------------------------------
track('Xvfb', [DISPLAY, '-screen', '0', '1600x900x24', '-nolisten', 'tcp'])
await waitFor(() => { try { x('xdpyinfo'); return true } catch { return false } }, 10000, 'the X server')
track('openbox', [])
await sleep(800)

// ---- the pretend model: a streamed answer, so the conversation really has something to scroll -------------------------------
const ANSWER = 'Second normal form means every non-key column depends on the **whole** key.\n\n- the first point, about the key\n- the second point, about partial dependencies\n- the third point, with an example from an order line\n\nSo the product name belongs in its own table, keyed by the product number.'
const modelServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { /* none */ }
    const usage = { prompt_tokens: 100, completion_tokens: 50 }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const word of ANSWER.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [{ delta: { content: word } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [], usage })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { role: 'assistant', content: ANSWER } }], usage }))
  })
})
await new Promise((r) => modelServer.listen(0, '127.0.0.1', r))
const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`

console.log('building the NUMZ AI page for /ai/ ...')
execFileSync('npx', ['vite', 'build'], { cwd: repo, env: { ...process.env, VITE_PUBLIC_BASE: '/ai/' }, stdio: 'ignore' })
const frontPort = await freePort()
const origin = `http://127.0.0.1:${frontPort}`
const stack = await startStack({ front: origin, env: { AI_BASE_URL: modelUrl, ACADEMIC_RESEARCH: 'off' } })
const front = http.createServer((req, res) => {
  const port = req.url.startsWith('/auth') ? stack.ports.auth : stack.app.port
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${frontPort}` } }, (answer) => {
    const headers = { ...answer.headers }
    if (headers['content-security-policy']) headers['content-security-policy'] = String(headers['content-security-policy']).replace(/;?\s*upgrade-insecure-requests/i, '')
    res.writeHead(answer.statusCode, headers)
    answer.pipe(res)
  })
  up.on('error', () => res.destroy())
  req.pipe(up)
})
await new Promise((resolve) => front.listen(frontPort, '127.0.0.1', resolve))
await stack.numzlab.control('invite', { email: 'ada@example.com', role: 'operator' })
await stack.numzlab.control('google', { email: 'ada@example.com', sub: 'sub-ada', name: 'ada' })

// ---- the app ---------------------------------------------------------------------------------------------------------------
const driver = track(DRIVER, ['--port', '4455', '--native-port', '4456', '--native-driver', NATIVE_DRIVER], { env: { ...env, NUMZ_AI_URL: `${origin}/ai/` } })
await waitFor(() => portOpen(4455), 10000, 'tauri-driver')
let sid = null
async function wd(method, p, body) {
  const res = await fetch(`http://127.0.0.1:4455${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`)
  return json.value
}
const run = (script, ...args) => wd('POST', `/session/${sid}/execute/sync`, { script, args })
const click = (selector) => run('const el=document.querySelector(arguments[0]); if(!el) return false; el.click(); return true', selector)
const measure = () => run(`return (${measureLayout.toString()})()`)
const appWindow = () => x('xdotool', 'search', '--name', '^NUMZ AI').split('\n').pop()
const shot = async (name) => fs.writeFileSync(`${dir}/${name}.png`, Buffer.from(await wd('GET', `/session/${sid}/screenshot`), 'base64'))
/** Resizes the real window with the window manager and waits until the page reports the new width. */
async function size(w, h = 860) {
  const win = appWindow()
  x('xdotool', 'windowsize', win, String(w), String(h))
  x('xdotool', 'windowmove', win, '0', '0')
  // The app's window has a minimum size (720px wide, in src-tauri/src/lib.rs): asking for less leaves it at the minimum, which the caller sees.
  await waitFor(async () => Math.abs((await run('return innerWidth')) - w) <= 2, 4000, `the window to be ${w}px wide`).catch(() => {})
  await sleep(450)
}
const openStudy = async () => {
  if (await run('return document.getElementById("studyPanel").hidden')) await click('#studyButton')
  await waitFor(() => run('return !document.getElementById("studyPanel").hidden'), 5000, 'the Study panel')
}
const closeStudy = async () => {
  await click('#studyClose')
  await waitFor(() => run('return document.getElementById("studyPanel").hidden'), 5000, 'the Study panel to close')
  await sleep(350)
}
const answers = () => run('return document.querySelectorAll("li.msg[data-role=assistant]").length')
/** Types into the real composer and sends it, as a person would (through the page's own handlers). */
async function say(text) {
  const before = await answers()
  await waitFor(() => run('return !document.querySelector("#composerInput").disabled'), 10000, 'the composer')
  await run('const i=document.querySelector("#composerInput"); i.value=arguments[0]; i.dispatchEvent(new Event("input",{bubbles:true})); return true', text)
  await waitFor(() => run('return !document.querySelector("#sendButton").disabled'), 5000, 'Send to be enabled')
  await click('#sendButton')
  await waitFor(async () => (await answers()) > before, 30000, 'the answer')
  await waitFor(() => run('return document.querySelector("#assistantStateBadge")?.dataset.state === "IDLE"'), 10000, 'the assistant to be idle')
}

try {
  const created = await waitFor(() => wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } }), 30000, 'a WebDriver session')
  sid = created.sessionId
  await waitFor(() => run('return document.readyState==="complete" && !!document.getElementById("studyButton")'), 30000, 'the NUMZ AI page inside the app')
  const engine = await run('return navigator.userAgent')
  console.log('engine:', engine)
  check('the desktop app opened the NUMZ AI page (WebKit)', /AppleWebKit/.test(engine) && (await run('return location.pathname')) === '/ai/', engine.slice(0, 120))

  // Signed in "elsewhere" through the real broker; the session cookie is handed to the app's window (the app only navigates to the site).
  const jar = new Browser()
  await jar.signIn(`${origin}/ai`)
  const session = jar.jar.get(`127.0.0.1:${frontPort}`)?.get('numzai_session')
  if (!session?.value) throw new Error('the broker sign-in gave no session cookie')
  await wd('POST', `/session/${sid}/cookie`, { cookie: { name: 'numzai_session', value: session.value, path: '/ai', httpOnly: true, sameSite: 'Lax' } })
  await run('location.reload(); return true')
  await waitFor(() => run('return document.readyState==="complete" && document.getElementById("accessGate").hidden && !!document.getElementById("studyButton")'), 30000, 'the app to open signed in')
  await sleep(1500)

  await size(1280)
  for (const t of ['Hello', 'What is second normal form?', 'And third normal form?']) await say(t)
  await click('#studyButton')
  await waitFor(() => run('return !document.getElementById("studyPanel").hidden'), 5000, 'the Study panel')
  await run('const b=[...document.querySelectorAll("#studyBody button")].find((b)=>b.textContent.trim()==="Start session"); b.click(); return true')
  await waitFor(() => run('return !!document.getElementById("studyAskInput")'), 10000, 'the session to start')
  await closeStudy()

  // ==== wide: beside the conversation ====
  for (const w of [1280]) {
    await size(w)
    let m = await measure()
    check(`${w}px, nothing open: no dock, the conversation reaches the right edge, the composer is one row`, m.dock === null && m.chatMain.right === m.w && m.composerInput.w >= 150 && m.composer.h <= 90, JSON.stringify({ dock: m.dock, chatRight: m.chatMain.right, w: m.w, input: m.composerInput?.w, composerH: m.composer?.h }))
    await openStudy()
    await sleep(300)
    m = await measure()
    check(`${w}px, Study open: the dock is a column on the right and the conversation ends where it begins`, m.dock && m.dock.right === m.w && m.dock.w >= 340 && m.dock.w <= 421 && m.chatMain.right <= m.dock.x, JSON.stringify({ dock: m.dock, chatRight: m.chatMain.right }))
    check(`${w}px, Study open: the composer, its Send button, the last answer and the header buttons can be clicked`, m.reach['#composerInput'] && m.reach['#sendButton'] && m.reach['#thread > li:last-child'] && m.reach['#meetingButton'] && m.reach['#studyButton'], JSON.stringify(m.reach))
    check(`${w}px, Study open: the composer is one row with room to type`, m.composerInput.w >= 180 && m.composer.h <= 90, `box ${m.composerInput.w}px, composer ${m.composer.h}px`)
    check(`${w}px, Study open: no sideways scrolling`, !m.hScroll)
    await shot(`${w}-study`)
    await click('#meetingButton')
    await waitFor(() => run('return !document.getElementById("meetingPanel").hidden'), 5000, 'the Meeting panel')
    await sleep(300)
    m = await measure()
    check(`${w}px: opening Meeting closes Study (one panel at a time), in the same place`, m.visiblePanels.join() === 'meetingPanel' && m.chatMain.right <= m.dock.x, m.visiblePanels.join())
    await shot(`${w}-meeting`)
    await click('#studyButton')
    await waitFor(() => run('return !document.getElementById("studyPanel").hidden'), 5000, 'the Study panel')
    await closeStudy()
    m = await measure()
    check(`${w}px: closing the panel gives the width back`, m.dock === null && m.chatMain.right === m.w)
  }

  // ==== medium: the sidebar steps aside ====
  await size(1000)
  let m = await measure()
  check('1000px, nothing open: the sidebar is a column beside the conversation', m.sidebarVisible && m.chatMain.x === 272)
  await openStudy()
  await sleep(500)
  m = await measure()
  check('1000px, Study open: the sidebar stepped aside, the conversation sits beside the dock with room', !m.sidebarVisible && m.chatMain.x === 0 && m.chatMain.right <= m.dock.x && m.chatMain.w >= 480 && m.reach['#composerInput'] && m.reach['#sidebarToggle'], JSON.stringify({ chatX: m.chatMain.x, right: m.chatMain.right, dock: m.dock, reach: m.reach }))
  await shot('1000-study')
  await closeStudy()
  await sleep(300)
  m = await measure()
  check('1000px, closed again: the sidebar is back in its column', m.sidebarVisible && m.chatMain.x === 272)

  // ==== narrow (the study window beside what is being studied): the dock replaces the conversation under the header ====
  for (const w of [800, 720, 440]) {
    await size(w)
    const actual = await run('return innerWidth')
    if (Math.abs(actual - w) > 2) {
      console.log(`(the app's window cannot be made ${w}px wide (its minimum is 720px): it is ${actual}px; skipped)`)
      continue
    }
    const before = await run('const m=document.querySelector("#chatMain"); m.scrollTop=Math.max(0,m.scrollHeight/3); return m.scrollTop')
    await openStudy()
    await sleep(300)
    m = await measure()
    check(`${w}px, Study open: the header stays, the dock fills the rest under it, the conversation is hidden but kept`, m.header.y === 0 && Math.abs(m.dock.y - m.header.bottom) <= 1 && m.dock.w === m.w && m.dock.bottom === m.h && m.chatVisibility === 'hidden' && m.reach['#studyButton'] && m.reach['#studyAskInput'], JSON.stringify({ header: m.header, dock: m.dock, vis: m.chatVisibility }))
    check(`${w}px, Study open: no sideways scrolling`, !m.hScroll)
    await shot(`${w}-study`)
    await click('#studyButton')
    await waitFor(() => run('return document.getElementById("studyPanel").hidden'), 5000, 'the Study panel to close')
    await sleep(300)
    m = await measure()
    check(`${w}px, closed again: the conversation is back, clickable, and exactly where it was scrolled to`, m.chatVisibility === 'visible' && m.reach['#composerInput'] && m.reach['#sendButton'] && m.chatScrollTop === before, `scrollTop ${before} -> ${m.chatScrollTop}`)
  }

  // ==== an answer found where the panel covers the conversation ====
  await size(800)
  await openStudy()
  const before = await answers()
  await run('const i=document.getElementById("studyAskInput"); i.value="What is a foreign key?"; i.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("form.study-ask button[type=submit]").click(); return true')
  await waitFor(async () => (await answers()) > before, 30000, 'the answer')
  await waitFor(() => run('return [...document.querySelectorAll("#studyBody button.study-link")].some((b) => b.textContent.trim() === "Show in chat")'), 10000, 'Show in chat')
  m = await measure()
  check('800px: the answer is behind the panel, and the card offers "Show in chat"', m.visiblePanels.join() === 'studyPanel' && m.chatVisibility === 'hidden')
  await run('const b=[...document.querySelectorAll("#studyBody button.study-link")].filter((b) => b.textContent.trim() === "Show in chat").pop(); b.click(); return true')
  await sleep(400)
  m = await measure()
  const flashed = await run('return document.querySelectorAll("li.msg[data-flash=true]").length')
  check('800px: "Show in chat" puts the panel away and shows the answer, outlined', m.dock === null && m.chatVisibility === 'visible' && m.reach['#thread > li:last-child'] && flashed === 2, `dock ${JSON.stringify(m.dock)}, flashed ${flashed}`)
  await shot('800-show-in-chat')

  // ==== a study answer is brought to the middle of the conversation, wherever the person was reading ====
  await size(1280)
  await openStudy()
  await run('document.querySelector("#chatMain").scrollTop = 0; return true') // reading the start of the conversation
  await sleep(150)
  const n0 = await answers()
  await run('const i=document.getElementById("studyAskInput"); i.value="What is a primary key?"; i.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("form.study-ask button[type=submit]").click(); return true')
  await waitFor(async () => (await answers()) > n0, 30000, 'the answer')
  await sleep(500)
  const w = await run('const main=document.querySelector("#chatMain"); const li=[...document.querySelectorAll("#thread > li[data-role=assistant]")].pop(); const m=main.getBoundingClientRect(), r=li.getBoundingClientRect(); return { fromMiddle: Math.round(r.top + r.height/2 - (m.top + main.clientHeight/2)), scrollTop: Math.round(main.scrollTop), h: Math.round(r.height), view: main.clientHeight }')
  check('1280px: an answer that arrives while the person is reading at the top is brought to the middle of the conversation', Math.abs(w.fromMiddle) <= 12 && w.scrollTop > 300, JSON.stringify(w))
  await shot('1280-answer-centered')
} catch (err) {
  console.error(err)
  check('the run completed', false, String(err?.message ?? err).slice(0, 300))
  console.log('--- tauri-driver log (tail) ---\n' + driver.log.slice(-600))
  console.log('--- app server log (tail) ---\n' + stack.app.log().slice(-600))
} finally {
  try { if (sid) await wd('DELETE', `/session/${sid}`) } catch { /* the app may be gone already */ }
  await new Promise((r) => front.close(r))
  await new Promise((r) => modelServer.close(r))
  await stack.close().catch(() => {})
  for (const child of children.reverse()) child.kill('SIGTERM')
}
process.exit(finish() ? 0 : 1)
