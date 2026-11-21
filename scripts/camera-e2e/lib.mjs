// Shared setup for the Smart Camera's real-browser checks (run.mjs, unhappy.mjs): a fake camera, a stub standing in
// for the vision and text models, the real server.js in production mode, and a headless Chromium.
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FFMPEG = process.env.FFMPEG || 'ffmpeg'
export const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM || '/srv/projects/ZEDFOOTBALL/frontend/package.json')('playwright')

export function workDir() {
  const dir = process.env.CAMERA_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'numz-camera-e2e-'))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---- the fake camera: two rendered question screens, played in turn ------------------------------------------------
const SCREENS = {
  q1: '<body style="margin:0;background:#fff;color:#111;font:38px/1.5 Arial,sans-serif;padding:70px 90px;width:1100px;height:580px"><div style="color:#555;font-size:26px">Physics practice · Set 3</div><p style="margin:18px 0"><b>Question 1.</b> A car travels 150 km in 2.5 hours. What is its average speed?</p><div>A) 40 km/h &nbsp;&nbsp; B) 60 km/h &nbsp;&nbsp; C) 75 km/h &nbsp;&nbsp; D) 100 km/h</div></body>',
  q2: '<body style="margin:0;background:#f4f1ea;color:#161616;font:40px/1.5 Georgia,serif;padding:70px 90px;width:1100px;height:580px"><div style="color:#666;font-size:26px">Geography practice · Set 1</div><p style="margin:18px 0"><b>Question 2.</b> Name the longest river in Africa and the sea into which it flows.</p><div style="color:#444">Give your answer in one sentence.</div></body>'
}

/** Renders the two screens and joins them into one looping video. Returns the path of the feed. */
export async function makeFeed(dir) {
  const feed = `${dir}/feed.mjpeg`
  if (fs.existsSync(feed)) return feed
  const shooter = await chromium.launch()
  const page = await shooter.newPage({ viewport: { width: 1280, height: 720 } })
  for (const [name, html] of Object.entries(SCREENS)) {
    await page.setContent(html)
    await page.screenshot({ path: `${dir}/${name}.png` })
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '10', '-i', `${dir}/${name}.png`, '-t', '10', '-vf', 'scale=1280:720,format=yuvj420p', '-q:v', '3', '-f', 'mjpeg', `${dir}/${name}.mjpeg`])
  }
  await shooter.close()
  fs.writeFileSync(feed, Buffer.concat([fs.readFileSync(`${dir}/q1.mjpeg`), fs.readFileSync(`${dir}/q2.mjpeg`)]))
  return feed
}

// ---- the stub provider ---------------------------------------------------------------------------------------------
export const READINGS = [
  { isQuestion: true, text: 'Question 1. A car travels 150 km in 2.5 hours. What is its average speed?', options: [{ label: 'A', text: '40 km/h' }, { label: 'B', text: '60 km/h' }, { label: 'C', text: '75 km/h' }, { label: 'D', text: '100 km/h' }], type: 'multiple-choice', subject: 'physics', hasDiagram: false, confidence: 0.93, reason: '' },
  { isQuestion: true, text: 'Question 2. Name the longest river in Africa and the sea into which it flows.', options: [], type: 'short-answer', subject: 'geography', hasDiagram: false, confidence: 0.9, reason: '' }
]

/** A stand-in for both models. Counters and switches are on the returned object. */
export async function startStub(port) {
  const stub = { pictures: 0, texts: 0, firstPicture: null, readings: 0, failPictures: 0, failTexts: 0, server: null }
  stub.server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const flat = JSON.stringify(JSON.parse(body))
      const m = flat.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/)
      res.setHeader('content-type', 'application/json')
      if (m) {
        stub.pictures++
        if (stub.failPictures > 0) {
          stub.failPictures--
          res.statusCode = 500
          return res.end('{"error":{"message":"stub failure"}}')
        }
        if (!stub.firstPicture) stub.firstPicture = Buffer.from(m[1], 'base64')
        const reading = READINGS[Math.min(stub.readings++, READINGS.length - 1)]
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }))
      }
      stub.texts++
      if (stub.failTexts > 0) {
        stub.failTexts--
        res.statusCode = 500
        return res.end('{"error":{"message":"stub failure"}}')
      }
      const first = flat.includes('average speed')
      const answer = first
        ? { subject: 'physics', type: 'multiple-choice', answer: 'B) 60 km/h', steps: ['speed = distance / time', '150 / 2.5 = 60'], explanation: 'Average speed is **distance divided by time**, so 150 km over 2.5 h is 60 km/h.', confidence: 'high', uncertainty: null }
        : { subject: 'geography', type: 'short-answer', answer: 'The Nile, flowing into the Mediterranean Sea.', steps: [], explanation: 'The Nile is generally given as the longest river in Africa and ends in the Mediterranean.', confidence: 'medium', uncertainty: 'River lengths are measured differently by different sources.' }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }))
    })
  })
  await new Promise((r) => stub.server.listen(port, '127.0.0.1', r))
  return stub
}

// ---- the real server -----------------------------------------------------------------------------------------------
/** Starts server.js in production mode on `port` with a throwaway database. `env` adds or overrides settings. */
export async function startApp({ dir, port, stubPort, vision = true, env = {} }) {
  const db = path.join(dir, `e2e-${port}.sqlite`)
  for (const f of [db, db + '-wal', db + '-shm']) fs.rmSync(f, { force: true })
  const stubBase = `http://127.0.0.1:${stubPort}/v1`
  const proc = spawn(process.execPath, ['--no-warnings', 'server/server.js'], {
    cwd: repo,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NUMZ_SKIP_ENV_FILES: '1', PORT: String(port), NODE_ENV: 'production', SPEECH_DATABASE_PATH: db,
      AI_PROVIDER: 'custom', AI_API_KEY: 'stub', AI_BASE_URL: stubBase, AI_MODEL: 'stub',
      ...(vision ? { CAMERA_VISION_PROVIDER: 'openai-compatible', CAMERA_VISION_API_KEY: 'stub', CAMERA_VISION_MODEL: 'stub', CAMERA_VISION_BASE_URL: stubBase } : {}),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const app = { port, origin: `http://localhost:${port}`, log: '', stop: null }
  proc.stdout.on('data', (c) => (app.log += c))
  proc.stderr.on('data', (c) => (app.log += c))
  app.stop = async () => {
    proc.kill('SIGTERM')
    await new Promise((r) => proc.once('exit', r))
  }
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) return app
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  await app.stop()
  throw new Error(`server on ${port} did not come up:\n${app.log}`)
}

export const launchBrowser = (feed) =>
  chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${feed}`, '--autoplay-policy=no-user-gesture-required'] })

export const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] }

export function reporter() {
  const results = []
  return {
    check(name, ok, extra = '') {
      results.push(Boolean(ok))
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
    },
    finish(extraLine = '') {
      if (extraLine) console.log(extraLine)
      const ok = results.every(Boolean)
      console.log(ok ? 'ALL PASS' : 'SOME FAILED')
      return ok
    }
  }
}

export const kindOf = (page) => page.getAttribute('#cameraIndicator', 'data-kind')
