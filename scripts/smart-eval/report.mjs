// Turns two runs of run.mjs (before.json, after.json) into the comparison tables of docs/smart-screenshot.md.
//
//   node scripts/smart-eval/report.mjs docs/smart-screenshot/before.json docs/smart-screenshot/after.json
import { readFileSync } from 'node:fs'

const [beforeFile, afterFile] = process.argv.slice(2)
const before = JSON.parse(readFileSync(beforeFile, 'utf8'))
const after = JSON.parse(readFileSync(afterFile, 'utf8'))
const s = (n) => (n === null || n === undefined ? '–' : (n / 1000).toFixed(1))
const change = (a, b) => (a && b ? `${b < a ? '−' : '+'}${Math.abs(Math.round(((b - a) / a) * 100))}%` : '–')

console.log(`Measured ${after.at.slice(0, 10)} on ${after.model} (answers) and ${after.vision} (reading), ${after.runs} runs per screen; medians, seconds.\n`)
console.log('| Screen | Words shown after (first) | | Answer complete | | Read + answer (total) | | Words | | Correct |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
console.log('| | before | after | before | after | before | after | before | after | before → after |')
const rows = after.summary.map((a) => ({ a, b: before.summary.find((x) => x.scenario === a.scenario) }))
for (const { a, b } of rows) console.log(`| ${a.scenario} (${a.kind}) | ${s(b.first)} | **${s(a.first)}** | ${s(b.answer)} | ${s(a.answer)} | ${s(b.total)} | ${s(a.total)} | ${b.words} | ${a.words} | ${b.correct}/${b.n} → ${a.correct}/${a.n} |`)
const b = before.overall
const a = after.overall
console.log(`| **All screens** | ${s(b.first)} | **${s(a.first)}** | ${s(b.answer)} | ${s(a.answer)} | ${s(b.total)} | ${s(a.total)} | ${b.words} | ${a.words} | ${b.correct}/${b.runs} → ${a.correct}/${a.runs} |`)
console.log(`\nFirst words: ${change(b.first, a.first)}; answer complete: ${change(b.answer, a.answer)}; read + answer: ${change(b.total, a.total)}.`)
console.log(`Model calls per answer: ${(b.modelCalls / b.runs).toFixed(2)} before, ${(a.modelCalls / a.runs).toFixed(2)} after.`)
