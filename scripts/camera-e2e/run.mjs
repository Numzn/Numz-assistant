// Real-browser check of the Smart Camera. NOT part of `npm test`: it needs Playwright and ffmpeg.
//
//   npx vite build                      (the production bundle, served with its real security headers)
//   node scripts/camera-e2e/run.mjs     (writes pictures and screenshots to $CAMERA_E2E_DIR, default a temp folder)
//
// It starts the real server.js in production mode on spare ports with a throwaway database, a stub standing in for the
// vision and text models (no key, no network), and headless Chromium with a fake camera that alternates between two
// rendered "practice questions". It checks the page end to end: the camera opens only on Start, a question is read,
// answered and drawn, the next one is picked up, pause sends nothing, stop releases the camera, clearing removes what
// was saved, review mode lets the question be corrected, a hidden page pauses, and the console stays clean.
//
// Environment: PLAYWRIGHT_FROM (the package.json of a project whose node_modules has `playwright`; on this host it
// defaults to ZEDFOOTBALL's frontend, since this project does not depend on it), FFMPEG (default `ffmpeg`),
// CAMERA_E2E_DIR (where pictures and screenshots go).
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = process.env.CAMERA_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'numz-camera-e2e-'))
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM || '/srv/projects/ZEDFOOTBALL/frontend/package.json')('playwright')
fs.mkdirSync(dir, { recursive: true })
console.log('working in', dir)

// ---- the fake camera: two rendered question screens, played in turn --------------------------------------------
const SCREENS = {
  q1: '<body style="margin:0;background:#fff;color:#111;font:38px/1.5 Arial,sans-serif;padding:70px 90px;width:1100px;height:580px"><div style="color:#555;font-size:26px">Physics practice · Set 3</div><p style="margin:18px 0"><b>Question 1.</b> A car travels 150 km in 2.5 hours. What is its average speed?</p><div>A) 40 km/h &nbsp;&nbsp; B) 60 km/h &nbsp;&nbsp; C) 75 km/h &nbsp;&nbsp; D) 100 km/h</div></body>',
  q2: '<body style="margin:0;background:#f4f1ea;color:#161616;font:40px/1.5 Georgia,serif;padding:70px 90px;width:1100px;height:580px"><div style="color:#666;font-size:26px">Geography practice · Set 1</div><p style="margin:18px 0"><b>Question 2.</b> Name the longest river in Africa and the sea into which it flows.</p><div style="color:#444">Give your answer in one sentence.</div></body>'
}
{
  const shooter = await chromium.launch()
  const page = await shooter.newPage({ viewport: { width: 1280, height: 720 } })
  for (const [name, html] of Object.entries(SCREENS)) {
    await page.setContent(html)
    await page.screenshot({ path: `${dir}/${name}.png` })
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '10', '-i', `${dir}/${name}.png`, '-t', '10', '-vf', 'scale=1280:720,format=yuvj420p', '-q:v', '3', '-f', 'mjpeg', `${dir}/${name}.mjpeg`])
  }
  await shooter.close()
  fs.writeFileSync(`${dir}/feed.mjpeg`, Buffer.concat([fs.readFileSync(`${dir}/q1.mjpeg`), fs.readFileSync(`${dir}/q2.mjpeg`)]))
}

const PORT = 3995
const STUB = 3994
const db = path.join(dir, 'e2e.sqlite')
for (const f of [db, db + '-wal', db + '-shm']) fs.rmSync(f, { force: true })

const READINGS = [
  { isQuestion: true, text: 'Question 1. A car travels 150 km in 2.5 hours. What is its average speed?', options: [{ label: 'A', text: '40 km/h' }, { label: 'B', text: '60 km/h' }, { label: 'C', text: '75 km/h' }, { label: 'D', text: '100 km/h' }], type: 'multiple-choice', subject: 'physics', hasDiagram: false, confidence: 0.93, reason: '' },
  { isQuestion: true, text: 'Question 2. Name the longest river in Africa and the sea into which it flows.', options: [], type: 'short-answer', subject: 'geography', hasDiagram: false, confidence: 0.9, reason: '' }
]
const stub = { pictures: 0, texts: 0, firstPicture: null, readings: 0 }
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body)
    const flat = JSON.stringify(parsed)
    const m = flat.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/)
    res.setHeader('content-type', 'application/json')
    if (m) {
      stub.pictures++
      if (!stub.firstPicture) stub.firstPicture = Buffer.from(m[1], 'base64')
      const reading = READINGS[Math.min(stub.readings++, READINGS.length - 1)]
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }))
    }
    stub.texts++
    const first = flat.includes('average speed')
    const answer = first
      ? { subject: 'physics', type: 'multiple-choice', answer: 'B) 60 km/h', steps: ['speed = distance / time', '150 / 2.5 = 60'], explanation: 'Average speed is **distance divided by time**, so 150 km over 2.5 h is 60 km/h.', confidence: 'high', uncertainty: null }
      : { subject: 'geography', type: 'short-answer', answer: 'The Nile, flowing into the Mediterranean Sea.', steps: [], explanation: 'The Nile is generally given as the longest river in Africa and ends in the Mediterranean.', confidence: 'medium', uncertainty: 'River lengths are measured differently by different sources.' }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }))
  })
})
await new Promise((r) => server.listen(STUB, '127.0.0.1', r))

