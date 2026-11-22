// End-to-end check of the NUMZ AI desktop app on Linux/X11, with nothing faked on the capture path:
//
//   Xvfb (a real X server) + openbox (a real window manager) + two real GTK windows with known colours + a real pointer
//     -> the REAL desktop app (Tauri/WebKitGTK), driven through WebDriver (tauri-driver)
//          -> opens the REAL NUMZ AI page, served by the REAL server.js
//               -> takes a REAL native screenshot (full screen / a window / an area), uploads it, and the server analyses it
//                    -> with a stand-in vision provider that decodes the picture it is sent and says what colour is where.
//
// Run it:   node desktop/e2e/run.mjs        (needs: the debug app built with the test capability, tauri-driver, WebKitWebDriver, Xvfb,
//                                            openbox, xdotool, ImageMagick, python3-gi; see desktop/README.md)
//
// The driver (WebDriver and xdotool) is the TEST's hand on the app and on the X server. The app itself sends no input.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reporter, repo, startApp } from '../../scripts/camera-e2e/lib.mjs'
import { startFakeVision } from './fakeVision.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = process.env.NUMZ_DESKTOP_BIN || path.resolve(here, '../src-tauri/target/debug/numz-ai-desktop')
const DRIVER = process.env.TAURI_DRIVER || path.join(os.homedir(), '.cargo/bin/tauri-driver')
const NATIVE_DRIVER = process.env.WEBKIT_DRIVER || '/usr/bin/WebKitWebDriver'
const DISPLAY = process.env.E2E_DISPLAY || ':91'
const dir = process.env.DESKTOP_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'numz-desktop-e2e-'))
fs.mkdirSync(dir, { recursive: true })
const { check, finish } = reporter()
const children = []
const env = { ...process.env, DISPLAY, WEBKIT_DISABLE_COMPOSITING_MODE: '1', WEBKIT_DISABLE_DMABUF_RENDERER: '1', NO_AT_BRIDGE: '1' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const spawnTracked = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  child.log = ''
  child.stdout.on('data', (c) => (child.log += c))
  child.stderr.on('data', (c) => (child.log += c))
  children.push(child)
  return child
}
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
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${label} (${last instanceof Error ? last.message : JSON.stringify(last)})`)
}
const portOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })

// ---- the desktop: a real X server, window manager and windows ----------------------------------------------------------
const xvfb = spawnTracked('Xvfb', [DISPLAY, '-screen', '0', '1600x900x24', '-nolisten', 'tcp'])
await waitFor(() => { try { x('xdpyinfo'); return true } catch { return false } }, 10000, 'the X server')
spawnTracked('openbox', [])
await sleep(800)
const colourWindow = (title, colour, geometry) => spawnTracked('python3', [path.join(here, 'colorwindow.py'), title, colour, geometry])
colourWindow('NUMZ-TARGET', '#ff3300', '500x300+100+100')
const other = colourWindow('NUMZ-OTHER', '#0033ff', '400x250+700+300')
await waitFor(() => x('xdotool', 'search', '--name', 'NUMZ-TARGET') && x('xdotool', 'search', '--name', 'NUMZ-OTHER'), 10000, 'the test windows')
const OTHER_ID = x('xdotool', 'search', '--name', 'NUMZ-OTHER').split('\n')[0]

// ---- the NUMZ AI server and its (stand-in) vision provider ------------------------------------------------------------------
console.log('building the NUMZ AI page ...')
execFileSync('npx', ['vite', 'build'], { cwd: repo, stdio: 'ignore' })
const vision = await startFakeVision()
const server = await startApp({ dir, port: 18433, stubPort: vision.port })

// The real site is served over https. This run serves it over plain http on this machine, and WebKit (unlike Chromium) would obey the
// site's `upgrade-insecure-requests` and try to load its own scripts over https. So the app is pointed at a pass-through proxy that
// removes that one directive from the policy; everything else is untouched.
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: server.port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${server.port}` } }, (answer) => {
    const headers = { ...answer.headers }
    if (headers['content-security-policy']) headers['content-security-policy'] = String(headers['content-security-policy']).replace(/;?\s*upgrade-insecure-requests/i, '')
    res.writeHead(answer.statusCode, headers)
    answer.pipe(res)
  })
  up.on('error', () => res.destroy())
  req.pipe(up)
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${proxy.address().port}`

// ---- the real desktop app, through WebDriver ----------------------------------------------------------------------------------
const driver = spawnTracked(DRIVER, ['--port', '4445', '--native-port', '4446', '--native-driver', NATIVE_DRIVER], { env: { ...env, NUMZ_AI_URL: `${base}/` } })
await waitFor(() => portOpen(4445), 10000, 'tauri-driver')
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf'
let sid = null
async function wd(method, p, body) {
  const res = await fetch(`http://127.0.0.1:4445${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`)
  return json.value
}
const run = (script, ...args) => wd('POST', `/session/${sid}/execute/sync`, { script, args })
const text = (id) => run('return (document.getElementById(arguments[0])||{}).textContent', id)
const click = (id) => run('document.getElementById(arguments[0]).click(); return true', id)
const clickMode = (mode) => run('document.querySelector(`[data-shot-mode="${arguments[0]}"]`).click(); return true', mode)
const clickButton = (label) => run('const b=[...document.querySelectorAll("#shotActions button")].find(b=>b.textContent.trim()===arguments[0]); if(!b) return false; b.click(); return true', label)
const chip = () => text('shotChip')
const thread = () => run('return [...document.querySelectorAll("#thread .msg")].map(li=>({role:li.dataset.role,text:li.textContent}))')
const shotMessage = () => text('shotMessage')

