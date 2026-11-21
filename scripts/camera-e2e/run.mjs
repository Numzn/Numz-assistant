// Real-browser check of the Smart Camera (the happy path). NOT part of `npm test`: it needs Playwright and ffmpeg.
//
//   npx vite build                      (the production bundle, served with its real security headers)
//   node scripts/camera-e2e/run.mjs     (writes pictures and screenshots to $CAMERA_E2E_DIR, default a temp folder)
//   node scripts/camera-e2e/unhappy.mjs (the same for what goes wrong: no provider, camera refused, locked, failing)
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
import fs from 'node:fs'
import { kindOf, launchBrowser, makeFeed, phone, reporter, startApp, startStub, workDir } from './lib.mjs'

const dir = workDir()
console.log('working in', dir)
const feed = await makeFeed(dir)
const PORT = 3995
const STUB = 3994
const stub = await startStub(STUB)
const appHandle = await startApp({ dir, port: PORT, stubPort: STUB })
const { check, finish } = reporter()
const browser = await launchBrowser(feed)

const problems = []
try {
  const context = await browser.newContext(phone)
  const page = await context.newPage()
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  await page.goto(`${appHandle.origin}/camera.html`, { waitUntil: 'load' })
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
  await desktop.goto(`${appHandle.origin}/camera.html`, { waitUntil: 'load' })
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
  await third.goto(`${appHandle.origin}/camera.html`, { waitUntil: 'load' })
  await third.click('#startButton')
  await third.waitForFunction(() => ['scanning', 'sending'].includes(document.getElementById('cameraIndicator').dataset.kind), null, { timeout: 15000 })
  await third.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')) })
  check('a hidden page is paused, not scanning', (await kindOf(third)) === 'paused')

  check('no console errors, CSP violations or page errors', problems.length === 0, problems.slice(0, 4).join(' | '))
} finally {
  await browser.close()
  await appHandle.stop()
  stub.server.close()
}
const leaked = /Africa|150 km|average speed|\/9j\//.test(appHandle.log)
check('the server log never mentions a question or picture bytes', !leaked)
process.exit(finish() ? 0 : 1)
