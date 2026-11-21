import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

/**
 * A whole pretend site on this machine, for end-to-end tests: the REAL NUMZ AI server (server/server.js, production mode, a fresh
 * database), the REAL numzlab-auth with the broker switched on (infrastructure/auth, driven by its own rig_ai.py: fake Google that
 * approves automatically as whoever the test chooses), and fakes for the two things that cost money or need hardware: the text model
 * and the speech service (which, like the real one, refuses callers without its key).
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const NUMZLAB_AUTH_DIR = process.env.NUMZLAB_AUTH_DIR ?? '/srv/infrastructure/auth'
export const rigAvailable = () => existsSync(path.join(NUMZLAB_AUTH_DIR, 'tests', 'rig_ai.py'))

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

const READINGS = [
  { isQuestion: true, text: 'Question 1. A car travels 150 km in 2.5 hours. What is its average speed?', options: [{ label: 'A', text: '40 km/h' }, { label: 'B', text: '60 km/h' }, { label: 'C', text: '75 km/h' }, { label: 'D', text: '100 km/h' }], type: 'multiple-choice', subject: 'physics', hasDiagram: false, confidence: 0.93, reason: '' },
  { isQuestion: true, text: 'Question 2. Name the longest river in Africa and the sea into which it flows.', options: [], type: 'short-answer', subject: 'geography', hasDiagram: false, confidence: 0.9, reason: '' }
]
const CAMERA_ANSWER = { subject: 'physics', type: 'multiple-choice', answer: 'B) 60 km/h', steps: ['speed = distance / time', '150 / 2.5 = 60'], explanation: 'Average speed is **distance divided by time**.', confidence: 'high', uncertainty: null }

/**
 * An OpenAI-compatible model that answers "echo: <what you asked>", reports token counts, and streams when asked to. It also plays the
 * vision model (a picture in the request -> the next question of two) and the camera's answering turn (a <question> in the request).
 */
export async function startFakeProvider() {
  const state = { calls: 0, streamOptionsSeen: 0, lastKey: null, delayMs: 0, pictures: 0, readings: 0 }
  const server = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString() || '{}')
    state.calls++
    state.lastKey = req.headers.authorization
    if (body.stream_options?.include_usage) state.streamOptionsSeen++
    const flat = JSON.stringify(body)
    if (/data:image\/(jpeg|png|webp);base64,/.test(flat)) {
      state.pictures++
      const reading = READINGS[Math.min(state.readings++, READINGS.length - 1)]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ model: 'fake-vision', choices: [{ message: { content: JSON.stringify(reading) } }], usage: { prompt_tokens: 900, completion_tokens: 80 } }))
    }
    if (flat.includes('<question>')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content: JSON.stringify(CAMERA_ANSWER) } }], usage: { prompt_tokens: 300, completion_tokens: 120 } }))
    }
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? ''
    const reply = `echo: ${String(last).slice(0, 200)}`
    const usage = { prompt_tokens: 40 + String(last).length, completion_tokens: reply.length }
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs))
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const word of reply.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [{ delta: { content: word } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [], usage })}\n\n`)
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { role: 'assistant', content: reply } }], usage }))
    }
  })
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

/** The speech service: answers only callers that present its key, like the real one does. */
export async function startFakeAudio(key) {
  const state = { served: 0, refused: 0 }
  const server = await listen(async (req, res) => {
    await readBody(req)
    if (req.headers['x-audio-key'] !== key) {
      state.refused++
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'audio key required' }))
    }
    state.served++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(req.url === '/health' ? { ok: true, model: 'fake' } : { text: 'hello from the microphone' }))
  })
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

function runUntil(child, test, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`${label} did not start in time\n${buffer.slice(-2000)}`)), timeoutMs)
    const onData = (chunk) => {
      buffer += chunk.toString()
      const hit = test(buffer)
      if (hit) {
        clearTimeout(timer)
        resolve(hit)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${label} exited early (${code})\n${buffer.slice(-2000)}`))
    })
  })
}

/**
 * Starts everything. `env` adds to / overrides the app's environment. `front` is the origin the PERSON'S BROWSER uses for both
 * the app and NUMZLAB when something (a real Caddy) is in front of them; without it they are two ports on 127.0.0.1.
 */
