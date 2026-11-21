// Real-browser check of the Smart Camera when things go wrong. NOT part of `npm test` (needs Playwright and ffmpeg).
// See run.mjs for what it starts and how to run it.
//
//   no vision provider        the state production is in until a key is plugged in
//   camera refused / busy / insecure page, then recovering with "Try again"
//   assistant locked          the access gate, a wrong code, the right code
//   the vision model failing  then "Try again"; the answer model failing, then "Try again" without re-reading
//   the session limit         the message, then Clear history to carry on
//   the camera taken away mid-session
//   keyboard and names        every control reachable and named
import { kindOf, launchBrowser, makeFeed, phone, reporter, startApp, startStub, workDir } from './lib.mjs'

const dir = workDir()
console.log('working in', dir)
const feed = await makeFeed(dir)
const STUB = 3994
const stub = await startStub(STUB)
const browser = await launchBrowser(feed)
const { check, finish } = reporter()
let scope = { apps: [], contexts: [] }
const start = async (port, options = {}) => {
  const app = await startApp({ dir, port, stubPort: STUB, ...options })
  scope.apps.push(app)
  return app
}
const reset = () => Object.assign(stub, { pictures: 0, texts: 0, readings: 0, failPictures: 0, failTexts: 0, firstPicture: null })
const label = (page) => page.textContent('#cameraIndicatorLabel')
const status = (page) => page.textContent('#cameraStatus')
const open = async (app, { init } = {}) => {
  const context = await browser.newContext(phone)
  scope.contexts.push(context)
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  const problems = []
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()) })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  const reads = []
  page.on('request', (r) => { if (/\/camera\/sessions\/[^/]+\/read/.test(r.url())) reads.push(r.url()) })
  await page.goto(`${app.origin}/camera.html`, { waitUntil: 'load' })
  return { page, context, problems, reads }
}
/** Runs one scenario under a deadline; a failure is recorded and the next scenario still runs. Its pages and servers are closed after. */
async function scenario(title, run, limitMs = 150_000) {
  console.log(`\n# ${title}`)
  scope = { apps: [], contexts: [] }
  let timer
  try {
    await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not finish within ${limitMs / 1000} s`)), limitMs) })])
  } catch (err) {
    check(`"${title}" ran to the end`, false, String(err?.message ?? err).split('\n')[0].slice(0, 200))
  } finally {
    clearTimeout(timer)
    for (const context of scope.contexts) await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
    for (const app of scope.apps) await Promise.race([app.stop().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
  }
}
const scanning = (page) => page.waitForFunction(() => ['scanning', 'sending'].includes(document.getElementById('cameraIndicator').dataset.kind), null, { timeout: 15000 })

try {
  // ---- 1. no vision provider -------------------------------------------------------------------------------------
  await scenario('no vision provider configured', async () => {
    reset()
    const app = await start(3991, { vision: false })
    const { page, problems, reads } = await open(app)
    await page.click('#startButton')
    await page.waitForFunction(() => document.getElementById('cameraIndicator').dataset.kind === 'unavailable', null, { timeout: 15000 })
    check('the camera opens and shows it is not scanning, and why', /not scanning.*no vision/i.test(await label(page)))
    check('the page says reading is not set up', /not set up/i.test(await status(page)))
    check('the preview is live (the person can still see what the camera sees)', await page.evaluate(() => document.getElementById('cameraPreview').srcObject?.active === true))
    check('manual capture is not offered when it cannot work', await page.isHidden('#captureButton'))
    await page.waitForTimeout(5000)
    check('no picture is sent anywhere', reads.length === 0 && stub.pictures === 0)
    await page.screenshot({ path: `${dir}/unhappy-1-no-vision.png` })
    await page.click('#stopButton')
    check('stop still releases the camera', (await kindOf(page)) === 'off')
    check('no console errors', problems.length === 0, problems.join(' | '))
  })

  // ---- 2. the camera is refused, busy or the page is not secure -------------------------------------------------------
  await scenario('the camera cannot be opened', async () => {
    reset()
    const app = await start(3990)
    const { page } = await open(app, {
      init: () => {
        window.__camera = 'deny'
        const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = (constraints) =>
          window.__camera === 'deny' ? Promise.reject(new DOMException('no', 'NotAllowedError'))
            : window.__camera === 'busy' ? Promise.reject(new DOMException('no', 'NotReadableError'))
              : window.__camera === 'none' ? Promise.reject(new DOMException('no', 'NotFoundError'))
                : real(constraints)
      }
    })
    await page.click('#startButton')
    await page.waitForFunction(() => /blocked/i.test(document.getElementById('cameraStatus').textContent), null, { timeout: 8000 })
    check('a refused camera says to allow it', /allow it in the browser/i.test(await status(page)))
    check('and offers "Try again", not a dead end', await page.isVisible('#retryButton'))
    check('nothing was sent', stub.pictures === 0)
    await page.evaluate(() => (window.__camera = 'busy'))
    await page.click('#retryButton')
    await page.waitForFunction(() => /in use/i.test(document.getElementById('cameraStatus').textContent), null, { timeout: 8000 })
    check('a camera in use by another app says so', /another app/i.test(await status(page)))
    await page.evaluate(() => (window.__camera = 'none'))
    await page.click('#retryButton')
    await page.waitForFunction(() => /no camera/i.test(document.getElementById('cameraStatus').textContent), null, { timeout: 8000 })
    check('a device with no camera says so', true)
    await page.evaluate(() => (window.__camera = 'ok'))
    await page.click('#retryButton')
    await scanning(page)
    check('once allowed, "Try again" gets going', true)
    await page.screenshot({ path: `${dir}/unhappy-2-recovered.png` })

    const insecure = await open(app, { init: () => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); Object.defineProperty(window, 'isSecureContext', { value: false }) } })
    await insecure.page.click('#startButton')
    await insecure.page.waitForFunction(() => /secure/i.test(document.getElementById('cameraStatus').textContent), null, { timeout: 8000 })
    check('a page that is not https says the camera needs a secure connection', /https/i.test(await status(insecure.page)))
  })

  // ---- 3. the assistant is locked behind its access code -----------------------------------------------------------------
  await scenario('the assistant is locked (Phase 0)', async () => {
    reset()
    const code = 'a-long-enough-access-code'
    const app = await start(3989, { env: { ASSISTANT_ACCESS_CODE: code } })
    const { page } = await open(app)
    await page.waitForSelector('#accessGate:not([hidden])', { timeout: 8000 })
    check('the camera page asks for the access code', true)
    await page.screenshot({ path: `${dir}/unhappy-3-locked.png` })
    const denied = await fetch(`${app.origin}/api/v1/assistant/camera/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    check('and the camera API itself refuses without it', denied.status === 401)
    await page.fill('#accessCode', 'definitely-the-wrong-code')
    await page.click('#accessSubmit')
    await page.waitForSelector('#accessError:not([hidden])', { timeout: 8000 })
    check('a wrong code is refused with a message', (await page.textContent('#accessError')).length > 3)
    await page.fill('#accessCode', code)
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#accessSubmit')])
    check('the right code unlocks and reloads', await page.isHidden('#accessGate'))
    await page.click('#startButton')
    await page.waitForSelector('#answerPanel:not([hidden])', { timeout: 30000 })
    check('after unlocking, a question is read and answered', /60 km\/h/.test(await page.textContent('#answerBody .ans-headline')))
  })

  // ---- 4. the models fail ---------------------------------------------------------------------------------------------
  await scenario('the vision model fails, then the answer model fails', async () => {
    reset()
    const app = await start(3988)
    stub.failPictures = 3 // the first try and both automatic retries
    const first = await open(app)
    const page = first.page
    await page.click('#startButton')
    await page.waitForFunction(() => document.getElementById('cameraIndicator').dataset.kind === 'error', null, { timeout: 20000 })
    check('after its retries the page says the picture could not be read (the server itself was fine)', /picture could not be read/i.test(await status(page)))
    check('three attempts were made, not an endless loop', stub.pictures === 3, `pictures=${stub.pictures}`)
    check('"Try again" is offered', await page.isVisible('#retryButton'))
    await page.waitForTimeout(3000)
    check('it did not keep hammering the provider while waiting for the person', stub.pictures === 3)
    await page.click('#retryButton')
    await page.waitForSelector('#answerPanel:not([hidden])', { timeout: 20000 })
    check('"Try again" took a fresh picture and it went through', stub.pictures === 4 && /60 km\/h/.test(await page.textContent('#answerBody .ans-headline')))

    await first.context.close() // it would keep scanning and use up the next part's counters
    reset()
    stub.failTexts = 3
    const second = await open(app)
    await second.page.click('#startButton')
    await second.page.waitForFunction(() => document.getElementById('cameraIndicator').dataset.kind === 'error', null, { timeout: 20000 })
    check('when the answer fails, it says so', /answer could not be worked out/i.test(await status(second.page)))
    check('and keeps the question it had read', /150 km in 2\.5 hours/.test(await second.page.inputValue('#questionText')))
    const picturesBefore = stub.pictures
    await second.page.click('#retryButton')
    await second.page.waitForSelector('#answerPanel:not([hidden])', { timeout: 20000 })
    check('"Try again" asks for the answer only: the picture is not read again', stub.pictures === picturesBefore && /60 km\/h/.test(await second.page.textContent('#answerBody .ans-headline')))
  })

  // ---- 5. the session limit ------------------------------------------------------------------------------------------
  await scenario('the session limit (CAMERA_MAX_READS=2)', async () => {
    reset()
    const app = await start(3987, { env: { CAMERA_MAX_READS: '2' } })
    const { page } = await open(app)
    await page.click('#startButton')
    await page.waitForFunction(() => /limit/i.test(document.getElementById('cameraIndicatorLabel').textContent), null, { timeout: 40000 })
    check('at the limit the indicator says scanning has stopped', /not scanning.*limit/i.test(await label(page)))
    check('the message says how to carry on', /clear the history/i.test(await status(page)))
    check('only two pictures were ever sent', stub.pictures === 2, `pictures=${stub.pictures}`)
    check('manual capture is not offered', await page.isHidden('#captureButton'))
    await page.screenshot({ path: `${dir}/unhappy-5-limit.png` })
    const box = await page.locator('#limitClearButton').boundingBox()
    check('the way out is a button among the controls, on screen without scrolling', box && box.y + box.height < 844, JSON.stringify(box))
    await page.click('#limitClearButton')
    check('it asks to be tapped again before clearing', /again/i.test(await page.textContent('#limitClearButton')))
    await page.click('#limitClearButton')
    await page.waitForFunction(() => ['scanning', 'sending', 'working'].includes(document.getElementById('cameraIndicator').dataset.kind), null, { timeout: 8000 })
    check('clearing the history starts a fresh session and scanning resumes', true)
    await page.waitForFunction(() => document.querySelectorAll('#historyList > li').length >= 1, null, { timeout: 30000 })
    check('and it reads again', stub.pictures >= 3, `pictures=${stub.pictures}`)
  })

  // ---- 6. the camera is taken away mid-session -----------------------------------------------------------------------
  await scenario('the camera is taken away', async () => {
    reset()
    const app = await start(3986)
    const { page } = await open(app)
    await page.click('#startButton')
    await scanning(page)
    await page.evaluate(() => document.getElementById('cameraPreview').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')))
    await page.waitForFunction(() => document.getElementById('cameraIndicator').dataset.kind === 'off', null, { timeout: 5000 })
    check('the page notices, turns itself off and says so', /disconnected/i.test(await status(page)))
    check('and lets go of the stream', await page.evaluate(() => document.getElementById('cameraPreview').srcObject === null))
    await page.click('#startButton')
    await scanning(page)
    check('and can be started again', true)
  })

  // ---- 7. keyboard and names ------------------------------------------------------------------------------------------
  await scenario('keyboard and names', async () => {
    reset()
    const app = await start(3985)
    const { page } = await open(app)
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button, a, input, textarea, video')]
        .filter((el) => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none')
        .filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim() || (el.labels && el.labels.length) || el.id === 'cameraPreview'))
        .map((el) => el.outerHTML.slice(0, 60))
    )
    check('every visible control has a name', unnamed.length === 0, unnamed.join(' | '))
    const order = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      order.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim().slice(0, 20) || document.activeElement?.tagName))
    }
    check('the Start button is reachable with the keyboard', order.includes('startButton'), order.join(' > '))
    check('hidden controls are never focused', !order.some((id) => ['pauseButton', 'resumeButton', 'stopButton', 'captureButton', 'retryButton', 'confirmButton'].includes(id)))
    await page.focus('#startButton')
    const outline = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return `${s.outlineStyle} ${s.outlineWidth} ${s.boxShadow}` })
    console.log('   focus style on Start:', outline)
    await page.keyboard.press('Enter')
    await scanning(page)
    check('Start works from the keyboard', true)
  })
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 10_000))])
  stub.server.close()
}
const ok = finish()
process.exit(ok ? 0 : 1)