function snapshot() {
  return JSON.stringify({
    focus: x('xdotool', 'getwindowfocus'),
    mouse: x('xdotool', 'getmouselocation'),
    stacking: x('xprop', '-root', '_NET_CLIENT_LIST_STACKING'),
    active: x('xprop', '-root', '_NET_ACTIVE_WINDOW')
  })
}

try {
  // tauri-driver answers before the native WebKit driver behind it is listening: try until a session opens.
  const created = await waitFor(() => wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } }), 30000, 'a WebDriver session')
  sid = created.sessionId
  await waitFor(() => run('return !!document.getElementById("shotButton") && document.readyState==="complete"'), 30000, 'the NUMZ AI page inside the app')
  await waitFor(() => run('return window.location.origin'), 5000)
  check('the desktop app opened the NUMZ AI page', (await run('return window.location.href')).startsWith(base))
  check('the page can reach the native layer (it is inside the desktop app)', await run('return typeof window.__TAURI_INTERNALS__?.invoke === "function"'))
  await sleep(1500) // the page starts its first conversation as it loads
  await waitFor(() => run('return document.getElementById("shotChip").textContent !== undefined && !document.getElementById("shotButton").disabled'), 5000)

  // Put the app's own window on the right-hand side, clear of the two test windows: on X11 without a compositing manager (this Xvfb) the
  // part of a window that another window covers cannot be read back, so a covered test window would prove nothing. The window move is the
  // test harness's, before anything is measured.
  const appWindow = x('xdotool', 'search', '--name', 'NUMZ AI').split('\n').pop()
  x('xdotool', 'windowsize', appWindow, '440', '860')
  x('xdotool', 'windowmove', appWindow, '1150', '10')
  await sleep(1000)

  // Set the scene: another application has the focus and the pointer is somewhere specific. Everything below happens while it does.
  x('xdotool', 'windowfocus', OTHER_ID)
  x('xdotool', 'mousemove', '1234', '567')
  await sleep(700)
  const before = snapshot()

  // ---- full screen ----------------------------------------------------------------------------------------------------
  await run('window.__errs=[]; window.addEventListener("error", e=>__errs.push(String(e.message))); window.addEventListener("unhandledrejection", e=>__errs.push("rej:"+String((e.reason&&e.reason.message)||e.reason))); return true')
  await click('shotButton')
  if (process.env.E2E_TRACE) {
    console.log('page health:', JSON.stringify(await run('return {thread: document.getElementById("thread").children.length, greeting: (document.getElementById("chatMain")||{}).textContent?.slice(0,60), sendDisabled: document.getElementById("sendButton").disabled, ua: navigator.userAgent.slice(0,120)}')))
    console.log('resources:', JSON.stringify(await run('return performance.getEntriesByType("resource").filter(e=>/\\.(js|css)/.test(e.name)).map(e=>[e.name.split("/").pop(), Math.round(e.duration), e.transferSize, e.responseStatus]).slice(0,14)')))
    console.log('fetch main:', JSON.stringify(await wd('POST', `/session/${sid}/execute/async`, { script: 'const done = arguments[arguments.length-1]; const src=[...document.scripts].find(s=>s.type==="module").src; fetch(src).then(async r=>{const t=await r.text(); const imports=[...t.matchAll(/from\\s*\\"([^\\"]+)\\"/g)].slice(0,5).map(m=>m[1]); done({status:r.status, len:t.length, imports})}, e=>done("ERR "+e))', args: [] })))
    console.log('re-import:', JSON.stringify(await wd('POST', `/session/${sid}/execute/async`, { script: 'const done = arguments[arguments.length-1]; const src=[...document.scripts].find(s=>s.type==="module").src; import(src+"?again=1").then(()=>done("loaded"), (e)=>done("ERR "+String(e&&e.message)))', args: [] })))
  }
  if (process.env.E2E_TRACE) console.log('after opening the menu:', JSON.stringify(await run('return {expanded: document.getElementById("shotButton").getAttribute("aria-expanded"), menuHidden: document.getElementById("shotMenu").hidden, errs: window.__errs, scripts:[...document.scripts].map(s=>s.src.split("/").pop()).slice(0,6)}')))
  check('the capture menu offers full screen, area and window', (await run('return [...document.querySelectorAll("#shotMenu [data-shot-mode]")].every(b=>!b.disabled)')) === true)
  await clickMode('screen')
  if (process.env.E2E_TRACE) { await sleep(2500); console.log('trace:', JSON.stringify(await run('return {errs: window.__errs, chip: document.getElementById("shotChip").textContent, msg: document.getElementById("shotMessage").textContent, panelHidden: document.getElementById("shotPanel").hidden, stage: document.getElementById("shotStage").hidden}'))) }
  await waitFor(async () => (await chip()) === 'Preview', 20000, 'the preview')
  const preview = await run('const i=document.getElementById("shotPreview"); return {src:i.getAttribute("src").slice(0,23), w:i.naturalWidth, h:i.naturalHeight}')
  check('a preview of the real screen appears in the panel', preview.src === 'data:image/jpeg;base64,' && preview.w > 100, JSON.stringify(preview))
  await run('const q=document.getElementById("shotQuestion"); q.value="What colour is in the middle?"; q.dispatchEvent(new Event("input",{bubbles:true})); return true')
  await clickButton('Analyse')
  await waitFor(async () => (await chip()) === 'Added', 30000, 'the analysis')
  const t1 = await thread()
  const answer1 = t1.at(-1).text
  check('the analysis is added to the conversation, with the question and a Screenshot chip', t1.at(-2).text.includes('What colour is in the middle?') && t1.at(-2).text.includes('Screenshot') && /FAKE-VISION analysis/.test(answer1), answer1.slice(0, 120))
  const seen1 = vision.state.requests.filter((r) => r.kind === 'analysis').at(-1).seen
  check('the picture the server received is the whole 1600x900 desktop', seen1.width === 1600 && seen1.height === 900, JSON.stringify(seen1))
  check('and its pixels are the real desktop (the blue window is in the middle, the red one at (300,300))', seen1.center === '#0033FF' && seen1.at300 === '#FF3300', JSON.stringify(seen1))
  check('the question reached the vision model', vision.state.requests.filter((r) => r.kind === 'analysis').at(-1).text.includes('What colour is in the middle?'))
  const after = snapshot()
  check('the active application, keyboard focus, pointer position and window stacking are exactly as they were', before === after, before === after ? '' : `${before}\n${after}`)

  // ---- a follow-up that looks at the picture again ---------------------------------------------------------------------
  await run('const i=document.getElementById("shotAskInput"); i.value="And the corner?"; document.getElementById("shotAsk").requestSubmit(); return true')
  await waitFor(async () => (await thread()).some((m) => /FAKE-VISION follow-up/.test(m.text)), 20000, 'the follow-up answer')
  check('a follow-up is answered from the same picture and joins the conversation', vision.state.requests.at(-1).kind === 'follow-up' && vision.state.requests.at(-1).seen.width === 1600)

  // ---- delete --------------------------------------------------------------------------------------------------------------
  await clickButton('Delete screenshot')
  await waitFor(async () => (await chip()) === '' || (await chip()) === null, 15000, 'the panel to reset')
  const t2 = await thread()
  check('deleting the screenshot removes its messages from the conversation', !t2.some((m) => /Screenshot|FAKE-VISION/.test(m.text)))
  const conversations = await (await fetch(`${base}/api/v1/assistant/conversations`)).json()
  check('and from the saved history', !JSON.stringify(conversations).includes('Screenshot') && (conversations.conversations ?? []).every((c) => c.messageCount === 0 || c.title !== 'Screenshot'), JSON.stringify(conversations).slice(0, 160))

  // ---- an area -------------------------------------------------------------------------------------------------------------
  await click('shotButton')
  await clickMode('region')
  await waitFor(async () => (await chip()) === 'Preview', 20000, 'the region preview')
  const stage = (await wd('POST', `/session/${sid}/element`, { using: 'css selector', value: '#shotStage' }))[ELEMENT]
  await wd('POST', `/session/${sid}/actions`, {
    actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', duration: 0, origin: { [ELEMENT]: stage }, x: -40, y: -20 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 250, origin: { [ELEMENT]: stage }, x: 40, y: 20 },
      { type: 'pointerUp', button: 0 }
    ] }]
  })
  await waitFor(() => run('return !document.getElementById("shotSelection").hidden'), 5000, 'the chosen area')
  check('dragging on the preview chooses an area, drawn inside the app (nothing is drawn on the desktop)', true)
  await clickButton('Analyse')
  await waitFor(async () => (await chip()) === 'Added', 30000, 'the area analysis')
  const seen2 = vision.state.requests.filter((r) => r.kind === 'analysis').at(-1).seen
  check('only the chosen area was sent (a crop of the real screen, not all of it)', seen2.width > 100 && seen2.width < 600 && seen2.height > 50 && seen2.height < 300 && Math.abs(seen2.width / seen2.height - 2) < 0.4, JSON.stringify(seen2))
  check('and it is the right part of the desktop (the blue window)', seen2.center === '#0033FF', JSON.stringify(seen2))
  await clickButton('Delete screenshot')
  await waitFor(async () => (await chip()) === '', 15000, 'the panel to reset')

  // ---- one window ----------------------------------------------------------------------------------------------------------
  await click('shotButton')
  await clickMode('window')
  const entries = await waitFor(() => run('const l=[...document.querySelectorAll("#shotWindowList button")].map(b=>b.textContent); return l.length?l:null'), 15000, 'the window list')
  check('the window list names the real windows by title', entries.some((e) => e.includes('NUMZ-TARGET')) && entries.some((e) => e.includes('NUMZ-OTHER')), JSON.stringify(entries))
  await run('[...document.querySelectorAll("#shotWindowList button")].find(b=>b.textContent.includes("NUMZ-TARGET")).click(); return true')
  await waitFor(async () => (await chip()) === 'Preview', 20000, 'the window preview')
  await clickButton('Analyse')
  await waitFor(async () => (await chip()) === 'Added', 30000, 'the window analysis')
  const seen3 = vision.state.requests.filter((r) => r.kind === 'analysis').at(-1).seen
  check('one window was captured: the red window, at its own size, while a different application has the focus', seen3.width === 500 && seen3.height === 300 && seen3.center === '#FF3300', JSON.stringify(seen3))
  await clickButton('Delete screenshot')
  await waitFor(async () => (await chip()) === '', 15000, 'the panel to reset')
  check('the active application, focus and pointer are still exactly as they were after area and window captures', before === snapshot())

  // ---- a window that closes before it is captured ----------------------------------------------------------------------
  const gone = colourWindow('NUMZ-GONE', '#00aa00', '300x200+1000+600')
  await waitFor(() => x('xdotool', 'search', '--name', 'NUMZ-GONE'), 10000, 'the third window')
  await click('shotButton')
  await clickMode('window')
  await waitFor(() => run('return [...document.querySelectorAll("#shotWindowList button")].some(b=>b.textContent.includes("NUMZ-GONE"))'), 15000, 'the third window in the list')
  gone.kill('SIGTERM')
  await sleep(1200)
  await run('[...document.querySelectorAll("#shotWindowList button")].find(b=>b.textContent.includes("NUMZ-GONE")).click(); return true')
  await waitFor(async () => /no longer open/i.test(await shotMessage()), 15000, 'the no-such-window message')
  check('a window closed after it was listed gives a plain message and leaves the panel ready to try again', (await chip()) === '' && /no longer open/i.test(await shotMessage()), await shotMessage())

  // ---- the model is slow: cancel, nothing is added; then retry ---------------------------------------------------------
  vision.state.delayMs = 6000
  await click('shotButton')
  await clickMode('screen')
  await waitFor(async () => (await chip()) === 'Preview', 20000)
  const messagesBefore = (await thread()).length
  await clickButton('Analyse')
  await waitFor(async () => (await chip()) === 'Analysing…', 10000, 'analysing')
  check('while the model works the page stays usable (the analysis runs in the background)', await run('return !document.getElementById("composerInput").disabled'))
  await clickButton('Cancel')
  await waitFor(async () => (await chip()) === 'Cancelled', 10000, 'cancelled')
  await sleep(1000)
  check('cancelling adds nothing to the conversation and the request to the model is aborted', (await thread()).length === messagesBefore && vision.state.closedEarly >= 1, `closedEarly=${vision.state.closedEarly}`)
  vision.state.delayMs = 0
  await clickButton('Retry')
  await waitFor(async () => (await chip()) === 'Added', 30000, 'the retry')
  check('Retry runs the analysis again on the picture the server still holds and it joins the conversation', /FAKE-VISION analysis/.test((await thread()).at(-1).text))
  await clickButton('Delete screenshot')
  await waitFor(async () => (await chip()) === '', 15000)

  // ---- the vision service is down: say so, then recover ----------------------------------------------------------------
  vision.state.status = 503
  await click('shotButton')
  await clickMode('screen')
  await waitFor(async () => (await chip()) === 'Preview', 20000)
  const messagesBeforeFailure = (await thread()).length
  await clickButton('Analyse')
  await waitFor(async () => (await chip()) === 'Failed', 30000, 'the failure')
  check('an unavailable vision service is reported plainly, with Retry offered', /unavailable/i.test(await shotMessage()) && (await run('return [...document.querySelectorAll("#shotActions button")].some(b=>b.textContent.trim()==="Retry")')))
  check('and nothing was added to the conversation', (await thread()).length === messagesBeforeFailure)
  vision.state.status = 200
  await clickButton('Retry')
  await waitFor(async () => (await chip()) === 'Added', 30000, 'recovery')
  check('when the service is back, Retry succeeds and the analysis joins the conversation', (await thread()).length === messagesBeforeFailure + 2 && /FAKE-VISION analysis/.test((await thread()).at(-1).text))
  await clickButton('Delete screenshot')
  await waitFor(async () => (await chip()) === '', 15000)

  // ---- the app stays on the site -------------------------------------------------------------------------------------
  await run('setTimeout(() => { window.location.assign(arguments[0]) }, 0); return true', `http://localhost:${proxy.address().port}/`)
  await sleep(2500)
  check('the window refuses to leave the NUMZ AI address (a different origin is not loaded)', (await run('return window.location.origin')) === base)
} catch (err) {
  check('the end-to-end run completed', false, String(err?.message ?? err).slice(0, 300))
  if (sid) {
    try {
      console.log('--- page state ---', JSON.stringify({ chip: await chip(), message: await shotMessage() }))
      const cap = await wd('POST', `/session/${sid}/execute/async`, {
        script: 'const done = arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke("screenshot_capture", {mode:"screen", windowId:null}).then((v)=>done({ok:{id:v.captureId, w:v.width, h:v.height, previewLen:v.preview.length}}), (e)=>done({err: typeof e === "string" ? e : JSON.stringify(e)}))',
        args: []
      })
      console.log('--- invoke(screenshot_capture) from the page ---', JSON.stringify(cap))
      console.log('--- panel ---', JSON.stringify(await run('const p=document.getElementById("shotPanel"), m=document.getElementById("shotMenu"); return {panelHidden:p.hidden, menuHidden:m.hidden, items:[...m.querySelectorAll("button")].map(b=>[b.dataset.shotMode,b.disabled])}')))
      const probe = await wd('POST', `/session/${sid}/execute/async`, {
        script: 'const done = arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke("screenshot_status").then((v)=>done({ok:v}), (e)=>done({err: typeof e === "string" ? e : JSON.stringify(e)}))',
        args: []
      })
      console.log('--- invoke(screenshot_status) from the page ---', JSON.stringify(probe))
    } catch (e) {
      console.log('--- page probe failed ---', String(e.message).slice(0, 200))
    }
  }
  console.log('--- app server log (tail) ---\n' + server.log.slice(-600))
  console.log('--- tauri-driver log (tail) ---\n' + driver.log.slice(-800))
} finally {
  try { if (sid) await wd('DELETE', `/session/${sid}`) } catch {}
  await new Promise((r) => proxy.close(r))
  await server.stop().catch(() => {})
  await vision.close().catch(() => {})
  for (const child of children.reverse()) child.kill('SIGTERM')
  void xvfb
  void other
}
process.exit(finish() ? 0 : 1)