export async function startStack({ env = {}, front = null, appPort = null, authPort = null, startApp = true } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ai-stack-'))
  const secret = randomBytes(24).toString('hex')
  const audioKey = randomBytes(12).toString('hex')
  const provider = await startFakeProvider()
  const audio = await startFakeAudio(audioKey)
  const ports = { app: appPort ?? (await freePort()), auth: authPort ?? (await freePort()), check: await freePort() }
  const appOrigin = front ?? `http://127.0.0.1:${ports.app}`
  const authOrigin = front ?? `http://127.0.0.1:${ports.auth}`

  const rig = spawn(
    'python3',
    [
      path.join(NUMZLAB_AUTH_DIR, 'tests', 'rig_ai.py'),
      '--port', String(ports.auth), '--check-port', String(ports.check), '--public-url', authOrigin,
      '--secret', secret, '--redirect', `${appOrigin}/ai/auth/callback`
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
  )
  const ready = await runUntil(rig, (text) => text.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((o) => o?.ready), 'the NUMZLAB rig')

  const control = async (route, body) => {
    const res = await fetch(`${ready.control}/control/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return res.json()
  }

  const dbFile = path.join(tmp, 'speech.sqlite')
  const appEnv = {
    PATH: process.env.PATH,
    HOME: tmp,
    NUMZ_SKIP_ENV_FILES: '1', // never read the real .env / .env.secrets
    NODE_ENV: 'production',
    PORT: String(ports.app),
    CAMERA_VISION_PROVIDER: 'openai-compatible',
    CAMERA_VISION_API_KEY: 'stub',
    CAMERA_VISION_MODEL: 'fake-vision',
    CAMERA_VISION_BASE_URL: `${provider.url}/v1`,
    SPEECH_DATABASE_PATH: dbFile,
    ASSISTANT_AUTH_MODE: 'broker',
    PUBLIC_ORIGIN: appOrigin,
    PUBLIC_BASE_PATH: '/ai',
    AI_COOKIE_SECURE: 'off',
    NUMZLAB_BROKER_URL: `http://127.0.0.1:${ports.check}`,
    NUMZLAB_BROKER_AUTHORIZE_URL: authOrigin,
    NUMZLAB_BROKER_CLIENT_ID: 'numz-ai',
    NUMZLAB_BROKER_CLIENT_SECRET: secret,
    AI_REVALIDATE_S: '1',
    AI_MAINTAIN_S: '1',
    AI_LOGIN_RATE_LIMIT: '2000',
    AI_PROVIDER: 'custom',
    AI_BASE_URL: `${provider.url}/v1`,
    AI_API_KEY: 'test-provider-key',
    AI_MODEL: 'fake-model',
    AUDIO_SERVICE_URL: audio.url,
    AUDIO_SERVICE_KEY: audioKey,
    STT_BACKEND: 'local',
    MEETING_API_TOKEN: 'm'.repeat(40),
    MEETING_TICKET_SECRET: 't'.repeat(40),
    MEETING_LAUNCH_CODE: 'launch-code-123456',
    ...env
  }
  let app = null
  let appLog = ''
  async function start() {
    app = spawn('node', ['server/server.js'], { cwd: ROOT, env: appEnv })
    app.stdout.on('data', (c) => (appLog += c))
    app.stderr.on('data', (c) => (appLog += c))
    await runUntil(app, (text) => /API http:\/\/localhost:\d+/.test(text), 'the NUMZ AI server')
  }
  if (startApp) await start()

  return {
    ports,
    app: { origin: appOrigin, base: `${appOrigin}/ai`, port: ports.app, env: appEnv, log: () => appLog, start, stop: () => app?.kill('SIGTERM') },
    numzlab: { origin: authOrigin, control, checkUrl: `http://127.0.0.1:${ports.check}`, secret },
    provider,
    audio: { ...audio, key: audioKey },
    dbFile,
    tmp,
    async close() {
      app?.kill('SIGTERM')
      rig.kill('SIGTERM')
      await Promise.all([provider.close(), audio.close()])
      await new Promise((r) => setTimeout(r, 100))
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

/**
 * The real dashboard Caddyfile (the candidate in the infrastructure checkout), in a real Caddy container, in front of the app and
 * numzlab-auth on one origin, the way the shared site is. Rendered by the rehearsal's own render() so it is the file that ships.
 */
export async function startFront({ stack, listen: port, dist }) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ai-front-'))
  const unused = await freePort()
  const ports = JSON.stringify({ auth: stack.ports.auth, check: stack.ports.check, ai: stack.ports.app, cv: unused, deploy: unused, network: unused })
  const rendered = await new Promise((resolve, reject) => {
    const py = spawn('python3', ['-c', `import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(NUMZLAB_AUTH_DIR, 'tests'))})
import rehearse_caddy as r
print(r.render(r.CADDYFILE, ${port}, '127.0.0.1/32', json.loads(${JSON.stringify(ports)})))`], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    let out = ''
    let err = ''
    py.stdout.on('data', (c) => (out += c))
    py.stderr.on('data', (c) => (err += c))
    py.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`render failed: ${err}`))))
  })
  const caddyfile = path.join(tmp, 'Caddyfile')
  writeFileSync(caddyfile, rendered)
  const api = path.join(tmp, 'api')
  mkdirSync(api)
  const name = `ai-front-${port}`
  await new Promise((resolve, reject) => {
    const run = spawn('docker', ['run', '-d', '--rm', '--name', name, '--network', 'host', '-v', `${caddyfile}:/etc/caddy/Caddyfile:ro`, '-v', `${dist}:/rehearsal/dist:ro`, '-v', `${api}:/rehearsal/api:ro`, 'caddy:2-alpine', 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
    run.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('could not start Caddy'))))
  })
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/ai`, { redirect: 'manual' })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => spawn('docker', ['rm', '-f', name]).on('exit', resolve))
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

/** A browser that is only a cookie jar: cookies are kept per host:port and sent by path, redirects are followed by hand. */
export class Browser {
  constructor() {
    this.jar = new Map() // origin -> Map(name -> { value, path })
    this.hops = []
  }

  cookies(url) {
    const u = new URL(url)
    const mine = this.jar.get(u.host) ?? new Map()
    return [...mine].filter(([, c]) => u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`) || c.path === '/')
  }

  header(url) {
    return this.cookies(url).map(([k, c]) => `${k}=${c.value}`).join('; ')
  }

  store(url, res) {
    const u = new URL(url)
    const mine = this.jar.get(u.host) ?? new Map()
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split('; ')
      const i = pair.indexOf('=')
      const name = pair.slice(0, i)
      const value = pair.slice(i + 1)
      const cpath = (attrs.find((a) => /^path=/i.test(a)) ?? 'Path=/').slice(5)
      if (attrs.some((a) => /^max-age=0$/i.test(a)) || !value) mine.delete(name)
      else mine.set(name, { value, path: cpath, line })
    }
    this.jar.set(u.host, mine)
  }

  async request(url, { method = 'GET', headers = {}, body, origin, csrf, follow = false } = {}) {
    const h = { ...headers }
    const cookie = this.header(url)
    if (cookie) h.cookie = cookie
    if (origin) h.origin = origin
    if (csrf) h['x-csrf-token'] = csrf
    let payload = body
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
      payload = JSON.stringify(body)
      h['content-type'] ??= 'application/json'
    }
    const res = await fetch(url, { method, headers: h, body: payload, redirect: 'manual' })
    this.store(url, res)
    this.hops.push({ url, status: res.status })
    if (follow && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.arrayBuffer()
      return this.request(new URL(res.headers.get('location'), url).toString(), { follow: follow === true ? 12 : follow - 1 > 0 ? follow - 1 : false })
    }
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* not json */
    }
    return { status: res.status, headers: res.headers, text, json, url }
  }

  /**
   * The whole sign-in: start at the app, go through NUMZLAB and "Google", come back with a session. Stops where the person lands inside the
   * app (never loads the page itself) and returns { response, landed } with the last answer and the address they were sent to.
   */
  async signIn(appBase, next = '') {
    const appUrl = new URL(appBase)
    let url = `${appBase}/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`
    for (let i = 0; i < 15; i++) {
      const response = await this.request(url)
      const location = response.headers.get('location')
      if (!(response.status >= 300 && response.status < 400 && location)) return { response, landed: url }
      const target = new URL(location, url)
      if (target.origin === appUrl.origin && target.pathname.startsWith(appUrl.pathname) && !target.pathname.startsWith(`${appUrl.pathname}/auth/`)) {
        return { response, landed: target.toString() }
      }
      url = target.toString()
    }
    throw new Error('too many redirects while signing in')
  }
}