const app = spawn(process.execPath, ['--no-warnings', 'server/server.js'], {
  cwd: repo,
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME, NUMZ_SKIP_ENV_FILES: '1', PORT: String(PORT), NODE_ENV: 'production', SPEECH_DATABASE_PATH: db,
    AI_PROVIDER: 'custom', AI_API_KEY: 'stub', AI_BASE_URL: `http://127.0.0.1:${STUB}/v1`, AI_MODEL: 'stub',
    CAMERA_VISION_PROVIDER: 'openai-compatible', CAMERA_VISION_API_KEY: 'stub', CAMERA_VISION_MODEL: 'stub', CAMERA_VISION_BASE_URL: `http://127.0.0.1:${STUB}/v1`
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (c) => (appLog += c))
app.stderr.on('data', (c) => (appLog += c))
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/v1/health`)).ok) break } catch {}
  await new Promise((r) => setTimeout(r, 250))
}

const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${dir}/feed.mjpeg`, '--autoplay-policy=no-user-gesture-required']
})
const problems = []
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] })
  const page = await context.newPage()
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  await page.goto(`http://localhost:${PORT}/camera.html`, { waitUntil: 'load' })
  const kind = () => page.getAttribute('#cameraIndicator', 'data-kind')
  const label = () => page.textContent('#cameraIndicatorLabel')

  check('camera is off at first, and the indicator says so', (await kind()) === 'off' && /camera off/i.test(await label()))
  check('the video is not showing a stream before Start', await page.evaluate(() => document.getElementById('cameraPreview').srcObject === null))
  await page.screenshot({ path: `${dir}/shot-1-off-mobile.png` })

  await page.click('#startButton')
  await page.waitForFunction(() => ['scanning', 'sending'].includes(document.getElementById('cameraIndicator').dataset.kind), null, { timeout: 15000 })
  check('after Start the camera is on and scanning', (await kind()) === 'scanning' || (await kind()) === 'sending', `kind=${await kind()}`)
  check('the preview has a live stream', await page.evaluate(() => document.getElementById('cameraPreview').srcObject?.active === true))

  await page.waitForSelector('#answerPanel:not([hidden])', { timeout: 30000 })
  const q1 = await page.inputValue('#questionText')
  check('question 1 was read and shown', /150 km in 2\.5 hours/.test(q1), q1.slice(0, 60))
  check('its options are listed', (await page.textContent('#questionOptions')).includes('B) 60 km/h'))
  check('the answer headline is shown', (await page.textContent('#answerBody .ans-headline')).includes('60 km/h'))
  check('the working is shown as steps', (await page.locator('#answerBody .ans-steps li').count()) === 2)
  check('the explanation is rendered (bold survived)', (await page.locator('#answerBody .ans-explanation strong').count()) === 1)
  check('confidence badge says high', /high/i.test(await page.textContent('#answerBody .ans-confidence')))
  check('it returned to waiting: scanning again', ['scanning', 'sending'].includes(await kind()))
  await page.screenshot({ path: `${dir}/shot-2-answer-mobile.png` })

  const jpeg = stub.firstPicture
  fs.writeFileSync(`${dir}/uploaded-1.jpg`, jpeg)
  check('what was uploaded is a real JPEG of reasonable size', jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg.length > 5000 && jpeg.length < 1_500_000, `${jpeg.length} bytes`)

  // The feed switches to question 2 after about 10 s.
  await page.waitForFunction(() => document.querySelectorAll('#historyList > li').length >= 2, null, { timeout: 40000 })
  const q2 = await page.inputValue('#questionText')
  check('question 2 was read when the screen changed', /longest river in Africa/.test(q2), q2.slice(0, 60))
  check('its answer is shown, with the uncertainty', (await page.textContent('#answerBody .ans-headline')).includes('Nile') && /measured differently/.test(await page.textContent('#answerBody .ans-uncertain')))
  check('history lists both, newest first', (await page.locator('#historyList .hist-title').allTextContents()).map((t) => t.slice(0, 12)).join('|') === 'Question 2. |Question 1. ')
  await page.screenshot({ path: `${dir}/shot-3-two-mobile.png` })

  await page.locator('#historyList .hist-toggle').nth(1).click()
  check('a previous answer can be opened', (await page.locator('#historyList .hist-detail:not([hidden]) .ans-headline').textContent()).includes('60 km/h'))
  await page.screenshot({ path: `${dir}/shot-4-history-open-mobile.png` })

  const before = stub.pictures
  await page.waitForTimeout(6000)
  check('the same screen is not sent again (still on question 2 or looping)', stub.pictures - before <= 1, `extra pictures: ${stub.pictures - before}`)

  // Pause: nothing is sent, and the indicator says so.
  await page.click('#pauseButton')
  check('paused: the indicator says nothing is sent', (await kind()) === 'paused' && /nothing is sent/i.test(await label()))
  const paused = stub.pictures
  await page.waitForTimeout(5000)
  check('paused: no pictures were sent', stub.pictures === paused)
  await page.screenshot({ path: `${dir}/shot-5-paused-mobile.png` })
  await page.click('#resumeButton')
  check('resumed: scanning again', ['scanning', 'sending'].includes(await kind()))

  // Stop releases the camera.
  await page.click('#stopButton')
  check('stopped: camera off and the stream released', (await kind()) === 'off' && (await page.evaluate(() => document.getElementById('cameraPreview').srcObject === null)))

  // Clearing the history (two taps) removes it here and on the server.
  const savedBefore = (await (await fetch(`http://127.0.0.1:${PORT}/api/v1/assistant/conversations`)).json()).total
  await page.click('#clearButton')
  check('clear asks first', /click again/i.test(await page.textContent('#clearButton')))
  await page.click('#clearButton')
  await page.waitForFunction(() => document.getElementById('historyPanel').hidden, null, { timeout: 5000 })
  const savedAfter = (await (await fetch(`http://127.0.0.1:${PORT}/api/v1/assistant/conversations`)).json()).total
  check('after clearing, nothing of it remains on the server', savedBefore >= 1 && savedAfter === 0, `saved ${savedBefore} -> ${savedAfter}`)

  // Review mode on a desktop-sized window.
  const desktop = await context.newPage()
  desktop.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`desktop ${m.type()}: ${m.text()}`) })
  await desktop.setViewportSize({ width: 1280, height: 800 })
  stub.readings = 0
  await desktop.goto(`http://localhost:${PORT}/camera.html`, { waitUntil: 'load' })
  await desktop.uncheck('#autoInput', { force: true }).catch(async () => desktop.click('#autoToggle'))
  check('review mode can be chosen', (await desktop.isChecked('#autoInput')) === false)
  await desktop.click('#startButton')
  await desktop.waitForSelector('#questionActions:not([hidden])', { timeout: 30000 })
  check('review mode waits for the person, with the answer not yet worked out', (await desktop.locator('#answerPanel').isHidden()) && (await kindOf(desktop)) === 'review')
  const textBox = desktop.locator('#questionText')
  check('the question can be edited in review', (await textBox.isEditable()) === true)
  await textBox.fill('Question 1. A car travels 150 km in 2.5 hours. What is its average speed in km/h?')
  await desktop.screenshot({ path: `${dir}/shot-6-review-desktop.png` })
  await desktop.click('#confirmButton')
  await desktop.waitForSelector('#answerPanel:not([hidden])', { timeout: 20000 })
  check('confirming answers the corrected question', (await desktop.textContent('#answerBody .ans-headline')).includes('60 km/h'))
  await desktop.screenshot({ path: `${dir}/shot-7-answer-desktop.png` })
  await desktop.reload()
  await desktop.click('#startButton')
  await desktop.waitForSelector('#questionActions:not([hidden])', { timeout: 30000 })
  check('the choice of review mode is remembered on this device', (await desktop.isChecked('#autoInput')) === false)
  await desktop.click('#stopButton')

  // A page left (hidden) must not keep scanning: simulate the tab going to the background.
  const third = await context.newPage()
  await third.goto(`http://localhost:${PORT}/camera.html`, { waitUntil: 'load' })
  await third.click('#startButton')
  await third.waitForFunction(() => ['scanning', 'sending'].includes(document.getElementById('cameraIndicator').dataset.kind), null, { timeout: 15000 })
  await third.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')) })
  check('a hidden page is paused, not scanning', (await kindOf(third)) === 'paused')

  check('no console errors, CSP violations or page errors', problems.length === 0, problems.slice(0, 4).join(' | '))
} finally {
  await browser.close()
  app.kill('SIGTERM')
  await new Promise((r) => app.once('exit', r))
  server.close()
}
async function kindOf(p) { return p.getAttribute('#cameraIndicator', 'data-kind') }
console.log('---- server log mentions of the questions or picture bytes:', /Africa|150 km|average speed|\/9j\//.test(appLog) ? 'FOUND (bad)' : 'none (good)')
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED')
process.exit(results.every(Boolean) ? 0 : 1)
