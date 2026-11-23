// A markdown document of about <MB> megabytes: sections of a few paragraphs of random technical sentences. node make-doc.mjs <file> <MB>
import fs from 'node:fs'
const [file, mb] = [process.argv[2], Number(process.argv[3])]
const out = fs.createWriteStream(file)
const words = 'relational database table normalisation transaction index schema query join key constraint lecture revision algorithm complexity network protocol latency throughput memory cache thread process kernel scheduler'.split(' ')
let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const sentence = () => Array.from({ length: 8 + Math.floor(rnd() * 14) }, () => words[Math.floor(rnd() * words.length)]).join(' ') + '.'
let bytes = 0
let section = 0
const write = async (s) => { bytes += Buffer.byteLength(s); if (!out.write(s)) await new Promise((r) => out.once('drain', r)) }
while (bytes < mb * 1024 * 1024) {
  await write(`\n## Section ${section++}\n\n`)
  for (let p = 0; p < 4; p++) await write(Array.from({ length: 5 + Math.floor(rnd() * 8) }, sentence).join(' ') + '\n\n')
  if (section === 123456) await write('needlemarkerzq unique phrase\n\n')
}
out.end()
await new Promise((r) => out.on('finish', r))
console.log(fs.statSync(file).size)
