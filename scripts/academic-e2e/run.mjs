// Real-browser check of the Study panel (Academic Intelligence) against the REAL NUMZ AI server in per-person sign-in mode and the REAL
// numzlab-auth broker (pretend Google). NOT part of `npm test`: it needs Playwright, Chromium and numzlab-auth's test rig. No Docker, no
// Caddy: the page and the API come straight from the app on a spare port, under /ai/ like the real site. Only the paid text model is
// pretended (a small stand-in that answers from the course source it is shown, and says so).
//
//   node scripts/academic-e2e/run.mjs            screenshots go to ACADEMIC_E2E_DIR (default: a temp folder, printed)
//
// What it cannot show: the screen watcher (that is the desktop app's: see desktop/e2e), and a real model.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, reporter, repo } from '../camera-e2e/lib.mjs'
import { startStack } from '../../tests/helpers/aiRig.js'

const dir = process.env.ACADEMIC_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'numz-academic-e2e-'))
fs.mkdirSync(dir, { recursive: true })
console.log('working in', dir)
console.log('building NUMZ AI for /ai/ ...')
execFileSync('npx', ['vite', 'build'], { cwd: repo, env: { ...process.env, VITE_PUBLIC_BASE: '/ai/' }, stdio: 'ignore' })
execFileSync('node', ['scripts/precompress.js', 'dist'], { cwd: repo, stdio: 'ignore' })

// ---- the pretend model: answers from the numbered source it was shown, in plain words --------------------------------
const seen = { prompts: [] }
const model = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* ignore */
    }
    const flat = JSON.stringify(body.messages ?? [])
    seen.prompts.push(flat)
    const grounded = flat.includes('source id=\\"S1\\"') || flat.includes('<source id=')
    const review = flat.includes("You check a student's draft answer")
    const parts = /THIS QUESTION HAS 3 PARTS/.test(flat)
    const reply = review
      ? 'OK'
      : parts
        ? '#### ANSWER (a)\nInflation is a general rise in prices.\n\n#### ANSWER (b)\n**5%**\n\n- (210 - 200) / 200 x 100\n\n#### ANSWER (c)\nSavings buy less over time.'
        : grounded
          ? 'Second normal form means every non-key column depends on the **whole** key, not just part of it [S1]. For example, in an order line keyed by (order, product), the product name belongs in a product table.'
          : 'Second normal form removes partial dependencies on a composite key. That is general knowledge, not from your course materials.'
    if (body.stream === true) {
      // the words arrive a few at a time, slowly enough for the page to be seen drawing them
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const pieces = reply.match(/\S+\s*/g) ?? [reply]
      let i = 0
      const send = () => {
        if (i < pieces.length) {
          res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [{ delta: { content: pieces[i++] } }] })}\n\n`)
          setTimeout(send, parts ? 90 : 5)
        } else {
          res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [], usage: { prompt_tokens: 200, completion_tokens: 60 } })}\n\n`)
          res.end('data: [DONE]\n\n')
        }
      }
      return send()
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { role: 'assistant', content: reply } }], usage: { prompt_tokens: 200, completion_tokens: 60 } }))
  })
})
await new Promise((r) => model.listen(0, '127.0.0.1', r))
const modelUrl = `http://127.0.0.1:${model.address().port}`

const { check, finish } = reporter()
const problems = []
const stack = await startStack({ env: { AI_BASE_URL: `${modelUrl}/v1`, ACADEMIC_RESEARCH: 'off', ACADEMIC_ASYNC_THRESHOLD_KB: '1' } })
const base = stack.app.base
const nl = (route, body) => stack.numzlab.control(route, body)
const browser = await chromium.launch()

