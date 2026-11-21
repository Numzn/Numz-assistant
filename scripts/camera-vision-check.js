#!/usr/bin/env node
/**
 * Proves the Smart Camera's vision provider is set up: sends one picture to it, exactly as the camera would, and says
 * what happened. Run it after putting the CAMERA_VISION_* settings in .env.secrets:
 *
 *   node scripts/camera-vision-check.js                 uses a rendered test question
 *   node scripts/camera-vision-check.js photo.jpg       or any JPEG, PNG or WebP of your own
 *
 * Every run is one paid call. It prints the provider's name and the question it read, never the key or anything the
 * provider said about an error. Exit code: 0 it works, 1 not configured, 2 the picture, 3 the provider, 4 the reply.
 */
import './../server/loadEnv.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVisionFromEnv, describeVision } from '../server/camera/vision.js'
import { runVisionCheck } from '../server/camera/visionCheck.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] ?? path.join(here, 'fixtures', 'camera-question.jpg')

let picture
try {
  picture = fs.readFileSync(file)
} catch {
  console.error(`Could not read the picture: ${file}`)
  process.exit(2)
}

const vision = createVisionFromEnv(process.env)
console.log(describeVision(vision))
console.log(`Picture: ${path.basename(file)} (${(picture.length / 1024).toFixed(0)} KB)`)

const result = await runVisionCheck({ vision, picture })
if (result.ok) {
  console.log(`OK: ${result.provider} read the picture in ${(result.ms / 1000).toFixed(1)} s.`)
  console.log(`  Question: ${result.question.text}`)
  if (result.question.options.length) console.log(`  Options:  ${result.question.options.map((o) => `${o.label ? `${o.label}) ` : ''}${o.text}`).join('   ')}`)
  console.log(`  Kind: ${result.question.type}${result.question.subject ? `, ${result.question.subject}` : ''}; confidence ${result.question.confidence}${result.question.hasDiagram ? '; needs a figure' : ''}`)
  console.log('Pictures sent from the camera page will be read the same way.')
  process.exit(0)
}
console.error(`FAILED at ${result.stage}${result.status ? ` (HTTP ${result.status})` : ''}.`)
console.error(result.advice)
process.exit({ configuration: 1, picture: 2, provider: 3, reply: 4, reading: 4 }[result.stage] ?? 3)
