// The Smart Screenshot evaluation corpus: eight screens a student really has in front of them, one per kind of question, rendered in a real
// browser at the size the desktop app sends (1600 px on the long side, JPEG quality 80). Each has what a correct answer must contain, so the
// run can say "correct" or "not correct" without anyone reading the answers.
//
//   expect: every pattern must appear in the answer text      forbid: none may appear
//   parts:  how many separately labelled answers a multi-part screen should give

import { createRequire } from 'node:module'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(process.env.PLAYWRIGHT_FROM || '/srv/projects/ZEDFOOTBALL/frontend/package.json')

const FRAME = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2430;background:#f4f5f7;width:1600px;height:900px;overflow:hidden}
.top{height:38px;background:#dde1e8;display:flex;align-items:flex-end;padding:0 10px;border-bottom:1px solid #b9bfca;font-size:13px}
.tab{padding:8px 18px;background:#f4f5f7;border-radius:8px 8px 0 0}
.bar{height:34px;background:#f4f5f7;border-bottom:1px solid #d3d7de;display:flex;align-items:center;padding:0 12px;font-size:13px;color:#555}
.sheet{width:1000px;margin:0 auto;padding:30px 44px;background:#fff;min-height:828px;box-shadow:0 0 0 1px #e1e4ea}
h1{font-size:26px;margin:4px 0 18px}.meta{font-size:15px;color:#555;margin:0 0 16px}
p{font-size:20px;line-height:32px;margin:0 0 16px}.opt{font-size:20px;line-height:32px;margin:2px 0 2px 24px}.marks{float:right;font-size:16px;color:#555}
.task{position:absolute;left:0;right:0;bottom:0;height:36px;background:#1d2330;color:#dfe4ee;display:flex;align-items:center;justify-content:space-between;padding:0 14px;font-size:13px}
.case{background:#f6f7fb;border-left:4px solid #4a62c4;padding:12px 18px;margin:0 0 18px}
</style></head><body><div class="top"><div class="tab">${title}</div></div><div class="bar">https://learn.example.edu/course/quiz</div><div class="sheet">${body}</div><div class="task"><span>Start</span><span>10:42</span></div></body></html>`

export const SCENARIOS = [
  {
    name: 'define',
    kind: 'definition',
    html: FRAME('Economics quiz', '<h1>Economics 101 · Quiz 2</h1><p class="meta">Answer all questions.</p><p><b>Question 1.</b> Define “opportunity cost”. <span class="marks">(2 marks)</span></p>'),
    expect: [/(next|best)[^.]{0,40}(alternative|option|choice)|forg[oe]ne|gives? up|given up/i],
    forbid: [/in conclusion/i]
  },
  {
    name: 'mcq',
    kind: 'multiple choice',
    html: FRAME('Physics practice', '<h1>Physics practice · Set 3</h1><p><b>Question 4.</b> A car travels 150 km in 2.5 hours. What is its average speed?</p><div class="opt">A) 40 km/h</div><div class="opt">B) 60 km/h</div><div class="opt">C) 75 km/h</div><div class="opt">D) 100 km/h</div>'),
    expect: [/\bB\b/, /60/],
    forbid: [/\b(A\)|C\)|D\)).{0,40}(wrong|incorrect)/i]
  },
  {
    name: 'calculate',
    kind: 'calculation',
    html: FRAME('Finance homework', '<h1>Finance · Homework 5</h1><p><b>Question 2.</b> A loan of $2,000 earns simple interest at 5% per year for 3 years. Calculate the total interest earned. <span class="marks">(3 marks)</span></p>'),
    expect: [/\$?\s?300\b/]
  },
  {
    name: 'list',
    kind: 'list',
    html: FRAME('Economics quiz', '<h1>Economics 101 · Quiz 2</h1><p><b>Question 3.</b> List four functions of money.</p>'),
    expect: [/medium of exchange/i, /store of value/i, /(unit of account|measure of value)/i, /(standard of deferred payment|deferred payment|standard for)/i]
  },
  {
    name: 'compare',
    kind: 'comparison',
    html: FRAME('Networks exam prep', '<h1>Computer Networks · Revision</h1><p><b>Question 5.</b> Compare TCP and UDP. <span class="marks">(4 marks)</span></p>'),
    expect: [/reliab/i, /(connection|handshake)/i, /(speed|faster|overhead|latency|lightweight)/i]
  },
  {
    name: 'evaluate',
    kind: 'discussion / evaluation',
    html: FRAME('Economics essay', '<h1>Economics · Essay question</h1><p><b>Question 6.</b> Evaluate the effectiveness of rent control as a policy to make housing affordable. <span class="marks">(6 marks)</span></p>'),
    expect: [/(shortage|supply|quality|black market|reduc)/i, /(however|but|although|on the other hand|while|drawback|benefit)/i]
  },
  {
    name: 'case',
    kind: 'case study',
    html: FRAME('Business case', '<h1>Business Studies · Case study</h1><div class="case"><p>Maple Bakery sells bread and cakes in a small town. Over the last year its flour and energy costs rose 20%, while sales stayed the same because a supermarket opened nearby selling cheaper bread. The owner, Ana, has not changed her prices in three years and is now making a small loss each month.</p></div><p><b>Question 7.</b> Advise Ana on two actions she could take to return the bakery to profit. <span class="marks">(4 marks)</span></p>'),
    expect: [/(price|pric)/i, /(cost|supplier|waste|menu|product|premium|special|local|quality|loyal)/i]
  },
  {
    name: 'multipart',
    kind: 'multi-part',
    parts: 3,
    html: FRAME('Economics test', '<h1>Economics · Test 1</h1><p><b>Question 8.</b></p><p>(a) Define inflation. <span class="marks">(2)</span></p><p>(b) Prices in an economy rose from 200 to 210 over one year. Calculate the rate of inflation. <span class="marks">(2)</span></p><p>(c) State one way inflation can hurt people who save money. <span class="marks">(2)</span></p>'),
    expect: [/(general|overall)[^.]{0,30}(rise|increase)|rise in (the )?(general )?price/i, /\b5\s?%|5 percent|five percent/i, /(value|purchasing power|worth)/i]
  }
]

/** Renders every scenario to a JPEG (cached in `dir`) and returns [{ ...scenario, jpeg: Buffer, renderMs }]. */
export async function renderCorpus(dir) {
  mkdirSync(dir, { recursive: true })
  const missing = SCENARIOS.filter((s) => !existsSync(path.join(dir, `${s.name}.jpg`)))
  if (missing.length) {
    const { chromium } = require('playwright')
    const browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    for (const s of missing) {
      await page.setContent(s.html)
      writeFileSync(path.join(dir, `${s.name}.jpg`), await page.screenshot({ type: 'jpeg', quality: 80 }))
    }
    await browser.close()
  }
  return SCENARIOS.map((s) => ({ ...s, jpeg: readFileSync(path.join(dir, `${s.name}.jpg`)) }))
}