function watch(page, label) {
  page.on('console', (m) => {
    const text = m.text()
    if (!['error', 'warning'].includes(m.type())) return
    if (/401|403|429|503|Failed to load resource/.test(text)) return
    if (/Sign in to use NUMZ AI/.test(text)) return
    if (/TypeError: Failed to fetch/.test(text)) return
    problems.push(`${label} ${m.type()}: ${text.slice(0, 160)}`)
  })
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message.slice(0, 160)}`))
}

async function person(email, role = 'operator') {
  await nl('invite', { email, role })
  await nl('google', { email, sub: `sub-${email}`, name: email.split('@')[0] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  watch(page, email.split('@')[0])
  await page.goto(`${base}/`, { waitUntil: 'load' })
  await page.waitForSelector('#accessGoogleButton', { state: 'visible', timeout: 15000 })
  await Promise.all([page.waitForURL((u) => u.pathname === '/ai/' && !u.search, { timeout: 20000 }), page.click('#accessGoogleButton')])
  await page.waitForSelector('#accessGate', { state: 'hidden', timeout: 15000 })
  await page.waitForLoadState('networkidle')
  return { context, page }
}

const NOTES = `# Normalisation

Second normal form (2NF) requires that every non-key attribute depends on the whole of the primary key, not on only part of it.
A table is in 2NF when it is in first normal form and has no partial dependencies on a composite key.

## Example

