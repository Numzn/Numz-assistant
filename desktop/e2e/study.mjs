// End-to-end check of the STUDY WATCHER in the real desktop app on Linux/X11, in per-person sign-in mode (the only mode Academic
// Intelligence works in), with nothing faked on the capture path:
//
//   Xvfb + openbox + real GTK windows + a real pointer
//     -> the REAL desktop app (Tauri/WebKitGTK) driven through WebDriver, signed in through the REAL numzlab-auth broker (pretend Google)
//          -> the REAL NUMZ AI server; the study panel starts a session with "Read my screen"
//               -> the app's native watcher looks at the real screen, the page sends changed pictures, the server reads them
//                    -> a stand-in vision/text model that decodes the picture it is sent.
//
// What it proves: a changed screen is captured, read and answered with nobody pressing anything, down to one changed digit, word or token of
// code, and an unchanged screen (or this app's own window changing) is not captured again; pictures are taken only while a session is reading; nothing is read while a password manager or a window the person
// listed is open; Pause really stops it; Stop really stops it; a page that goes away stops it by itself; a restricted session never starts it;
// and focus, pointer and window stacking are untouched by automatic capture.
//
//   node desktop/e2e/study.mjs      (needs what desktop/README.md lists, plus numzlab-auth's test rig; the app built with the test capability)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reporter, repo } from '../../scripts/camera-e2e/lib.mjs'
import { Browser, freePort, startStack } from '../../tests/helpers/aiRig.js'
import { look } from './fakeVision.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = process.env.NUMZ_DESKTOP_BIN || path.resolve(here, '../src-tauri/target/debug/numz-ai-desktop')
const DRIVER = process.env.TAURI_DRIVER || path.join(os.homedir(), '.cargo/bin/tauri-driver')
const NATIVE_DRIVER = process.env.WEBKIT_DRIVER || '/usr/bin/WebKitWebDriver'
const DISPLAY = process.env.E2E_DISPLAY || ':94'
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
// A failure while setting up must not leave an X server, a window manager or test windows behind.
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

// ---- the desktop ----------------------------------------------------------------------------------------------------
track('Xvfb', [DISPLAY, '-screen', '0', '1600x900x24', '-nolisten', 'tcp'])
await waitFor(() => { try { x('xdpyinfo'); return true } catch { return false } }, 10000, 'the X server')
track('openbox', [])
await sleep(800)
const colourWindow = (title, colour, geometry) => track('python3', [path.join(here, 'colorwindow.py'), title, colour, geometry])
colourWindow('NUMZ-TARGET', '#ff3300', '500x300+100+100')
colourWindow('NUMZ-OTHER', '#0033ff', '400x250+700+300')
await waitFor(() => x('xdotool', 'search', '--name', 'NUMZ-TARGET') && x('xdotool', 'search', '--name', 'NUMZ-OTHER'), 40000, 'the test windows')
const OTHER_ID = x('xdotool', 'search', '--name', 'NUMZ-OTHER').split('\n')[0]
const TARGET_ID = x('xdotool', 'search', '--name', 'NUMZ-TARGET').split('\n')[0]
let flip = false
/** Change what is on the screen (the test's hand moves a window; the app is not involved). */
const changeScreen = () => {
  flip = !flip
  x('xdotool', 'windowmove', TARGET_ID, flip ? '120' : '60', flip ? '520' : '60')
}

