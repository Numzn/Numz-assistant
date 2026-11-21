// Real-browser check of NUMZ AI 2.0 on a pretend copy of the shared site. NOT part of `npm test`: it needs Playwright, ffmpeg, Docker
// (for the real Caddy) and numzlab-auth's test rig.
//
//   node scripts/ai-e2e/run.mjs
//
// What stands where, on this machine, on spare ports:
//   browser (headless Chromium, fake camera and microphone)
//     -> the REAL dashboard Caddyfile in a real Caddy container, ONE origin for everything (like https://lab.numz.site)
//          /ai/*    -> the REAL NUMZ AI server (production mode, the real production build made for /ai/, a throw-away database)
//          /auth/*  -> the REAL numzlab-auth with its sign-in broker (and a pretend Google that approves whoever the test names)
//          other    -> the dashboard's own build
//   fakes only for the paid text/vision model and the speech service.
//
// Environment: NUMZLAB_AUTH_DIR (numzlab-auth's checkout, default /srv/infrastructure/auth; its tests/rig_ai.py is used),
// DASHBOARD_FRONTEND (the dashboard's frontend source, to build the NEW service worker), OLD_DASHBOARD_DIST (the dashboard as it is live),
// PLAYWRIGHT_FROM, FFMPEG, AI_E2E_DIR (screenshots).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, makeFeed, phone, reporter, repo } from '../camera-e2e/lib.mjs'
import { Browser, freePort, startFront, startStack } from '../../tests/helpers/aiRig.js'

const NUMZLAB = process.env.NUMZLAB_AUTH_DIR ?? '/srv/infrastructure/auth'
process.env.NUMZLAB_AUTH_DIR = NUMZLAB
const DASHBOARD_FRONTEND = process.env.DASHBOARD_FRONTEND ?? path.resolve(NUMZLAB, '..', 'dashboard', 'frontend')
const OLD_DIST = process.env.OLD_DASHBOARD_DIST ?? '/srv/infrastructure/dashboard/frontend/dist'
const dir = process.env.AI_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'numz-ai-e2e-'))
fs.mkdirSync(dir, { recursive: true })
console.log('working in', dir)

// ---- builds --------------------------------------------------------------------------------------------------------
console.log('building NUMZ AI for /ai/ ...')
execFileSync('npx', ['vite', 'build'], { cwd: repo, env: { ...process.env, VITE_PUBLIC_BASE: '/ai/' }, stdio: 'ignore' })
execFileSync('node', ['scripts/precompress.js', 'dist'], { cwd: repo, stdio: 'ignore' })
console.log('building the dashboard with the new service worker ...')
const NEW_DIST = path.join(dir, 'dashboard-dist-new')
const modules = path.join(DASHBOARD_FRONTEND, 'node_modules')
let linked = false
if (!fs.existsSync(modules)) {
  fs.symlinkSync('/srv/infrastructure/dashboard/frontend/node_modules', modules)
  linked = true
}
try {
  execFileSync('npx', ['vite', 'build', '--outDir', NEW_DIST, '--emptyOutDir'], { cwd: DASHBOARD_FRONTEND, stdio: 'ignore' })
} finally {
  if (linked) fs.rmSync(modules)
}

const feed = await makeFeed(dir)
const { check, finish } = reporter()
const problems = []
const frontPort = await freePort()
const origin = `http://127.0.0.1:${frontPort}`
const stack = await startStack({ front: origin })
const base = `${origin}/ai`
let front = await startFront({ stack, listen: frontPort, dist: NEW_DIST })
const nl = (route, body) => stack.numzlab.control(route, body)
const launch = () => chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${feed}`, '--autoplay-policy=no-user-gesture-required'] })
const browser = await launch()

function watch(page, label) {
  page.on('console', (m) => {
    const text = m.text()
    if (!['error', 'warning'].includes(m.type())) return
    if (/401|403|429|503|Failed to load resource/.test(text)) return // refusals the checks cause on purpose are logged by Chromium itself
    if (/Permissions policy violation: microphone/.test(text)) return // the deliberate check that the dashboard keeps its own ban
    if (/Sign in to use NUMZ AI/.test(text)) return // the assistant noticing, before sign-in, that it is signed out
    if (/TypeError: Failed to fetch/.test(text)) return // a request cut off by the page navigating away (the sign-in redirect)
    problems.push(`${label} ${m.type()}: ${text.slice(0, 160)}`)
  })
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message.slice(0, 160)}`))
}

