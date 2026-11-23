// Real-browser check that the Study panel, the Meeting panel and the conversation share the screen instead of fighting for it.
// Real NUMZ AI server in per-person sign-in mode, real numzlab-auth broker (pretend Google), real Chromium; only the paid text model is
// a stand-in. NOT part of `npm test` (it needs Playwright, Chromium and numzlab-auth's test rig):
//
//   node scripts/ui-layout-e2e/run.mjs            screenshots go to UI_LAYOUT_E2E_DIR (default: a temp folder, printed)
//
// It measures, at each window width, where the panels and the conversation are, and whether the things a person must reach (the
// composer, the last answer, the header buttons, the panel's own controls) are really reachable: an element that is covered by
// another one fails the check (document.elementFromPoint, not a guess from the CSS).
//
// What it cannot show: the desktop app's own window (WebKitGTK / WebView2 / WKWebView draw the same CSS, but this runs Chromium),
// a real finger on a phone, a real model.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, reporter, repo } from '../camera-e2e/lib.mjs'
import { startStack } from '../../tests/helpers/aiRig.js'
import { measureLayout } from './measure.mjs'

const dir = process.env.UI_LAYOUT_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'numz-ui-layout-e2e-'))
fs.mkdirSync(dir, { recursive: true })
console.log('working in', dir)
if (!process.argv.includes('--skip-build')) {
  console.log('building NUMZ AI for /ai/ ...')
  execFileSync('npx', ['vite', 'build'], { cwd: repo, env: { ...process.env, VITE_PUBLIC_BASE: '/ai/' }, stdio: 'ignore' })
  execFileSync('node', ['scripts/precompress.js', 'dist'], { cwd: repo, stdio: 'ignore' })
}

// ---- the pretend model: a long-ish answer, streamed, so the thread really scrolls -----------------------------------------
const ANSWER = 'Second normal form means every non-key column depends on the **whole** key.\n\n- the first point, about the key\n- the second point, about partial dependencies\n- the third point, with an example from an order line\n\nSo the product name belongs in its own table, keyed by the product number.'
// Paragraphs of running text, for an answer whose height depends on the width and the size of the type it is drawn in.
const PARAGRAPH = 'A primary key identifies one row of a table, and no other, so its values must be unique and can never be empty. A foreign key is a column whose values must match the primary key of another table, and that match is how two tables are linked together. Together they let a database refuse a row that points at nothing, and keep what the tables say about each other consistent.'
const model = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* none */
    }
    const usage = { prompt_tokens: 100, completion_tokens: 50 }
    const asked = JSON.stringify(body.messages ?? [])
    const answer = asked.includes('LONGANSWER') ? Array(7).fill(ANSWER).join('\n\n') : asked.includes('WIDEANSWER') ? Array(Number(process.env.WIDE_PARAGRAPHS || 9)).fill(PARAGRAPH).join('\n\n') : ANSWER
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const word of answer.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [{ delta: { content: word } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [], usage })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { role: 'assistant', content: answer } }], usage }))
  })
})
await new Promise((r) => model.listen(0, '127.0.0.1', r))