// ---- the stand-in model: a picture becomes a question that names the colour in the middle --------------------------------
const model = { pictures: [], texts: 0 }
const modelServer = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const m = raw.match(/data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)/)
    res.writeHead(200, { 'content-type': 'application/json' })
    if (m) {
      let seen
      try {
        seen = look(Buffer.from(m[1], 'base64'))
      } catch (e) {
        seen = { error: String(e.message).slice(0, 80) }
      }
      model.pictures.push({ at: Date.now(), seen, bytes: Buffer.from(m[1], 'base64') })
      const reading = {
        contentKind: 'revision_question',
        questions: [{ text: `Which colour is the window in the middle of the screen (${seen.center})?`, options: [], marks: '2', type: 'short_answer', hasDiagram: false }],
        instructions: '',
        subject: 'colours',
        topic: 'colour',
        assessmentIndicators: [],
        confidence: 0.9,
        reason: ''
      }
      return res.end(JSON.stringify({ model: 'fake-vision', choices: [{ message: { role: 'assistant', content: JSON.stringify(reading) } }], usage: { prompt_tokens: 900, completion_tokens: 80 } }))
    }
    model.texts++
    res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { role: 'assistant', content: 'The window in the middle is blue. (stand-in model)' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))
  })
})
await new Promise((r) => modelServer.listen(0, '127.0.0.1', r))
const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`

// ---- one origin in front of the app and numzlab-auth (what Caddy does on the real site), without the upgrade-insecure-requests WebKit obeys --
console.log('building the NUMZ AI page for /ai/ ...')
execFileSync('npx', ['vite', 'build'], { cwd: repo, env: { ...process.env, VITE_PUBLIC_BASE: '/ai/' }, stdio: 'ignore' })
const frontPort = await freePort()
const origin = `http://127.0.0.1:${frontPort}`
const stack = await startStack({ front: origin, env: { AI_BASE_URL: modelUrl, CAMERA_VISION_BASE_URL: modelUrl, ACADEMIC_RESEARCH: 'off' } })
const front = http.createServer((req, res) => {
  const toAuth = req.url.startsWith('/auth')
  const port = toAuth ? stack.ports.auth : stack.app.port
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${frontPort}` } }, (answer) => {
    const headers = { ...answer.headers }
    if (headers['content-security-policy']) headers['content-security-policy'] = String(headers['content-security-policy']).replace(/;?\s*upgrade-insecure-requests/i, '')
    if (process.env.E2E_TRACE && !/\.(js|css|woff2?|svg|png|ico)(\?|$)/.test(req.url)) console.log('front:', req.method, req.url.slice(0, 90), answer.statusCode, (headers.location ?? '').slice(0, 110), (headers['set-cookie'] ?? []).map((c) => String(c).split(';')[0].split('=')[0] + '[' + String(c).replace(/^[^;]*;?/, '').slice(0, 60) + ']').join(' '))
    res.writeHead(answer.statusCode, headers)
    answer.pipe(res)
  })
  up.on('error', () => res.destroy())
  req.pipe(up)
})
await new Promise((resolve) => front.listen(frontPort, '127.0.0.1', resolve))
const nl = (route, body) => stack.numzlab.control(route, body)
await nl('invite', { email: 'ada@example.com', role: 'operator' })
await nl('google', { email: 'ada@example.com', sub: 'sub-ada', name: 'ada' })

// ---- the app ------------------------------------------------------------------------------------------------------------------
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
const text = (selector) => run('return (document.querySelector(arguments[0])||{}).textContent', selector)
const indicator = async () => ((await text('#studyIndicator')) ?? '').trim()
const clickButton = (label) => run('const b=[...document.querySelectorAll("#studyBody button")].find(b=>b.textContent.trim()===arguments[0]); if(!b) return false; b.click(); return true', label)
const appWindow = () => x('xdotool', 'search', '--name', '^NUMZ AI').split('\n').pop()
const title = () => x('xdotool', 'getwindowname', appWindow())
const snapshot = () => JSON.stringify({ focus: x('xdotool', 'getwindowfocus'), mouse: x('xdotool', 'getmouselocation'), stacking: x('xprop', '-root', '_NET_CLIENT_LIST_STACKING'), active: x('xprop', '-root', '_NET_ACTIVE_WINDOW') })
/** No new picture for `ms` while the screen keeps changing: returns how many arrived. */
async function quietFor(ms) {
  const n = model.pictures.length
  const end = Date.now() + ms
  while (Date.now() < end) {
    changeScreen()
    await sleep(2500)
  }
  return model.pictures.length - n
}
const nextPicture = async (label, ms = 90000) => {
  // Changes the screen (a test window moves) and gives the change time to stay put: the watcher reports a screen only once two looks in a
  // row agree, so a window flipping every fraction of a second would never be captured, by design.
  const n = model.pictures.length
  const end = Date.now() + ms
  while (Date.now() < end) {
    changeScreen()
    const hold = Date.now() + 9000
    while (Date.now() < hold) {
      if (model.pictures.length > n) return model.pictures.at(-1)
      await sleep(300)
    }
  }
  throw new Error(`timed out waiting for ${label}`)
}

try {
  const created = await waitFor(() => wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } }), 30000, 'a WebDriver session')
  sid = created.sessionId
  await waitFor(() => run('return document.readyState==="complete" && !!document.getElementById("studyButton")'), 30000, 'the NUMZ AI page inside the app')
  check('the desktop app opened the NUMZ AI page and can reach its native layer', (await run('return typeof window.__TAURI_INTERNALS__?.invoke === "function" && location.pathname')) === '/ai/')

  // Signing in. The desktop app only ever navigates to the site and to Google's own sign-in page, so it cannot walk through this run's
  // pretend Google (a different local address). The person signs in "elsewhere" through the REAL broker (a cookie jar follows the whole
  // redirect chain), and the session cookie is handed to the app's window, exactly as a browser that had signed in would have it.
  const jar = new Browser()
  await jar.signIn(`${origin}/ai`)
  const session = jar.jar.get(`127.0.0.1:${frontPort}`)?.get('numzai_session')
  if (!session?.value) throw new Error('the broker sign-in gave no session cookie')
  await wd('POST', `/session/${sid}/cookie`, { cookie: { name: 'numzai_session', value: session.value, path: '/ai', httpOnly: true, sameSite: 'Lax' } })
  await run('location.reload(); return true')
  await waitFor(() => run('return document.readyState==="complete" && document.getElementById("accessGate").hidden && !!document.getElementById("studyButton")'), 30000, 'the app to open signed in')
  await sleep(1500)
  check('signed in (a real per-person session from the real broker; no access code involved)', true)

  const win = appWindow()
  x('xdotool', 'windowsize', win, '440', '860')
  x('xdotool', 'windowmove', win, '1150', '10')
  await sleep(800)
  x('xdotool', 'windowfocus', OTHER_ID)
  x('xdotool', 'mousemove', '1234', '567')
  await sleep(700)
  const before = snapshot()
  check('before a session the window title is plain', title() === 'NUMZ AI', title())

  // ---- start a session that reads the screen ----------------------------------------------------------------------------
  await click('#studyButton')
  await waitFor(() => run('return !document.getElementById("studyPanel").hidden'), 5000, 'the study panel')
  await waitFor(() => run('return document.querySelectorAll("#studyBody input[type=checkbox]").length > 0'), 5000)
  const readBox = await run('const c=document.querySelectorAll("#studyBody input[type=checkbox]")[0]; return {disabled:c.disabled}')
  check('in the desktop app "Read my screen" is available', readBox.disabled === false)
  await run('document.querySelectorAll("#studyBody input[type=checkbox]")[0].click(); return true')
  await waitFor(() => run('return !!document.querySelector("#studyBody input[type=text][placeholder^=\\"for example\\"]")'), 5000, 'the exclusions box')
  await run('const i=document.querySelector("#studyBody input[placeholder^=\\"for example\\"]"); i.value="secret-vault"; i.dispatchEvent(new Event("input",{bubbles:true})); return true')
  await clickButton('Start session')
  await waitFor(async () => /screen reading ON/.test(await indicator()), 15000, 'the indicator to say the screen is being read')
  check('the indicator in the panel says the screen is being read', true, await indicator())
  check('and so does the app window\'s own title', /screen reading ON/.test(title()), title())

  const first = await nextPicture('the first automatic picture')
  check('a picture of the real desktop reached the server: 1600x900, the blue window in the middle', first.seen.width === 1600 && first.seen.height === 900 && first.seen.center === '#0033FF', JSON.stringify(first.seen))
  await waitFor(() => run('return document.querySelectorAll(".study-q").length >= 1'), 30000, 'a question card')
  check('the question found on it is shown in the panel', /Which colour is the window/.test(await text('.study-q-text')), (await text('.study-q-text')) ?? '')
  check('the active application, keyboard focus, pointer position and window stacking are exactly as they were', before === snapshot(), before === snapshot() ? '' : `${before}\n${snapshot()}`)

  // ---- the answer comes by itself: nobody presses Explain ---------------------------------------------------------------------
  await waitFor(async () => (await run('return document.querySelectorAll("#thread .msg").length')) >= 2, 40000, 'the answer in the conversation')
  check('the question is answered by itself and the exchange is in the conversation (nobody pressed anything)', /stand-in model/.test(await run('return [...document.querySelectorAll("#thread .msg")].at(-1).textContent')))
  await waitFor(async () => /Answered in the conversation/.test((await text('#studyBody')) ?? ''), 15000, 'the Study panel to say it was answered')
  check('and the Study panel shows the question as answered, with what the last screen held', /Answered in the conversation/.test(await text('#studyBody')) && /Last read/.test((await text('#studyWatchNote')) ?? ''), ((await text('#studyWatchNote')) ?? '').slice(0, 120))

  // ---- a small change is captured by itself; an unchanged screen is not -------------------------------------------------------
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'numz-study-e2e-'))
  const textFile = path.join(workDir, 'text.txt')
  const setText = (lines) => fs.writeFileSync(textFile, lines.join('\n'))
  const TEXT_AREA = '520x200+100+560'
  const quiet = async (seconds, label) => {
    // waits until nothing new has been sent for that long
    let last = model.pictures.length
    let since = Date.now()
    const end = Date.now() + 180000
    while (Date.now() < end) {
      await sleep(1000)
      if (model.pictures.length !== last) {
        last = model.pictures.length
        since = Date.now()
      }
      if (Date.now() - since >= seconds * 1000) return
    }
    throw new Error(`the screen never went quiet (${label}): the app's own window or something else keeps looking new`)
  }
  /** How many pixels differ between two pictures (JPEG noise ignored), over the whole screen or one area. */
  const differing = (a, b, crop) => {
    const files = ['a', 'b'].map((n) => path.join(workDir, `${n}.jpg`))
    fs.writeFileSync(files[0], a)
    fs.writeFileSync(files[1], b)
    const out = files.map((f, i) => {
      const png = path.join(workDir, `${i}.png`)
      execFileSync('convert', [f, ...(crop ? ['-crop', crop, '+repage'] : []), png])
      return png
    })
    return Number.parseInt(spawnSync('compare', ['-metric', 'AE', '-fuzz', '15%', out[0], out[1], 'null:'], { encoding: 'utf8' }).stderr.trim(), 10)
  }
  setText(['total = 12 + 7', 'name = abc', 'if (a == b) {'])
  const textWindow = track('python3', [path.join(here, 'textwindow.py'), 'NUMZ-TEXT', textFile, TEXT_AREA])
  await waitFor(() => x('xdotool', 'search', '--name', 'NUMZ-TEXT'), 40000, 'the text window')
  await quiet(30, 'after the text window opened')
  const countBefore = model.pictures.length
  await sleep(25000)
  check('an unchanged screen is not captured again, and neither is the app\'s own window changing (counters, answers)', model.pictures.length === countBefore, `${model.pictures.length - countBefore} pictures in 25 s`)
  let last = model.pictures.at(-1)
  const edits = [
    ['a number', ['total = 13 + 7', 'name = abc', 'if (a == b) {']],
    ['a word', ['total = 13 + 7', 'name = abd', 'if (a == b) {']],
    ['a token of code', ['total = 13 + 7', 'name = abd', 'if (a != b) {']]
  ]
  for (const [what, lines] of edits) {
    const n = model.pictures.length
    setText(lines)
    await waitFor(() => model.pictures.length > n, 60000, `a picture after ${what} changed`)
    const picture = model.pictures.at(-1)
    const inText = differing(last.bytes, picture.bytes, TEXT_AREA)
    const leftOfApp = differing(last.bytes, picture.bytes, '1100x900+0+0')
    check(`changing ${what} on the page is captured by itself, and the new picture shows the change`, inText > 0 && leftOfApp - inText <= 60, `${inText} pixels differ in the text window, ${leftOfApp - inText} elsewhere on that side`)
    last = picture
    await quiet(14, `after ${what}`)
  }
  const afterEdits = model.pictures.length
  await sleep(25000)
  check('and once it has stopped changing it is not captured again', model.pictures.length === afterEdits, `${model.pictures.length - afterEdits} pictures in 25 s`)
  textWindow.kill('SIGTERM')
  await quiet(30, 'after the text window closed')

  // ---- a password manager is open: nothing is read ---------------------------------------------------------------------
  const keepass = colourWindow('KeePassXC - Passwords', '#00aa00', '300x200+1000+600')
  await waitFor(() => x('xdotool', 'search', '--name', 'KeePassXC'), 10000, 'the password manager window')
  await sleep(1500)
  const whileOpen = await quietFor(18000)
  check('while a password manager is open, no picture is taken even though the screen keeps changing', whileOpen === 0, `${whileOpen} pictures`)
  check('and the panel says it is holding back', /held|excluded/i.test(await indicator()), await indicator())
  keepass.kill('SIGTERM')
  await sleep(1000)
  const afterKeepass = await nextPicture('a picture after the password manager closed')
  check('when it closes, reading resumes by itself', Boolean(afterKeepass))

  // ---- a window the person listed ------------------------------------------------------------------------------------------
  const vault = colourWindow('secret-vault notes', '#aa00aa', '300x200+1000+600')
  await waitFor(() => x('xdotool', 'search', '--name', 'secret-vault'), 10000, 'the listed window')
  await sleep(1500)
  const whileListed = await quietFor(18000)
  check('a window with a word the person listed also stops reading', whileListed === 0, `${whileListed} pictures`)
  vault.kill('SIGTERM')
  await sleep(1000)
  await nextPicture('a picture after the listed window closed')

  // ---- pause ----------------------------------------------------------------------------------------------------------------------
  await clickButton('Pause')
  await waitFor(async () => /paused/.test(await indicator()), 10000, 'paused')
  check('Pause puts the window title and the indicator in the paused state', /paused/.test(title()) && /paused/.test(await indicator()), `${title()} | ${await indicator()}`)
  const whilePaused = await quietFor(15000)
  check('while paused, nothing is read even though the screen keeps changing', whilePaused === 0, `${whilePaused} pictures`)
  await clickButton('Resume')
  await nextPicture('a picture after resuming')
  check('Resume starts reading again', /screen reading ON/.test(title()), title())

  // ---- stop -----------------------------------------------------------------------------------------------------------------------
  await clickButton('End session')
  await waitFor(async () => (await indicator()) === 'No session', 10000, 'the session to end')
  check('ending the session puts the window title back', title() === 'NUMZ AI', title())
  const afterStop = await quietFor(15000)
  check('after the session ends, nothing is read', afterStop === 0, `${afterStop} pictures`)

  // ---- a page that goes away stops the reading by itself -------------------------------------------------------------------
  await run('const c=document.querySelectorAll("#studyBody input[type=checkbox]")[0]; if(!c.checked) c.click(); return true') // the form remembers the last choice
  await clickButton('Start session')
  await waitFor(async () => /screen reading ON/.test(await indicator()), 15000, 'reading to start again')
  await nextPicture('a picture in the last session')
  // The page stops checking in WITHOUT going away (no unload, nothing tells the app): its calls for results simply never come back, as
  // if the page had hung. Only the app's own dead-man switch can end the reading now.
  // The page's poll loop waits 1.5 s between calls; timers of exactly that length are made never to fire, so the loop never calls again.
  await run('const real = window.setTimeout.bind(window); window.__realInvoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__); window.setTimeout = (fn, ms, ...rest) => (ms === 1500 ? 0 : real(fn, ms, ...rest)); return true')
  const seenAfterHang = await quietFor(40000)
  const native = await wd('POST', `/session/${sid}/execute/async`, { script: 'const done = arguments[arguments.length-1]; window.__realInvoke("screenshot_watch_poll", {}).then((v)=>done({ok:v}), (e)=>done({err:String(e&&e.message||e)}))', args: [] })
  check('with the page hung (still open, but asking for nothing), the app stops reading by itself: no more pictures, and the title is plain again', seenAfterHang <= 1 && title() === 'NUMZ AI', `${seenAfterHang} pictures, title "${title()}"`)
  check('and the native side reports why', JSON.stringify(native).includes('page-gone'), JSON.stringify(native).slice(0, 200))
  await run('location.reload(); return true')

  // ---- a restricted session never reads ---------------------------------------------------------------------------------
  await run('location.assign("/ai/"); return true')
  await waitFor(() => run('return !!document.getElementById("studyButton") && document.readyState==="complete" && document.getElementById("accessGate").hidden'), 30000, 'the study page again')
  await sleep(1500)
  await click('#studyButton')
  await waitFor(() => run('return !document.getElementById("studyPanel").hidden'), 5000)
  await waitFor(async () => (await indicator()) !== '', 10000)
  const active = await indicator()
  if (active !== 'No session') {
    await clickButton('End session')
    await waitFor(async () => (await indicator()) === 'No session', 10000)
  }
  await run('document.querySelector("#studyBody input[value=restricted]").click(); return true')
  check('"Read my screen" is unavailable for a restricted assessment', await run('return document.querySelectorAll("#studyBody input[type=checkbox]")[0].disabled'))
  await clickButton('Start session')
  await waitFor(async () => /Restricted/.test(await indicator()), 10000)
  const whileRestricted = await quietFor(15000)
  check('a restricted session never reads the screen', whileRestricted === 0 && title() === 'NUMZ AI', `${whileRestricted} pictures, title "${title()}"`)
  await clickButton('End session')
} catch (err) {
  console.error(err)
  check('the end-to-end run completed', false, String(err?.message ?? err).slice(0, 300))
  console.log('--- app server log (tail) ---\n' + stack.app.log().slice(-800))
  console.log('--- tauri-driver log (tail) ---\n' + driver.log.slice(-600))
  console.log('--- pictures seen ---', JSON.stringify(model.pictures.map((p) => p.seen)))
  try {
    if (sid) console.log('--- page ---', JSON.stringify(await run('return {path: location.pathname, indicator: (document.getElementById("studyIndicator")||{}).textContent, message: (document.querySelector(".study-message")||{}).textContent}')))
  } catch {}
} finally {
  try { if (sid) await wd('DELETE', `/session/${sid}`) } catch {}
  await new Promise((r) => front.close(r))
  await new Promise((r) => modelServer.close(r))
  await stack.close().catch(() => {})
  for (const child of children.reverse()) child.kill('SIGTERM')
}
process.exit(finish() ? 0 : 1)