In an order line keyed by order number and product number, the product name depends only on the product number, so it is moved to its own product table.
`

try {
  // ============ A. a person studies ================================================================================
  const ada = await person('ada@example.com')
  const page = ada.page
  const open = async () => {
    if (await page.isHidden('#studyPanel')) await page.click('#studyButton')
    await page.waitForSelector('#studyPanel', { state: 'visible' })
  }
  check('the Study button is in the header', await page.isVisible('#studyButton'))
  check('the panel starts closed', await page.isHidden('#studyPanel'))
  await open()
  check('it opens with the indicator saying no session', (await page.textContent('#studyIndicator')).trim() === 'No session')
  check('in a browser, screen reading is not offered and says why', (await page.isDisabled('#studyBody input[type=checkbox]')) && /desktop app/i.test(await page.textContent('#studyBody .study-note')))
  await page.screenshot({ path: `${dir}/shot-1-start.png` })

  // ---- materials ----
  await page.click('[data-study-tab="materials"]')
  check('materials start with no courses', /Add a course/.test(await page.textContent('#studyBody')))
  await page.fill('input[name="title"]', 'Database Systems')
  await page.click('button:has-text("Add course")')
  await page.waitForSelector('.study-upload input[type=file]', { timeout: 10000 })
  check('adding a course shows it and the upload control', /Added the course Database Systems/.test(await page.textContent('#studyBody')))
  await page.setInputFiles('.study-upload input[type=file]', { name: 'normalisation.md', mimeType: 'text/markdown', buffer: Buffer.from(NOTES) })
  await page.waitForSelector('.study-docs li', { timeout: 10000 })
  check('a markdown file is added and listed with its parts', /normalisation · lecture notes · v1 · \d+ parts/.test(await page.textContent('.study-docs li')))
  await page.setInputFiles('.study-upload input[type=file]', { name: 'slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') })
  await page.waitForFunction(() => /only text and markdown/i.test(document.getElementById('studyBody').textContent))
  check('a PDF is refused with the reason (text and markdown only)', true)
  check('the refused file added nothing', (await page.locator('.study-docs li').count()) === 1)

  // ---- several files at once, a large one in the background, and a full batch ----
  const upload = (files) => page.setInputFiles('.study-upload input[type=file]', files)
  const file = (name, text) => ({ name, mimeType: name.endsWith('.md') ? 'text/markdown' : 'text/plain', buffer: Buffer.from(text) })
  check('the page says what it accepts: the size and the number of files', /Up to 100 MB each and 50 files at a time/.test(await page.textContent('#studyBody .study-note')))
  check('the file box takes several files', (await page.getAttribute('.study-upload input[type=file]', 'multiple')) !== null)
  await upload([file('week2.md', '# Week 2\n\nTransactions are atomic, consistent, isolated and durable.'), file('week3.txt', 'Indexes make lookups fast.'), { name: 'slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') }])
  await page.waitForFunction(() => /Added 2 of 3 files/.test(document.getElementById('studyBody').textContent), null, { timeout: 15000 })
  const batchMessage = await page.textContent('#studyBody .study-note:last-of-type')
  check('three files at once: two are added and the one that is not says which and why', /Added 2 of 3 files\. Not added: slides\.pdf: only text and markdown/.test(batchMessage), batchMessage.slice(0, 160))
  check('and the two are listed with their parts', (await page.locator('.study-docs li').count()) === 3)

  const bigNotes = Array.from({ length: 400 }, (_, i) => `## Topic ${i}\n\nTopic ${i} covers relational design number ${i} and its bigtopicmarker${i}q. Keys, joins and indexes are explained here in some detail.`).join('\n\n')
  await upload([file('textbook.md', bigNotes)])
  await page.waitForFunction(() => /Added textbook\.md\./.test(document.getElementById('studyBody').textContent), null, { timeout: 30000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.study-docs li')].some((li) => /textbook/.test(li.textContent) && /· \d{2,} parts$/.test(li.textContent.replace(/Retry|Delete/g, '').trim())), null, { timeout: 30000 })
  const bigRow = (await page.locator('.study-docs li', { hasText: 'textbook' }).textContent()).replace(/Delete|Retry/g, '')
  check('a large file is accepted at once and ends ready in the list, with its parts, with no one waiting on the upload', /textbook · lecture notes · v1 · \d{2,} parts$/.test(bigRow), bigRow)
  const found = await page.evaluate(async (id) => (await (await fetch(`/ai/api/v1/assistant/academic/search?course=${id}&q=bigtopicmarker321q`, { credentials: 'same-origin' })).json()).passages?.[0]?.title, (await page.evaluate(async () => (await (await fetch('/ai/api/v1/assistant/academic/courses', { credentials: 'same-origin' })).json()).courses[0].id)))
  check('and it is searchable once ready, found by its own words', found === 'textbook', String(found))

  const many = Array.from({ length: 55 }, (_, i) => file(`lec-${String(i).padStart(2, '0')}.txt`, `Lecture ${i} is about uniquelectureword${i}.`))
  await upload(many)
  await page.waitForFunction(() => /Added 50 of 50 files/.test(document.getElementById('studyBody').textContent), null, { timeout: 60000 })
  const manyMessage = await page.textContent('#studyBody .study-note:last-of-type')
  check('a batch of 55 files: 50 are added and the 5 left out are said to be, with the reason', /Added 50 of 50 files\. 5 more were left out: 50 files at a time\./.test(manyMessage), manyMessage.slice(0, 200))
  check('all fifty are listed (with the earlier four)', (await page.locator('.study-docs li').count()) === 54)
  await page.screenshot({ path: `${dir}/shot-2b-batch.png` })
  // put the course back as the rest of the run expects it (one document)
  await page.evaluate(async () => {
    const api = '/ai/api/v1/assistant/academic'
    const course = (await (await fetch(`${api}/courses`, { credentials: 'same-origin' })).json()).courses[0]
    const docs = (await (await fetch(`${api}/courses/${course.id}/documents`, { credentials: 'same-origin' })).json()).documents
    for (const d of docs.filter((d) => d.title !== 'normalisation')) await fetch(`${api}/documents/${d.id}`, { method: 'DELETE', credentials: 'same-origin' })
  })
  await page.click('[data-study-tab="memory"]')
  await page.click('[data-study-tab="materials"]')
  await page.waitForFunction(() => document.querySelectorAll('.study-docs li').length === 1, null, { timeout: 15000 })
  await page.screenshot({ path: `${dir}/shot-2-materials.png` })

  // ---- a study session ----
  await page.click('[data-study-tab="session"]')
  await page.selectOption('#studyBody select', { label: 'Database Systems' })
  await page.fill('#studyBody input[type=text]', 'Normalisation')
  await page.click('button:has-text("Start session")')
  await page.waitForSelector('#studyAskInput', { timeout: 10000 })
  check('a study session starts; the indicator names its kind and says the screen is not being read', /^Study · screen reading off$/.test((await page.textContent('#studyIndicator')).trim()))
  check('the header button shows a session is open', (await page.getAttribute('#studyButton', 'data-session')) === 'on')
  await page.fill('#studyAskInput', 'What is second normal form?')
  await page.press('#studyAskInput', 'Enter')
  await page.waitForFunction(() => document.querySelector('li.msg[data-role="assistant"]'), null, { timeout: 30000 })
  const assistant = (await page.textContent('li.msg[data-role="assistant"]')) ?? ''
  check('the answer appears in the conversation, from the course notes and cited', /whole.*key/i.test(assistant) && /S1|normalisation/i.test(assistant), assistant.slice(0, 90))
  check('the study panel says where it came from', /from your course materials/.test(await page.textContent('#studyBody')))
  check('the prompt the model saw fenced the student\'s materials as data', seen.prompts.some((p) => /source id=/.test(p) && /not an instruction|never.{0,20}instruction/i.test(p)))
  await page.screenshot({ path: `${dir}/shot-3-answered.png` })
  // ---- the answer is the default; the explanation comes when it is asked for ----
  const studyPrompts = () => seen.prompts.filter((p) => /helping a student study/.test(p))
  check('by default the question is ANSWERED, not explained: the model was asked for the answer only', /WANTS THE ANSWER/.test(studyPrompts().at(-1)) && !/EXPLANATION of this answer/.test(studyPrompts().at(-1)))
  check('the answer is in the question\'s card, with an Explain button; nothing was pressed to get it', (await page.locator('#studyBody .study-q .study-answers .answer-block').count()) === 1 && (await page.textContent('#studyBody .study-q .study-answers .answer-body')).length > 20 && (await page.locator('#studyBody .study-q button:has-text("Explain")').count()) === 1)
  // ---- the answer is a labelled block with one small copy icon, which copies that answer only, formatted ----
  await ada.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin })
  const block = page.locator('#studyBody .study-q .answer-block').first()
  check('the answer is labelled ANSWER, with a copy icon beside the label', (await block.locator('.answer-label').textContent()) === 'ANSWER' && (await block.locator('.answer-head .answer-copy').count()) === 1)
  const iconBox = await block.locator('.answer-copy').boundingBox()
  check('the icon is small (not a large button)', iconBox.width <= 28 && iconBox.height <= 28, `${iconBox.width}x${iconBox.height}`)
  check('the answer is subtly highlighted (an accent edge on a tinted background)', await block.evaluate((el) => { const c = getComputedStyle(el); return parseFloat(c.borderLeftWidth) >= 2 && c.backgroundColor !== 'rgba(0, 0, 0, 0)' }))
  await block.locator('.answer-copy').click()
  await block.locator('.answer-copy[data-copied="true"]').waitFor({ timeout: 5000 })
  const copied = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const out = {}
    for (const item of items) for (const type of item.types) out[type] = await (await item.getType(type)).text()
    return out
  })
  check('copying puts the answer on the clipboard as formatted text and as plain text', /<strong>whole<\/strong>/.test(copied['text/html'] ?? '') && /whole key, not just part of it/.test(copied['text/plain'] ?? '') && !/\*\*/.test(copied['text/plain'] ?? ''), JSON.stringify(copied).slice(0, 160))
  check('what is copied is the answer only: no label, no buttons', !/ANSWER|Copy/.test(copied['text/plain'] ?? '') && !/answer-copy|answer-label/.test(copied['text/html'] ?? ''))
  check('the icon says it copied', (await block.locator('.answer-copy').getAttribute('data-copied')) === 'true' && (await block.locator('.answer-state').textContent()) === 'Copied')
  check('the same answer, in the conversation, is a block with its own copy icon', (await page.locator('li.msg[data-role="assistant"] .answer-block .answer-copy').count()) >= 1)
  const beforeExplain = await page.locator('li.msg[data-role="assistant"]').count()
  await page.click('#studyBody .study-q button:has-text("Explain")')
  await page.waitForFunction((n) => document.querySelectorAll('li.msg[data-role="assistant"]').length > n, beforeExplain, { timeout: 30000 })
  check('pressing Explain gets the explanation: the model is now asked to explain it, and the button goes', /EXPLANATION of this answer/.test(studyPrompts().at(-1)) && !/WANTS THE ANSWER/.test(studyPrompts().at(-1)) && (await page.locator('#studyBody .study-q button:has-text("Explain")').count()) === 0)
  await page.screenshot({ path: `${dir}/shot-3b-explained.png` })
  await page.click('button:has-text("Helped")')
  await page.waitForFunction(() => /remember/i.test(document.querySelector('.study-message')?.textContent ?? ''), null, { timeout: 10000 })
  check('"Helped" is acknowledged and remembered', true)
  await page.click('button:has-text("Simpler")')
  await page.waitForFunction(() => document.querySelectorAll('li.msg[data-role="assistant"]').length >= 2, null, { timeout: 30000 })
  check('"Simpler" asks the same question again as a new answer', true)
  // ---- a multi-part question: written part by part, shown as it arrives, each part its own block that copies on its own ----
  await page.waitForFunction(() => document.querySelectorAll('#studyBody [data-live]').length === 0, null, { timeout: 30000 }) // the answer to "Simpler" has been written
  await page.fill('#studyAskInput', '(a) Define inflation. (b) Calculate the rate of inflation if prices rose from 200 to 210. (c) State one way inflation hurts savers.')
  await page.press('#studyAskInput', 'Enter')
  await page.waitForFunction(() => document.querySelector('#studyBody .study-q:last-child [data-live] .answer-block[data-pending="writing"] .answer-body')?.textContent.trim().length > 0, null, { timeout: 15000 })
  const shownWhileWriting = await page.evaluate(() => ({ text: document.querySelector('#studyBody .study-q:last-child [data-live] .answer-body')?.textContent ?? '', copy: document.querySelectorAll('#studyBody .study-q:last-child [data-live] .answer-copy').length, state: document.querySelector('#studyBody .study-q:last-child [data-live] .answer-state')?.textContent }))
  check('the words appear while the answer is still being written, marked as such, with no copy icon yet', shownWhileWriting.text.length > 0 && /Inflation|ANSWER|general/.test(shownWhileWriting.text) && shownWhileWriting.copy === 0 && /writing/.test(shownWhileWriting.state ?? ''), JSON.stringify(shownWhileWriting).slice(0, 120))
  await page.waitForFunction(() => document.querySelectorAll('#studyBody .study-q .answer-block .answer-copy').length >= 4, null, { timeout: 30000 })
  const labels = await page.locator('#studyBody .study-q:last-child .answer-label').allTextContents()
  check('the answer has one labelled block per part, each with its own copy icon', JSON.stringify(labels) === JSON.stringify(['ANSWER (a)', 'ANSWER (b)', 'ANSWER (c)']) && (await page.locator('#studyBody .study-q:last-child .answer-copy').count()) === 3, labels.join(' | '))
  check('a complex question was read a second time before it was final: the model was asked to check the draft', seen.prompts.some((p) => p.includes("You check a student's draft answer") && p.includes('ANSWER (b)')))
  await page.locator('#studyBody .study-q:last-child .answer-block').nth(1).locator('.answer-copy').click()
  await page.waitForSelector('#studyBody .study-q:last-child .answer-block:nth-of-type(2) .answer-copy[data-copied="true"]', { timeout: 5000 })
  const partB = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const out = {}
    for (const item of items) for (const type of item.types) out[type] = await (await item.getType(type)).text()
    return out
  })
  check('copying part (b) copies part (b) only, with its list and bold kept in the formatted version', /5%/.test(partB['text/plain']) && !/Inflation is|Savings buy/.test(partB['text/plain']) && /<strong>5%<\/strong>/.test(partB['text/html']) && /<li>/.test(partB['text/html']), JSON.stringify(partB).slice(0, 200))
  await page.screenshot({ path: `${dir}/shot-3c-parts.png` })
  // ---- on a phone-width screen ----
  await page.setViewportSize({ width: 375, height: 812 })
  await page.waitForTimeout(400)
  const phone = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('#studyBody .study-q:last-child .answer-block')]
    const icon = blocks[0].querySelector('.answer-copy').getBoundingClientRect()
    const reach = document.elementFromPoint(icon.left - 7, icon.top + icon.height / 2)
    const page = document.documentElement
    return { sideways: page.scrollWidth - page.clientWidth, blocks: blocks.length, inside: blocks.every((b) => b.getBoundingClientRect().right <= innerWidth + 1 && b.getBoundingClientRect().left >= -1), touch: Boolean(reach?.closest('.answer-copy')), icon: Math.round(icon.width) }
  })
  check('on a phone-width screen the answer blocks fit, the page does not scroll sideways, and the small copy icon has a larger touch area', phone.sideways <= 1 && phone.blocks === 3 && phone.inside && phone.touch && phone.icon <= 28, JSON.stringify(phone))
  await page.screenshot({ path: `${dir}/shot-3d-phone.png` })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(200)

  await page.click('button:has-text("Pause")')
  await page.waitForSelector('button:has-text("Resume")')
  check('Pause is shown, and asking is disabled while paused', /paused/.test(await page.textContent('#studyIndicator')) && (await page.isDisabled('#studyAskInput')))
  await page.click('button:has-text("Resume")')
  await page.waitForSelector('button:has-text("Pause")')
  await page.click('button:has-text("End session")')
  await page.waitForSelector('button:has-text("Start session")')
  check('ending the session returns to the start form and the indicator', (await page.textContent('#studyIndicator')).trim() === 'No session' && (await page.getAttribute('#studyButton', 'data-session')) === 'off')

  // ---- answering by itself can be switched on after a session started (screen reading turned on later leaves it off) ----
  const academic = '/ai/api/v1/assistant/academic'
  await page.evaluate(async (b) => {
    const r = await fetch(`${b}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'study', captureEnabled: true, autoAnswer: false }) })
    if (!r.ok) throw new Error(`start ${r.status}`)
  }, academic)
  await page.reload({ waitUntil: 'load' })
  await open()
  await page.click('[data-study-tab="session"]')
  await page.waitForSelector('#studyAutoAnswer', { timeout: 10000 })
  const currentSession = () => page.evaluate(async (b) => (await (await fetch(`${b}/sessions/current`)).json()).session, academic)
  check('a session with screen reading on and answering by itself off shows the switch, unchecked', (await page.isVisible('#studyAutoAnswer')) && !(await page.isChecked('#studyAutoAnswer input')) && (await currentSession()).autoAnswer === false)
  await page.check('#studyAutoAnswer input')
  await page.waitForFunction(async (b) => (await (await fetch(`${b}/sessions/current`)).json()).session?.autoAnswer === true, academic, { timeout: 10000 })
  check('switching it on is saved on the server and the switch stays on', (await (await currentSession()).autoAnswer) === true && (await page.isChecked('#studyAutoAnswer input')))
  await page.uncheck('#studyAutoAnswer input')
  await page.waitForFunction(async (b) => (await (await fetch(`${b}/sessions/current`)).json()).session?.autoAnswer === false, academic, { timeout: 10000 })
  check('and it can be switched off again', !(await page.isChecked('#studyAutoAnswer input')))
  await page.click('button:has-text("End session")')
  await page.waitForSelector('button:has-text("Start session")')

  // ---- a restricted session ----
  await page.check('input[value="restricted"]')
  check('restricted turns screen reading off and unavailable', await page.isDisabled('#studyBody input[type=checkbox]'))
  await page.click('button:has-text("Start session")')
  await page.waitForSelector('#studyAskInput', { timeout: 10000 })
  check('a restricted session says plainly that it will not answer or read', /not reading your screen/.test(await page.textContent('#studyBody')))
  check('its box is for concepts only', (await page.getAttribute('#studyAskInput', 'placeholder')).startsWith('Name a concept'))
  const before = await page.locator('li.msg[data-role="assistant"]').count()
  await page.fill('#studyAskInput', 'Question 3. Calculate the normal form of the following relation and justify each step in full?')
  await page.press('#studyAskInput', 'Enter')
  await page.waitForTimeout(1500)
  check('a pasted exam question is refused in a restricted session and nothing is added', (await page.locator('li.msg[data-role="assistant"]').count()) === before, (await page.textContent('.study-message')).slice(0, 100))
  await page.fill('#studyAskInput', 'second normal form')
  await page.press('#studyAskInput', 'Enter')
  await page.waitForFunction((n) => document.querySelectorAll('li.msg[data-role="assistant"]').length > n, before, { timeout: 30000 })
  check('a named concept is explained in general terms', true)
  await page.screenshot({ path: `${dir}/shot-4-restricted.png` })
  await page.click('button:has-text("End session")')
  await page.waitForSelector('button:has-text("Start session")')

  // ---- memory ----
  await page.click('[data-study-tab="memory"]')
  await page.waitForSelector('.study-lane', { timeout: 10000 })
  const memoryText = await page.textContent('#studyBody')
  check('the Memory tab shows the course, the material and what it learned', /Database Systems/.test(memoryText) && /1 document/.test(memoryText))
  await page.screenshot({ path: `${dir}/shot-5-memory.png` })
  check('the export link is offered', (await page.locator('a[download]').count()) === 1)
  const forgets = page.locator('button:has-text("Forget")')
  if ((await forgets.count()) > 0) {
    const n = await forgets.count()
    await forgets.first().click()
    // the list is read again from the server after the click: give it time on a busy machine instead of a fixed 800 ms
    await page.waitForFunction((count) => document.querySelectorAll('.study-lane button').length > 0 && ([...document.querySelectorAll('.study-lane button')].filter((b) => /Forget/.test(b.textContent)).length < count || /Nothing yet/.test(document.getElementById('studyBody').textContent)), n, { timeout: 8000 }).catch(() => {})
    const after = await page.locator('.study-lane button:has-text("Forget")').count()
    check('one learned item can be forgotten', after < n || /Nothing yet/.test(await page.textContent('#studyBody')), `before ${n}, after ${after}`)
  } else {
    check('(no learned item to forget: helpful feedback alone is not yet a lesson)', true)
  }
  const ownRes = await page.evaluate(async () => (await fetch('/ai/api/v1/assistant/academic/courses', { credentials: 'same-origin' })).json())
  check('the API shows her course', ownRes.courses?.length === 1)

  // ============ B. a second person sees none of it ===============================================================
  const bob = await person('bob@example.com')
  const theirs = await bob.page.evaluate(async () => (await fetch('/ai/api/v1/assistant/academic/courses', { credentials: 'same-origin' })).json())
  check('a second person has no courses (nothing of hers is visible)', Array.isArray(theirs.courses) && theirs.courses.length === 0)
  const theirDoc = await bob.page.evaluate(async (id) => (await fetch(`/ai/api/v1/assistant/academic/courses/${id}/documents`, { credentials: 'same-origin' })).status, ownRes.courses[0].id)
  check('and her course id gives them nothing (404)', theirDoc === 404, `status ${theirDoc}`)
  await bob.context.close()

  // ============ C. delete everything ============================================================================
  page.on('dialog', (d) => d.accept())
  await page.click('button:has-text("Delete everything academic")')
  await page.waitForFunction(() => /deleted/i.test(document.getElementById('studyBody').textContent), null, { timeout: 10000 })
  const gone = await page.evaluate(async () => (await fetch('/ai/api/v1/assistant/academic/courses', { credentials: 'same-origin' })).json())
  check('"Delete everything academic" removes the courses and materials', gone.courses.length === 0)

  // ============ D. phone width ===================================================================================
  await page.setViewportSize({ width: 390, height: 800 })
  await page.click('[data-study-tab="session"]')
  const box = await page.locator('#studyPanel').boundingBox()
  check('on a phone the panel fits the screen with no sideways scroll', box.width <= 390 && (await page.evaluate(() => document.getElementById('studyBody').scrollWidth <= document.getElementById('studyBody').clientWidth + 1)))
  await page.screenshot({ path: `${dir}/shot-6-phone.png` })
  await page.keyboard.press('Escape')
  check('Escape closes the panel', await page.isHidden('#studyPanel'))
  await ada.context.close()

  check('no unexpected console errors or page errors', problems.length === 0, problems.slice(0, 4).join(' | '))
} catch (err) {
  console.error(err)
  check('the run finished without an exception', false, String(err?.message ?? err).slice(0, 300))
} finally {
  await browser.close()
  await stack.close()
  await new Promise((r) => model.close(r))
}
console.log('screenshots in', dir)
process.exit(finish() ? 0 : 1)