const { check: report, finish } = reporter()
let lastCheck = 'setup' // where in the run a page error happened
const check = (label, ...rest) => ((lastCheck = label), report(label, ...rest))
const problems = []
const stack = await startStack({ env: { AI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, ACADEMIC_RESEARCH: 'off' } })
const browser = await chromium.launch()
try {
  const nl = (route, body) => stack.numzlab.control(route, body)
  await nl('invite', { email: 'ada@example.com', role: 'operator' })
  await nl('google', { email: 'ada@example.com', sub: 'sub-ada', name: 'ada' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  page.on('console', (m) => {
    const text = m.text()
    if (!['error', 'warning'].includes(m.type())) return
    if (/401|403|429|503|Failed to load resource|Sign in to use NUMZ AI|Failed to fetch/.test(text)) return
    problems.push(`[after "${lastCheck}"] ${m.type()}: ${text.slice(0, 160)}`)
  })
  page.on('pageerror', (e) => problems.push(`[after "${lastCheck}"] pageerror: ${e.message.slice(0, 160)}`))
  await page.goto(`${stack.app.base}/`, { waitUntil: 'load' })
  await page.waitForSelector('#accessGoogleButton', { state: 'visible', timeout: 15000 })
  await Promise.all([page.waitForURL((u) => u.pathname === '/ai/' && !u.search, { timeout: 20000 }), page.click('#accessGoogleButton')])
  await page.waitForSelector('#accessGate', { state: 'hidden', timeout: 15000 })
  await page.waitForLoadState('networkidle')

  // a conversation long enough to scroll, then a study session
  for (const text of ['Hello', 'What is second normal form?', 'And third normal form?']) {
    const before = await page.locator('li.msg[data-role="assistant"]').count()
    await page.waitForFunction(() => !document.querySelector('#composerInput').disabled, null, { timeout: 10000 })
    await page.fill('#composerInput', text)
    await page.waitForFunction(() => !document.querySelector('#sendButton').disabled, null, { timeout: 5000 })
    await page.click('#sendButton')
    await page.waitForFunction((n) => document.querySelectorAll('li.msg[data-role="assistant"]').length > n, before, { timeout: 30000 })
    await page.waitForFunction(() => !document.querySelector('#sendButton').hidden, null, { timeout: 10000 })
    // A message sent the instant the last reply lands, before the assistant has gone back to idle, made the assistant's state machine log
    // "Invalid assistant transition: PROCESSING -> LISTENING" in this setup, before any panel was touched. That code is not part of this
    // change and it was not tried on main; the test just waits for idle, as a person would.
    await page.waitForFunction(() => document.querySelector('#assistantStateBadge')?.dataset.state === 'IDLE', null, { timeout: 10000 })
  }
  await page.click('#studyButton')
  await page.waitForSelector('#studyPanel', { state: 'visible' })
  await page.click('button:has-text("Start session")')
  await page.waitForSelector('#studyAskInput', { timeout: 10000 })
  await page.click('#studyClose')
  await page.waitForSelector('#studyPanel', { state: 'hidden' })

  // ---- measuring ------------------------------------------------------------------------------------------------------
  const measure = () => page.evaluate(measureLayout)
  const shot = (name) => page.screenshot({ path: `${dir}/${name}.png` })
  const openStudy = async () => {
    if (await page.isHidden('#studyPanel')) await page.click('#studyButton')
    await page.waitForSelector('#studyPanel', { state: 'visible' })
  }
  const openMeeting = async () => {
    if (await page.isHidden('#meetingPanel')) await page.click('#meetingButton')
    await page.waitForSelector('#meetingPanel', { state: 'visible' })
  }
  const size = async (w, h = 800) => {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(350) // the sidebar drawer animates
  }

  // ==== A. with nothing open the page is as it was: no dock, the conversation takes the whole width ======================
  for (const w of [1600, 1280, 1000, 390]) {
    await size(w)
    const m = await measure()
    check(`${w}px, nothing open: the composer is one row, with a text box wide enough to type in`, m.composerInput.w >= 150 && m.composer.h <= 90, `box ${m.composerInput.w}px wide, composer ${m.composer.h}px tall`)
    check(`${w}px, nothing open: there is no dock and nothing is lost to it`, m.dock === null && m.dockAttr === 'none' && m.visiblePanels.length === 0)
    check(`${w}px, nothing open: the conversation reaches the right edge`, m.chatMain.right === m.w, `right ${m.chatMain.right} of ${m.w}`)
    check(`${w}px, nothing open: no sideways scrolling`, !m.hScroll)
  }

  // ==== B. wide and medium windows: the panel sits BESIDE the conversation ==============================================
  for (const w of [1600, 1280, 1200, 1101]) {
    await size(w)
    await openStudy()
    const m = await measure()
    const label = `${w}px, Study open`
    check(`${label}: the dock is a column on the right, 340 to 420 px wide`, m.dock && m.dock.right === m.w && m.dock.w >= 340 && m.dock.w <= 421, JSON.stringify(m.dock))
    check(`${label}: the conversation ends where the dock begins (no overlap)`, m.chatMain.right <= m.dock.x, `chat right ${m.chatMain.right}, dock x ${m.dock?.x}`)
    check(`${label}: the conversation keeps at least 480 px`, m.chatMain.w >= 480, `chat ${m.chatMain.w}`)
    check(`${label}: the sidebar is still beside it`, m.sidebarVisible && m.sidebar.x === 0)
    check(`${label}: the composer is one row: a text box wide enough to type in, its controls beside it`, m.composerInput.w >= 180 && m.composer.h <= 90, `box ${m.composerInput.w}px wide, composer ${m.composer.h}px tall`)
    check(`${label}: the composer, its Send button and the last answer can be clicked`, m.reach['#composerInput'] && m.reach['#sendButton'] && m.reach['#thread > li:last-child'], JSON.stringify(m.reach))
    check(`${label}: the header's Meeting and Study buttons can still be clicked`, m.reach['#meetingButton'] && m.reach['#studyButton'])
    check(`${label}: the panel's own box and close button can be clicked`, m.reach['#studyAskInput'] && m.reach['#studyClose'])
    check(`${label}: no sideways scrolling`, !m.hScroll)
    if ([1600, 1280, 1101].includes(w)) await shot(`${w}-study`)
    await page.click('#studyClose')
    await page.waitForSelector('#studyPanel', { state: 'hidden' })
  }

  // ==== C. Study and Meeting never sit on top of each other: opening one closes the other ===============================
  await size(1280)
  await openStudy()
  const widthStudy = (await measure()).dock.w
  await page.click('#meetingButton')
  await page.waitForSelector('#meetingPanel', { state: 'visible' })
  let m = await measure()
  check('1280px, Meeting opened over Study: only Meeting is shown', m.visiblePanels.join() === 'meetingPanel' && m.dockAttr === 'meeting', m.visiblePanels.join())
  check('1280px: the header buttons say which one is open', (await page.getAttribute('#meetingButton', 'aria-expanded')) === 'true' && (await page.getAttribute('#studyButton', 'aria-expanded')) === 'false')
  check('1280px: the dock does not change width when the panel changes', m.dock.w === widthStudy, `${widthStudy} -> ${m.dock.w}`)
  check('1280px: the Meeting form can be clicked (nothing lies on it)', m.reach['#meetingStart'] || (await page.evaluate(() => { const b = document.querySelector('#meetingStart'); if (!b || b.hidden) return true; const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return b === t || b.contains(t) })))
  check('1280px: the conversation is still beside it, not under it', m.chatMain.right <= m.dock.x && m.reach['#composerInput'])
  await shot('1280-meeting')
  await page.click('#studyButton')
  await page.waitForSelector('#studyPanel', { state: 'visible' })
  m = await measure()
  check('1280px, Study opened over Meeting: only Study is shown, and Meeting says it is closed', m.visiblePanels.join() === 'studyPanel' && (await page.getAttribute('#meetingButton', 'aria-expanded')) === 'false')
  await page.click('#studyButton')
  await page.waitForSelector('#studyPanel', { state: 'hidden' })
  m = await measure()
  check('1280px: pressing the Study button again closes the dock and gives the width back', m.dock === null && m.chatMain.right === m.w)

  // ==== D. medium window (901-1100): the sidebar steps aside as a drawer so the conversation keeps its width ==============
  for (const w of [1100, 1000, 901]) {
    await size(w)
    m = await measure()
    check(`${w}px, nothing open: the sidebar is still a column beside the conversation`, m.sidebarVisible && m.chatMain.x === 272, `chat x ${m.chatMain.x}`)
    await openStudy()
    await page.waitForTimeout(350)
    m = await measure()
    const label = `${w}px, Study open`
    check(`${label}: the sidebar has stepped aside and the conversation starts at the left edge`, !m.sidebarVisible && m.chatMain.x === 0, `chat x ${m.chatMain.x}`)
    check(`${label}: the conversation ends where the dock begins`, m.chatMain.right <= m.dock.x && m.dock.right === m.w, `chat right ${m.chatMain.right}, dock ${JSON.stringify(m.dock)}`)
    check(`${label}: the conversation keeps at least 480 px`, m.chatMain.w >= 480, `chat ${m.chatMain.w}`)
    check(`${label}: the composer, the last answer and the header buttons can be clicked`, m.reach['#composerInput'] && m.reach['#sendButton'] && m.reach['#thread > li:last-child'] && m.reach['#meetingButton'] && m.reach['#studyButton'], JSON.stringify(m.reach))
    check(`${label}: the navigation button is there to bring the sidebar back`, m.reach['#sidebarToggle'])
    if (w === 1000) {
      await shot('1000-study')
      await page.click('#sidebarToggle')
      await page.waitForTimeout(450)
      const open = await measure()
      check('1000px: the sidebar opens as a drawer over the conversation', open.sidebarVisible && open.sidebar.x === 0 && open.sidebar.w <= 300)
      await shot('1000-study-sidebar')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(450)
    }
    await page.click('#studyClose')
    await page.waitForSelector('#studyPanel', { state: 'hidden' })
    await page.waitForTimeout(350)
    m = await measure()
    check(`${w}px, closed again: the sidebar is back in its column and the conversation where it was`, m.sidebarVisible && m.chatMain.x === 272)
  }

  // ==== E. narrow windows (the desktop app's smallest is 720; phones): the dock replaces the conversation UNDER the header ====
  for (const w of [900, 800, 720, 390]) {
    await size(w, w === 390 ? 760 : 800)
    const before = await page.evaluate(() => {
      const main = document.querySelector('#chatMain')
      main.scrollTop = Math.max(0, main.scrollHeight / 3)
      return main.scrollTop
    })
    check(`${w}px: the conversation is scrolled up from the bottom before the test (so a lost position would show)`, before > 0, `scrollTop ${before}`)
    await openStudy()
    m = await measure()
    const label = `${w}px, Study open`
    check(`${label}: the header is on screen and its buttons can be clicked`, m.header && m.header.y === 0 && m.reach['#studyButton'] && m.reach['#meetingButton'], JSON.stringify(m.reach))
    check(`${label}: the dock starts exactly under the header and fills the rest of the screen`, m.dock && Math.abs(m.dock.y - m.header.bottom) <= 1 && m.dock.w === m.w && m.dock.bottom === m.h, `header bottom ${m.header?.bottom}, dock ${JSON.stringify(m.dock)}`)
    check(`${label}: the panel's own box and close button can be clicked`, m.reach['#studyAskInput'] && m.reach['#studyClose'])
    check(`${label}: the conversation is out of the way (hidden, not removed)`, m.chatVisibility === 'hidden' && (await page.locator('#thread > li').count()) >= 6)
    check(`${label}: the navigation button is reachable`, m.reach['#sidebarToggle'])
    check(`${label}: no sideways scrolling`, !m.hScroll)
    await shot(`${w}-study`)
    await page.click('#studyButton') // the same button closes it: the way back is never covered
    await page.waitForSelector('#studyPanel', { state: 'hidden' })
    m = await measure()
    check(`${w}px, closed again: the conversation is back, reachable, and exactly where it was scrolled to`, m.chatVisibility === 'visible' && m.reach['#composerInput'] && m.reach['#sendButton'] && m.chatScrollTop === before, `scrollTop ${before} -> ${m.chatScrollTop}`)
  }

  // ==== F. narrow: Meeting and Study trade places through the header, nothing is covered ==================================
  await size(800)
  await openMeeting()
  m = await measure()
  check('800px, Meeting open: it fills the space under the header and its buttons are clickable', m.dock && Math.abs(m.dock.y - m.header.bottom) <= 1 && m.reach['#meetingClose'] && m.reach['#studyButton'])
  await shot('800-meeting')
  await page.click('#studyButton')
  await page.waitForSelector('#studyPanel', { state: 'visible' })
  m = await measure()
  check('800px: Study replaces Meeting in the same place', m.visiblePanels.join() === 'studyPanel' && m.dock && Math.abs(m.dock.y - m.header.bottom) <= 1)
  await page.click('#studyClose')
  await page.waitForSelector('#studyPanel', { state: 'hidden' })

  // ==== G. keyboard: Escape closes the panel and puts the focus back on the button that opened it =========================
  await size(1280)
  await openStudy()
  await page.focus('#studyAskInput')
  await page.keyboard.press('Escape')
  await page.waitForSelector('#studyPanel', { state: 'hidden' })
  check('Escape in the Study panel closes it and the dock', (await page.evaluate(() => document.activeElement?.id)) === 'studyButton' && (await measure()).dock === null)

  // ==== H. an answer given while the panel is open lands in the conversation you can see (wide), and nothing breaks ======
  await openStudy()
  // Reading the newest message, as the person asking would be (the thread leaves anyone who scrolled up where they are).
  await page.evaluate(() => { const main = document.querySelector('#chatMain'); main.scrollTop = main.scrollHeight })
  await page.waitForTimeout(150)
  const answers = await page.locator('li.msg[data-role="assistant"]').count()
  await page.fill('#studyAskInput', 'What is second normal form?')
  await page.press('#studyAskInput', 'Enter')
  await page.waitForFunction((n) => document.querySelectorAll('li.msg[data-role="assistant"]').length > n, answers, { timeout: 30000 })
  await page.waitForTimeout(400)
  m = await measure()
  const tail = await page.evaluate(() => {
    const li = document.querySelector('#thread > li:last-child')
    const main = document.querySelector('#chatMain')
    const r = li.getBoundingClientRect()
    const c = main.getBoundingClientRect()
    return { role: li.dataset.role, top: Math.round(r.top), bottom: Math.round(r.bottom), mainTop: Math.round(c.top), mainBottom: Math.round(c.bottom), scrollTop: Math.round(main.scrollTop), scrollHeight: main.scrollHeight, clientHeight: main.clientHeight }
  })
  check('1280px: the new answer appears in the conversation beside the open panel, in full view', m.reach['#thread > li:last-child'] && m.chatMain.right <= m.dock.x, JSON.stringify(tail))
  await shot('1280-study-answered')
  await page.click('#studyClose')

  // ==== I. "Show in chat": the way from an answered card to its answer, whichever way the panel is placed ==================
  await size(800)
  await openStudy()
  const answeredBefore = await page.locator('li.msg[data-role="assistant"]').count()
  await page.fill('#studyAskInput', 'What is a foreign key?')
  await page.press('#studyAskInput', 'Enter')
  await page.waitForFunction((n) => document.querySelectorAll('li.msg[data-role="assistant"]').length > n, answeredBefore, { timeout: 30000 })
  await page.waitForFunction(() => document.querySelectorAll('#studyBody button.study-link').length >= 2, null, { timeout: 10000 })
  m = await measure()
  check('800px: the answer was written into the conversation behind the panel, and the panel is still there', m.visiblePanels.join() === 'studyPanel' && m.chatVisibility === 'hidden')
  check('800px: each answered card offers "Show in chat"', (await page.locator('#studyBody button.study-link').allTextContents()).every((t) => t.trim() === 'Show in chat'))
  await page.locator('#studyBody button.study-link').last().click()
  await page.waitForTimeout(250)
  m = await measure()
  const flashed = await page.locator('li.msg[data-flash="true"]').count()
  check('800px: "Show in chat" puts the panel away, shows the answer and outlines the exchange', m.dock === null && m.chatVisibility === 'visible' && m.reach['#thread > li:last-child'] && flashed === 2, `dock ${JSON.stringify(m.dock)}, flashed ${flashed}`)
  await shot('800-show-in-chat')
  await page.waitForTimeout(2000)
  check('the outline fades after a moment', (await page.locator('li.msg[data-flash="true"]').count()) === 0)

  await size(1280)
  await openStudy()
  await page.locator('#studyBody button.study-link').first().click() // the OLDER answer
  await page.waitForTimeout(250)
  const older = await page.evaluate(() => {
    const first = document.querySelector('li.msg[data-flash="true"]')
    const main = document.querySelector('#chatMain').getBoundingClientRect()
    const r = first?.getBoundingClientRect()
    return { open: !document.getElementById('studyPanel').hidden, inView: Boolean(r && r.top >= main.top - 2 && r.top < main.bottom), flashed: document.querySelectorAll('li.msg[data-flash="true"]').length }
  })
  check('1280px: "Show in chat" on an older answer scrolls to it and leaves the panel open beside it', older.open && older.inView && older.flashed === 2, JSON.stringify(older))
  await shot('1280-show-in-chat-older')
  await page.click('#studyClose')

  // ==== J. a study answer is always brought to the middle of the conversation when it arrives ===================================
  const where = () =>
    page.evaluate(() => {
      const main = document.querySelector('#chatMain')
      const li = [...document.querySelectorAll('#thread > li[data-role="assistant"]')].pop()
      const m = main.getBoundingClientRect()
      const r = li.getBoundingClientRect()
      return { fromMiddle: Math.round(r.top + r.height / 2 - (m.top + main.clientHeight / 2)), fromTop: Math.round(r.top - m.top), h: Math.round(r.height), view: main.clientHeight, scrollTop: Math.round(main.scrollTop), room: main.style.paddingBottom }
    })
  const askInStudy = async (text) => {
    const n = await page.locator('li.msg[data-role="assistant"]').count()
    await page.fill('#studyAskInput', text)
    await page.press('#studyAskInput', 'Enter')
    await page.waitForFunction((k) => document.querySelectorAll('li.msg[data-role="assistant"]').length > k, n, { timeout: 30000 })
    await page.waitForTimeout(400)
  }
  await size(1280)
  await openStudy()
  await page.evaluate(() => { document.querySelector('#chatMain').scrollTop = 0 }) // reading the start of an old conversation
  await page.waitForTimeout(150)
  await askInStudy('What is a primary key?')
  let w = await where()
  check('1280px: an answer that arrives while the person is reading far above is brought to the middle of the conversation', Math.abs(w.fromMiddle) <= 12, JSON.stringify(w))
  const sh = await page.evaluate(() => ({ top: document.querySelector('#chatMain').scrollTop }))
  check('1280px: it was a real jump (the person had been at the very top)', sh.top > 300, JSON.stringify(sh))
  await shot('1280-answer-centered')
  await askInStudy('What is a candidate key?')
  w = await where()
  check('1280px: the next answer is brought to the middle too', Math.abs(w.fromMiddle) <= 12, JSON.stringify(w))
  await askInStudy('Please give a LONGANSWER about keys')
  w = await where()
  check('1280px: an answer taller than the conversation starts at the top of it, to be read from its first line', w.h > w.view && w.fromTop >= 0 && w.fromTop <= 40, JSON.stringify(w))
  await shot('1280-answer-tall')
  await askInStudy('What is a foreign key again?')
  // a resize keeps the answer in the middle
  await size(1200)
  await page.waitForTimeout(300)
  w = await where()
  check('1200px: narrowing the window keeps the answer in the middle', Math.abs(w.fromMiddle) <= 12, JSON.stringify(w))
  // ...but a person who scrolled away is left where they are
  await page.mouse.move(500, 400) // over the conversation, and a real turn of the wheel (a script setting scrollTop is not the person)
  await page.mouse.wheel(0, -50000)
  await page.waitForTimeout(300)
  await size(1280)
  await page.waitForTimeout(300)
  w = await where()
  check('1280px: after the person scrolls away, resizing does not drag them back to the answer', w.scrollTop < 100, JSON.stringify(w))
  // an ordinary message gives the room back and follows the reply as before
  await askInStudy('Explain normal forms briefly') // centred, with room made under it
  await page.click('#studyClose')
  await page.waitForSelector('#studyPanel', { state: 'hidden' })
  await page.waitForFunction(() => !document.querySelector('#sendButton').hidden && document.querySelector('#assistantStateBadge')?.dataset.state === 'IDLE', null, { timeout: 15000 })
  const afterStudy = await page.locator('li.msg[data-role="assistant"]').count()
  await page.fill('#composerInput', 'And a short summary?')
  await page.click('#sendButton')
  await page.waitForFunction((n) => document.querySelectorAll('li.msg[data-role="assistant"]').length > n, afterStudy, { timeout: 30000 })
  await page.waitForTimeout(500)
  const follow = await page.evaluate(() => { const m = document.querySelector('#chatMain'); return { fromBottom: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight), room: m.style.paddingBottom } })
  check('an ordinary message after a centred answer is followed to the bottom, and the extra room is gone', follow.fromBottom <= 4 && follow.room === '', JSON.stringify(follow))

  // ==== K. a long answer is made wider and smaller so that it takes less height ============================================
  const fitInfo = () =>
    page.evaluate(() => {
      const li = [...document.querySelectorAll('#thread > li[data-role="assistant"]')].pop()
      const main = document.querySelector('#chatMain')
      const body = li.querySelector('.body')
      const fit = li.dataset.fit ?? ''
      const heightNow = li.getBoundingClientRect().height
      // what it would be as drawn without any fitting
      delete li.dataset.fit
      const heightNormal = li.getBoundingClientRect().height
      const widthNormal = li.getBoundingClientRect().width
      if (fit) li.dataset.fit = fit
      const m = main.getBoundingClientRect()
      const r = li.getBoundingClientRect()
      return { fit, fontPx: parseFloat(getComputedStyle(body).fontSize), width: Math.round(r.width), widthNormal: Math.round(widthNormal), height: Math.round(heightNow), heightNormal: Math.round(heightNormal), view: main.clientHeight, fromMiddle: Math.round(r.top + r.height / 2 - (m.top + main.clientHeight / 2)), fromTop: Math.round(r.top - m.top) }
    })
  await size(1600, 800)
  await openStudy()
  await askInStudy('What is a short answer?')
  let f = await fitInfo()
  check('1600px: a short answer is left as it is (normal text, the reading column)', f.fit === '' && f.fontPx === 16 && f.width <= 760, JSON.stringify(f))
  await askInStudy('Please give a WIDEANSWER about keys')
  f = await fitInfo()
  console.log('  (long answer, measured:', JSON.stringify(f), ')')
  check('1600px: a long answer uses more of the width than the reading column', f.fit !== '' && f.width > 760, JSON.stringify(f))
  check('1600px: and is shorter than it would have been as drawn', f.height < f.heightNormal, `${f.heightNormal}px -> ${f.height}px`)
  check('1600px: smaller type only when widening was not enough', f.fit === 'wide' ? f.fontPx === 16 : f.fontPx < 16 && f.fontPx >= 13, `${f.fit}, ${f.fontPx}px`)
  check('1600px: and then, if it fits the view, it is in the middle; if not, it starts at the top', f.height <= f.view - 32 ? Math.abs(f.fromMiddle) <= 12 : f.fromTop >= 0 && f.fromTop <= 40, JSON.stringify(f))
  await shot('1600-long-answer')
  await askInStudy('What is a candidate key?')
  f = await fitInfo()
  check('1600px: the next, short answer is back to normal text', f.fit === '' && f.fontPx === 16, JSON.stringify(f))
  await size(1200)
  await openStudy()
  await askInStudy('Please give a WIDEANSWER about keys')
  f = await fitInfo()
  check('1200px: a long answer is shortened here too, in the room the window has', f.fit !== '' && f.height <= f.heightNormal && f.fontPx >= 13, JSON.stringify(f))
  await size(1280)
  await page.waitForTimeout(250)

  // narrow: the answer is written behind the panel, and is in the middle when the panel is put away
  await size(800)
  await openStudy()
  await page.evaluate(() => { document.querySelector('#chatMain').scrollTop = 0 })
  await askInStudy('What is a surrogate key?')
  m = await measure()
  check('800px: the answer arrived behind the panel, which is still open', m.visiblePanels.join() === 'studyPanel' && m.chatVisibility === 'hidden')
  await page.click('#studyButton')
  await page.waitForSelector('#studyPanel', { state: 'hidden' })
  await page.waitForTimeout(300)
  w = await where()
  check('800px: put the panel away and the answer is in the middle of the conversation', Math.abs(w.fromMiddle) <= 12, JSON.stringify(w))
  await shot('800-answer-centered')
  await openStudy()
  await page.locator('#studyBody button.study-link').first().click() // an older answer
  await page.waitForTimeout(250)
  const older2 = await page.evaluate(() => {
    const flashed = [...document.querySelectorAll('li.msg[data-flash="true"]')].find((li) => li.dataset.role === 'assistant')
    const main = document.querySelector('#chatMain')
    const m = main.getBoundingClientRect()
    const r = flashed.getBoundingClientRect()
    return Math.round(r.top + r.height / 2 - (m.top + main.clientHeight / 2))
  })
  check('800px: "Show in chat" on an older answer also brings it to the middle', Math.abs(older2) <= 12, `${older2}px from the middle`)

  check('no errors on the page the whole time', problems.length === 0, problems.slice(0, 4).join(' | '))
  await context.close()
} finally {
  await browser.close()
  await stack.close()
  model.close()
}
finish()