async function newPerson(role, email) {
  await nl('invite', { email, role })
  await nl('google', { email, sub: `sub-${email}`, name: email.split('@')[0] })
}

async function signIn(page) {
  await page.goto(`${base}/`, { waitUntil: 'load' })
  await page.waitForSelector('#accessGoogleButton', { state: 'visible', timeout: 15000 })
  await Promise.all([page.waitForURL((u) => u.pathname === '/ai/' && !u.search, { timeout: 20000 }), page.click('#accessGoogleButton')])
  await page.waitForSelector('#accessGate', { state: 'hidden', timeout: 15000 })
  await page.waitForLoadState('networkidle')
}

try {
  // ============ A. a person uses NUMZ AI ====================================================================================
  const ada = 'ada@example.com'
  await newPerson('admin', ada)
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] })
  const page = await context.newPage()
  watch(page, 'chat')
  const responses = []
  const unsafe = []
  page.on('response', (r) => responses.push({ url: r.url(), status: r.status() }))
  page.on('request', (r) => {
    if (!['GET', 'HEAD'].includes(r.method()) && r.url().includes('/ai/api/')) unsafe.push({ url: r.url(), csrf: r.headers()['x-csrf-token'] })
  })

  const first = await page.goto(`${base}/`, { waitUntil: 'load' })
  await page.waitForSelector('#accessGate:not([hidden])', { timeout: 15000 })
  const headers = first.headers()
  check('signed out: the page opens at /ai/ and shows the sign-in card', true)
  check('the card offers Continue with Google, not a code box', (await page.isVisible('#accessGoogleButton')) && !(await page.isVisible('#accessForm')) && /continue with google/i.test(await page.textContent('#accessGoogleButton')))
  check('the page behind the card is inert', await page.evaluate(() => document.getElementById('app').inert === true))
  check('the sign-in link carries the page to come back to', (await page.getAttribute('#accessGoogleButton', 'href')) === '/ai/auth/login?next=%2Fai%2F')
  check('NUMZ AI sets its own security headers (CSP present) and not the dashboard\'s camera/microphone ban', /script-src 'self'/.test(headers['content-security-policy'] ?? '') && !headers['permissions-policy'])
  check('no HSTS from the app (the site\'s edge owns that)', !headers['strict-transport-security'])
  const assets = responses.filter((r) => r.url.includes('/ai/assets/'))
  check('its scripts and styles load from /ai/assets with the real Caddy in front', assets.length >= 2 && assets.every((r) => r.status === 200), `${assets.length} files`)
  await page.screenshot({ path: `${dir}/shot-1-signed-out.png` })

  await Promise.all([page.waitForURL((u) => u.pathname === '/ai/' && !u.search, { timeout: 20000 }), page.click('#accessGoogleButton')])
  await page.waitForSelector('#accessGate', { state: 'hidden', timeout: 15000 })
  await page.waitForLoadState('networkidle') // the page starts its first conversation as it loads; let that finish before anyone types
  check('the page started its conversation with the new session (no refusal)', responses.some((r) => r.url.endsWith('/ai/api/v1/assistant/sessions') && r.status === 201))
  responses.length = 0 // what the page asked while signed OUT was refused on purpose; judge only what happens from here
  unsafe.length = 0
  const cookies = await context.cookies()
  const mine = cookies.find((c) => c.name === 'numzai_session')
  check('signed in with Google through NUMZLAB: back on /ai/, the card is gone', true)
  check('the session cookie is ours: HttpOnly, SameSite=Lax, on the path /ai only', mine?.httpOnly === true && mine.sameSite === 'Lax' && mine.path === '/ai')
  check('no NUMZLAB dashboard session was created by signing in here', !cookies.some((c) => /nl_session/.test(c.name)))
  await page.click('#micSettingsButton')
  check('the sign-out button is offered and names who is signed in', (await page.isVisible('#lockButton')) && (await page.textContent('#lockButton')).trim() === 'Sign out' && /ada/i.test((await page.getAttribute('#lockButton', 'title')) ?? ''))

  await page.fill('#composerInput', 'hello from the browser')
  await page.press('#composerInput', 'Enter')
  await page.waitForSelector('li.msg[data-role="assistant"]', { timeout: 20000 })
  await page.waitForFunction(() => /echo: hello from the browser/.test(document.querySelector('li.msg[data-role="assistant"]')?.textContent ?? ''), null, { timeout: 20000 })
  check('a question is answered, by the model, over the signed-in session', true)
  if (process.env.AI_E2E_DEBUG) {
    console.log('  [debug] changes without a token:', JSON.stringify(unsafe.filter((u) => !u.csrf)))
    console.log('  [debug] refusals:', JSON.stringify(responses.filter((r) => r.status >= 400 && r.url.includes('/ai/'))))
    console.log('  [debug] lock button:', JSON.stringify(await page.evaluate(() => ({ text: document.getElementById('lockButton')?.textContent, title: document.getElementById('lockButton')?.title, hidden: document.getElementById('lockButton')?.hidden }))))
  }
  check('every change the page made carried its CSRF token', unsafe.length > 0 && unsafe.every((u) => typeof u.csrf === 'string' && u.csrf.length > 10), `${unsafe.length} requests`)
  check('and none was refused', !responses.some((r) => r.url.includes('/ai/api/') && [401, 403].includes(r.status)))
  await page.screenshot({ path: `${dir}/shot-2-chat.png` })

  await page.goto(`${base}/history.html`, { waitUntil: 'load' })
  if (process.env.AI_E2E_DEBUG) {
    await new Promise((r) => setTimeout(r, 2500))
    console.log('  [debug] history status:', JSON.stringify(await page.evaluate(() => ({ status: document.getElementById('historyStatus')?.textContent, gate: !document.getElementById('accessGate')?.hidden, list: document.getElementById('conversationList')?.innerHTML.slice(0, 200) }))))
    console.log('  [debug] list api:', JSON.stringify(await page.evaluate(() => fetch('/ai/api/v1/assistant/conversations').then(async (r) => [r.status, (await r.text()).slice(0, 300)]))))
  }
  await page.waitForSelector('#conversationList li.conv', { timeout: 15000 }).catch(async (err) => {
    console.log('  [history] state at the timeout:', JSON.stringify(await page.evaluate(() => ({ url: location.href, status: document.getElementById('historyStatus')?.textContent, gate: !document.getElementById('accessGate')?.hidden, notice: document.getElementById('accessGoogleNotice')?.textContent, list: document.getElementById('conversationList')?.innerHTML.slice(0, 200) }))))
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(stack.dbFile, { readOnly: true })
    console.log('  [history] db conversations:', JSON.stringify(db.prepare('SELECT conversation_id, owner_user_id, origin, created_at FROM assistant_conversations').all()), 'messages:', db.prepare('SELECT COUNT(*) n FROM assistant_messages').get().n, 'users:', JSON.stringify(db.prepare('SELECT id, email FROM ai_users').all()))
    console.log('  [history] list api now:', JSON.stringify(await page.evaluate(() => fetch('/ai/api/v1/assistant/conversations').then(async (r) => [r.status, (await r.text()).slice(0, 200)]))))
    console.log('  [history] server log tail:', stack.app.log().split('\n').slice(-8).join(' | ').slice(-900))
    await page.screenshot({ path: `${dir}/shot-history-timeout.png` })
    throw err
  })
  check('the conversation is in this person\'s history', /hello from the browser/.test(await page.textContent('#conversationList')))
  check('and opening it stays inside /ai/', (await page.getAttribute('#conversationList a.conv-main', 'href')).startsWith('./?conversation=') && (await page.evaluate(() => document.querySelector('#conversationList a.conv-main').href)).startsWith('http://127.0.0.1') && (await page.evaluate(() => new URL(document.querySelector('#conversationList a.conv-main').href).pathname)) === '/ai/')

  const mic = (p) => p.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      return 'granted'
    } catch (err) {
      return err.name
    }
  })
  await page.goto(`${base}/`, { waitUntil: 'load' })
  check('the microphone is available to NUMZ AI at /ai/', (await mic(page)) === 'granted')
  await page.goto(`${origin}/login`, { waitUntil: 'load' })
  check('while the dashboard keeps its own ban on camera and microphone', (await mic(page)) === 'NotAllowedError')

  // ---- the camera, on a phone ----
  const phoneContext = await browser.newContext(phone)
  const camPage = await phoneContext.newPage()
  watch(camPage, 'camera')
  await signIn(camPage)
  await camPage.goto(`${base}/camera.html`, { waitUntil: 'load' })
  await camPage.waitForSelector('#startButton', { timeout: 15000 })
  check('the camera page opens under /ai/ with the person\'s session (no sign-in card)', !(await camPage.isVisible('#accessGate')))
  await camPage.click('#startButton')
  await camPage.waitForFunction(() => ['scanning', 'sending'].includes(document.getElementById('cameraIndicator').dataset.kind), null, { timeout: 20000 })
  check('the camera starts (permission works at /ai/)', await camPage.evaluate(() => document.getElementById('cameraPreview').srcObject?.active === true))
  await camPage.waitForSelector('#answerPanel:not([hidden])', { timeout: 40000 })
  check('a question is read from the picture and answered', /150 km/.test(await camPage.inputValue('#questionText')) && /60 km\/h/.test(await camPage.textContent('#answerBody .ans-headline')))
  await camPage.screenshot({ path: `${dir}/shot-3-camera.png` })
  await camPage.click('#stopButton').catch(() => {})

  // ---- what an administrator sees of all this ----
  const admin = new Browser()
  await nl('google', { email: ada, sub: `sub-${ada}`, name: 'ada' })
  await admin.signIn(base)
  const status = (await admin.request(`${base}/api/v1/assistant/auth/status`)).json
  const usage = (await admin.request(`${base}/api/v1/admin/usage`)).json
  check('an administrator sees usage per person: chat and camera, counts only', usage.people.some((p) => p.chat >= 1) && usage.people.some((p) => p.vision >= 1) && !JSON.stringify(usage).includes('hello from the browser'))
  check('and has no route to anyone\'s conversations', (await admin.request(`${base}/api/v1/admin/conversations`)).status === 404 && status.user.role === 'admin')

  // ---- signing out ----
  const outPage = await context.newPage()
  watch(outPage, 'signout')
  await outPage.goto(`${base}/`, { waitUntil: 'load' })
  await outPage.click('#micSettingsButton')
  await outPage.waitForSelector('#lockButton', { state: 'visible' })
  await Promise.all([outPage.waitForNavigation({ waitUntil: 'load' }), outPage.click('#lockButton')])
  await outPage.waitForSelector('#accessGate:not([hidden])', { timeout: 15000 })
  check('signing out brings back the sign-in card and ends the session', !(await context.cookies()).some((c) => c.name === 'numzai_session'))
  check('and the old cookie opens nothing', (await outPage.evaluate(() => fetch('/ai/api/v1/assistant/conversations').then((r) => r.status))) === 401)

  // ---- access removed while the page is open ----
  const lee = 'lee@example.com'
  await newPerson('viewer', lee)
  const leeCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const leePage = await leeCtx.newPage()
  watch(leePage, 'suspended')
  await signIn(leePage)
  await nl('suspend', { email: lee })
  await new Promise((r) => setTimeout(r, 1600))
  await leePage.evaluate(() => fetch('/ai/api/v1/assistant/conversations'))
  await leePage.waitForSelector('#accessGate:not([hidden])', { timeout: 10000 })
  check('suspended at NUMZLAB while the page is open: the card returns and says why', /access to NUMZ AI has ended/i.test(await leePage.textContent('#accessGoogleNotice')))

  // ---- an account NUMZLAB has not approved ----
  await nl('google', { email: 'stranger@example.com', sub: 'sub-stranger', name: 'Stranger' })
  const strangerCtx = await browser.newContext()
  const strangerPage = await strangerCtx.newPage()
  watch(strangerPage, 'denied')
  await strangerPage.goto(`${base}/`, { waitUntil: 'load' })
  await strangerPage.waitForSelector('#accessGoogleButton', { state: 'visible' })
  await Promise.all([strangerPage.waitForURL((u) => u.pathname === '/ai/', { timeout: 20000 }), strangerPage.click('#accessGoogleButton')])
  await strangerPage.waitForSelector('#accessGoogleNotice:not([hidden])', { timeout: 10000 })
  check('an account that is not approved is told so, and is not let in', /not approved/i.test(await strangerPage.textContent('#accessGoogleNotice')) && (await strangerCtx.cookies()).length === 0)
  check('the address is tidied so a reload does not repeat the message', !new URL(strangerPage.url()).search.includes('auth='))

  // ============ B. the dashboard's service worker and NUMZ AI =================================================================
  const dashPerson = 'dash@example.com'
  await newPerson('operator', dashPerson)
  const cachesWithAi = async (p) => {
    await new Promise((r) => setTimeout(r, 1500)) // the worker stores its copies after it has answered
    return cachesWithAiNow(p)
  }
  const cachesWithAiNow = (p) => p.evaluate(async () => {
    const found = []
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) if (new URL(req.url).pathname.startsWith('/ai')) found.push(new URL(req.url).pathname)
    return found
  })
  async function dashboardVisit(version) {
    const ctx = await browser.newContext()
    const p = await ctx.newPage()
    watch(p, `dashboard-sw-${version}`)
    await p.goto(`${origin}/auth/google/start?next=%2F`, { waitUntil: 'load' })
    await p.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => Boolean(r?.active)), null, { timeout: 20000 })
    await p.reload({ waitUntil: 'load' })
    await p.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 20000 }) // the page is now under the worker's control
    await p.goto(`${base}/`, { waitUntil: 'load' })
    await p.waitForSelector('#accessGate', { timeout: 15000 })
    return { ctx, p }
  }
  // the dashboard as it is live today (its service worker has no rule for /ai/)
  await front.close()
  front = await startFront({ stack, listen: frontPort, dist: OLD_DIST })
  // (Setting a worker up in a fresh browser occasionally needs a second go: that is the rig, not the thing under test.)
  const before = await dashboardVisit('old').catch(async () => dashboardVisit('old'))
  let polluted = []
  for (let i = 0; i < 12 && polluted.length === 0; i++) polluted = await cachesWithAiNow(before.p).then((found) => found.length ? found : new Promise((r) => setTimeout(() => r([]), 500)))
  check('CONTROL: with today\'s dashboard worker, a visit to /ai/ is stored in the dashboard\'s offline cache', polluted.length > 0, polluted.join(','))
  // the new worker replaces it in the same browser, on the next dashboard visit
  await front.close()
  front = await startFront({ stack, listen: frontPort, dist: NEW_DIST })
  await before.p.goto(`${origin}/`, { waitUntil: 'load' })
  // the browser looks for a new worker on a visit; wait until the new one has taken over (the old one is replaced by skipWaiting + claim)
  await before.p.evaluate(async () => {
    const taken = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
      setTimeout(resolve, 15000)
    })
    const registration = await navigator.serviceWorker.getRegistration()
    await registration.update()
    await taken
  })
  await new Promise((r) => setTimeout(r, 1500))
  await before.p.goto(`${base}/history.html`, { waitUntil: 'load' })
  await before.p.goto(`${base}/`, { waitUntil: 'load' })
  const after = await cachesWithAi(before.p)
  check('with the new worker (same browser, after its update) nothing of NUMZ AI is kept in the dashboard\'s cache', after.length === 0, after.join(','))
  check('and the page is NUMZ AI (its own sign-in card), not the dashboard', await before.p.isVisible('#accessGate'))
  await before.ctx.close()

  check('no unexpected console errors, page errors or security-policy violations in any page', problems.length === 0, problems.slice(0, 4).join(' | '))
} catch (err) {
  console.error(err)
  check('the run finished without an exception', false, String(err?.message ?? err).slice(0, 200))
} finally {
  await browser.close()
  await front.close()
  await stack.close()
}
process.exit(finish() ? 0 : 1)
