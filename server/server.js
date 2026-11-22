import './loadEnv.js'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { assistantRouter } from './routes/assistant.js'
import { createCameraRouter } from './routes/camera.js'
import { createScreenshotRouter } from './routes/screenshots.js'
import { createAcademicRouter } from './routes/academic.js'
import { createAcademicRepository } from './persistence/academicRepository.js'
import { createMemoryLaneManager } from './academic/memoryLanes.js'
import { createScreenshotService } from './screenshots/screenshotService.js'
import { createCameraService } from './camera/cameraService.js'
import { cameraLimitsFromEnv } from './camera/cameraLimits.js'
import { createVisionFromEnv, describeVision } from './camera/vision.js'
import { createMeetingsRouter } from './routes/meetings.js'
import { createMeetingIntelligenceService } from './services/meetingIntelligenceService.js'
import { generateGroundedNotes } from './services/speechNotesService.js'
import { createLiveMeetingIntelligence } from './services/liveMeetingIntelligenceService.js'
import { generateMeetingSummary } from './services/meetingSummaryService.js'
import { generateResponse } from './services/aiService.js'
import { attachSocketServer } from './websocket/socketServer.js'
import { createUpgradeRouter } from './websocket/upgradeRouter.js'
import { attachLiveSpeechRelay, liveSpeechUpstreamUrl } from './websocket/liveSpeechRelay.js'
import { getAiConfig, logAiConfig, probeDeepSeek } from './aiConfig.js'
import { createAiProvider } from './ai/providers/providerFactory.js'
import { createDatabase } from './persistence/sqliteDatabase.js'
import { createMeetingRepository } from './persistence/meetingRepository.js'
import { createSpeechSessionRepository } from './persistence/speechSessionRepository.js'
import { createTranscriptRepository } from './persistence/transcriptRepository.js'
import { createConversationRepository } from './persistence/conversationRepository.js'
import { sessionService } from './sessions/sessionService.js'
import { createMeetingSessionService } from './services/meetingSessionService.js'
import { createMeetingAuth } from './auth/meetingAuth.js'
import { createAssistantAuth } from './auth/assistantAuth.js'
import { SYSTEM_IDENTITY } from './auth/identity.js'
import { createCodeAccess } from './auth/codeAccess.js'
import { createAiAuth } from './auth/aiSessions.js'
import { createBrokerClient } from './auth/brokerClient.js'
import { createIdentityRepository } from './persistence/identityRepository.js'
import { createMeter } from './usage/meter.js'
import { createAdminRouter } from './routes/admin.js'
import { normalizeBasePath, stripBasePath } from './http/basePath.js'
import { logMeetingsConfig, meetingsHealth } from './meetings/meetingHealth.js'
import { errorHandler, notFoundHandler } from './http/errorHandler.js'
import { createStaticAssets } from './http/staticAssets.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const nodeEnv = process.env.NODE_ENV ?? 'development'
const isProd = nodeEnv === 'production'
const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

// Who may use the assistant:
//   ASSISTANT_AUTH_MODE=code    (default) the one shared access code, exactly as before: the rollback position
//   ASSISTANT_AUTH_MODE=broker  each person signs in with Google through NUMZLAB's broker and gets their own session, conversations and limits
const authMode = String(process.env.ASSISTANT_AUTH_MODE ?? 'code').trim().toLowerCase()
if (!['code', 'broker'].includes(authMode)) {
  console.error(`[auth] ASSISTANT_AUTH_MODE must be code or broker, not "${authMode}"; refusing to start`)
  process.exit(1)
}
const basePath = normalizeBasePath(process.env.PUBLIC_BASE_PATH)
const publicOrigin = String(process.env.PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '')

const aiConfig = logAiConfig()
const speechDatabase = createDatabase()
const meter = createMeter({ database: speechDatabase, timeoutMs: Number.parseInt(process.env.AI_CALL_TIMEOUT_MS ?? '', 10) || 60_000 })
// Saved conversations live in the same database. ASSISTANT_HISTORY=off keeps conversations in memory only.
const historyEnabled = !['off', '0', 'false', 'no'].includes(String(process.env.ASSISTANT_HISTORY ?? 'on').trim().toLowerCase())
if (historyEnabled) sessionService.useStore(createConversationRepository(speechDatabase))
console.log(`[history] assistant conversation history is ${historyEnabled ? 'ON (saved in the database)' : 'OFF (memory only)'}`)
const meetingEvents = new EventEmitter()
const meetingService = createMeetingSessionService({
  meetingRepository: createMeetingRepository(speechDatabase),
  speechSessionRepository: createSpeechSessionRepository(speechDatabase),
  transcriptRepository: createTranscriptRepository(speechDatabase),
  eventBus: meetingEvents
})
// Live meeting intelligence listens to the canonical store: it only ever sees segments that were persisted. With no
// AI provider configured it does not call one (the state says so) instead of sending a meeting to a placeholder.
const requireAi = () => {
  if (!aiConfig.configured) throw Object.assign(new Error('The AI provider is not configured'), { statusCode: 503 })
}
// MEETING_LIVE_INTELLIGENCE=off keeps every meeting's transcript away from the model provider: findings are then
// only what the words state outright. (On, a meeting's saved lines are sent to the AI provider while it runs.)
const liveIntelligenceOn = !['off', '0', 'false', 'no'].includes(String(process.env.MEETING_LIVE_INTELLIGENCE ?? 'on').trim().toLowerCase())
console.log(`[meetings] live intelligence model updates are ${liveIntelligenceOn ? 'ON' : 'OFF'}`)
const liveMeetingIntelligence = createLiveMeetingIntelligence({
  meetingService,
  eventBus: meetingEvents,
  modelEnabled: liveIntelligenceOn,
  // How long after the first unanalysed line the model is asked (default 15 s): the latency/cost dial.
  ...(Number.parseInt(process.env.MEETING_INTELLIGENCE_DEBOUNCE_MS ?? '', 10) > 0
    ? { debounceMs: Number.parseInt(process.env.MEETING_INTELLIGENCE_DEBOUNCE_MS, 10) }
    : {}),
  // Meeting analysis belongs to no signed-in person (a meeting is started with its own ticket), so it is recorded under 'system'. It still
  // counts, it is still stopped by the emergency stop, and it still has a time limit.
  generateRolling: async (messages) => {
    requireAi()
    const call = meter.begin(SYSTEM_IDENTITY, 'meeting_intel', {})
    try {
      const reply = await generateResponse(messages, { signal: call.signal, onUsage: call.usage })
      call.estimate({ inText: messages.map((m) => m.content).join(''), outText: reply })
      call.finish()
      return reply
    } catch (err) {
      call.fail(err)
      throw err
    }
  },
  generateFinal: async (transcript) => {
    requireAi()
    const call = meter.begin(SYSTEM_IDENTITY, 'meeting_intel', {})
    try {
      const result = await generateMeetingSummary(transcript)
      call.finish()
      return result
    } catch (err) {
      call.fail(err)
      throw err
    }
  }
})
const meetingAuth = createMeetingAuth({
  adminToken: process.env.MEETING_API_TOKEN ?? '',
  ticketSecret: process.env.MEETING_TICKET_SECRET ?? '',
  launchCode: process.env.MEETING_LAUNCH_CODE ?? '',
  ticketTtlSeconds: Number.parseInt(process.env.MEETING_TICKET_TTL_S ?? '43200', 10) || 43200,
  // How long typing the launch code once covers starting further meetings (default 8 h).
  launchSessionTtlSeconds: Number.parseInt(process.env.MEETING_LAUNCH_SESSION_TTL_S ?? '28800', 10) || 28800,
  launchSessionPath: `${basePath}/api/v1/meetings`,
  // Per-person sign-in: being signed in is what lets a person start a meeting, so there is no launch code to type or to guess.
  signedInLaunch: authMode === 'broker'
})
// One shared access code protects the assistant API (HTTP, its WebSocket and the DeepSeek probe). Unset keeps it
// open exactly as before; see server/auth/assistantAuth.js.
const assistantAuth = createAssistantAuth({
  accessCode: process.env.ASSISTANT_ACCESS_CODE ?? '',
  ttlSeconds: Number.parseInt(process.env.ASSISTANT_SESSION_TTL_S ?? '43200', 10) || 43200
})
const identityRepo = createIdentityRepository(speechDatabase)
// Academic Intelligence: a person's courses, study sessions and learning memory (docs/academic-intelligence.md). The memory lanes are one
// facade over the stores that already exist; nothing here is a second assistant. No live session survives a restart.
const academicRepo = createAcademicRepository(speechDatabase)
academicRepo.endAllOpenSessions('server-restart')
const auditAcademic = (event, { userId = null, detail = null } = {}) => {
  try {
    identityRepo.audit({ event, userId, detail })
  } catch {
    /* an audit failure must not break the request it describes */
  }
}
const memoryLanes = createMemoryLaneManager({ academic: academicRepo, conversations: sessionService, audit: auditAcademic })
setInterval(() => academicRepo.maintain({ retentionDays: Number.parseInt(process.env.ACADEMIC_SESSION_RETENTION_DAYS ?? '14', 10) || 14 }), 10 * 60_000).unref()
const audioKey = String(process.env.AUDIO_SERVICE_KEY ?? '').trim()
let access
if (authMode === 'broker') {
  try {
    if (!publicOrigin) throw new Error('PUBLIC_ORIGIN (for example https://lab.numz.site) is required in broker mode')
    const clientSecret = String(process.env.NUMZLAB_BROKER_CLIENT_SECRET ?? '')
    const broker = createBrokerClient({
      brokerUrl: process.env.NUMZLAB_BROKER_URL ?? 'http://host.docker.internal:18792',
      authorizeBase: process.env.NUMZLAB_BROKER_AUTHORIZE_URL ?? publicOrigin,
      clientId: process.env.NUMZLAB_BROKER_CLIENT_ID ?? 'numz-ai',
      clientSecret,
      redirectUri: `${publicOrigin}${basePath}/auth/callback`
    })
    const allowed = String(process.env.AI_ALLOWED_EXTERNAL_IDS ?? '').split(',').map((v) => v.trim()).filter(Boolean)
    const num = (name, fallback) => Number.parseInt(process.env[name] ?? '', 10) || fallback
    access = createAiAuth({
      repo: identityRepo,
      broker,
      meter,
      config: {
        publicOrigin,
        basePath,
        idleS: num('AI_SESSION_IDLE_S', 3600),
        maxS: num('AI_SESSION_MAX_S', 8 * 3600),
        revalidateS: num('AI_REVALIDATE_S', 60),
        graceS: num('AI_REVALIDATE_GRACE_S', 600),
        maintainS: num('AI_MAINTAIN_S', 30),
        loginLimit: num('AI_LOGIN_RATE_LIMIT', 30),
        // Secure cookies are the rule; plain-http local testing (127.0.0.1) may switch it off, and only there.
        secure: !(String(process.env.AI_COOKIE_SECURE ?? '').toLowerCase() === 'off' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(publicOrigin)),
        allowedExternalIds: allowed.length ? new Set(allowed) : null
      }
    })
    console.log(`[auth] per-person sign-in via the NUMZLAB broker${allowed.length ? ` (limited to ${allowed.length} person/people)` : ''}; base path "${basePath || '/'}"`)
  } catch (err) {
    console.error(`[auth] broker sign-in is not configured correctly: ${err.message}; refusing to start (it never falls back to open)`)
    process.exit(1)
  }
} else {
  access = createCodeAccess(assistantAuth)
}
logMeetingsConfig({ auth: meetingAuth })
// The Smart Camera reads questions off a picture with a vision model (CAMERA_VISION_*; the picture goes to that provider
// and nowhere else) and answers them with the same text model as the assistant. Without a vision provider the page opens
// but says it cannot read pictures. Each answered question is saved as an ordinary conversation (see cameraService.js).
const cameraVision = createVisionFromEnv(process.env)
console.log(describeVision(cameraVision))
const cameraService = createCameraService({
  vision: cameraVision,
  answerEngine: async (messages, opts) => {
    requireAi()
    return generateResponse(messages, opts)
  },
  sessions: sessionService,
  limits: cameraLimitsFromEnv(process.env)
})
console.log(`[camera] up to ${cameraService.limits.maxReads} pictures are read per camera session`)
setInterval(() => cameraService.sweep(), 30_000).unref()
// Screenshot Intelligence (the desktop app's screenshots) uses the SAME vision provider as the camera and the same conversations:
// an analysis is saved as ordinary messages marked with the screenshot's id; the picture itself is held in memory for a few minutes.
const screenshotService = createScreenshotService({ vision: cameraVision, sessions: sessionService })
setInterval(() => screenshotService.sweep(), 30_000).unref()
// No live connection survives a process restart: interrupted meetings move to RECOVERING.
const meetingRecovery = meetingService.recoverInterruptedMeetings()
console.log(
  `[meetings] startup recovery: ${meetingRecovery.endedSessions} speech session(s) ended, ` +
    `${meetingRecovery.recoveredMeetings} meeting(s) moved to RECOVERING`
)

try {
  const provider = createAiProvider()
  console.log(`[ai] provider module initialized: ${provider.name}`)
} catch (err) {
  console.error('[ai] provider initialization failed:', err?.message ?? err)
}

function log(level, message, meta) {
  const line = `[${new Date().toISOString()}] ${level} ${message}`
  if (meta !== undefined) console.log(line, meta)
  else console.log(line)
}

// The live-speech relay is attached after the app is built, so the meetings router reaches it through this.
const liveSpeech = { relay: null }

function createApp() {
  const app = express()
  app.disable('x-powered-by')
  // The proxies in front are on this host (loopback / private networks): believe their X-Forwarded-For so req.ip is the real person.
  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal'])
  // Served under /ai/ on the shared site: the proxy passes the path through, and the prefix comes off here.
  app.use(stripBasePath(basePath))

  app.use((req, res, next) => {
    const id = req.headers['x-request-id']?.toString() || randomUUID()
    req.id = id
    res.setHeader('x-request-id', id)
    next()
  })

  // HSTS is the edge's to send (the shared site's other apps would inherit an includeSubDomains from here), so broker mode leaves it out.
  app.use(helmet(isProd ? (authMode === 'broker' ? { hsts: false } : {}) : { contentSecurityPolicy: false }))
  // The browser only ever calls its own origin, so per-person sign-in needs no CORS at all: a foreign origin gets no permission, and
  // credentials are never reflected back to whoever asks. (The shared-code mode keeps what it always had.)
  if (authMode !== 'broker') {
    app.use(
      cors({
        origin: isProd ? true : corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
        credentials: true
      })
    )
  }
  app.use(express.json({ limit: '256kb' }))
  app.use((req, _res, next) => {
    req.meter = meter
    req.screenshots = screenshotService
    next()
  })

  const healthDetail = () => {
    const cfg = getAiConfig()
    return {
      ok: true,
      service: 'ai-assistant-api',
      aiProvider: cfg.provider,
      aiConfigured: cfg.configured,
      aiModel: cfg.model || null,
      aiBaseUrl: cfg.baseUrl || null,
      meetings: meetingsHealth({ auth: meetingAuth }),
      assistant: { auth: access.status() }
    }
  }
  // The public health answer (the container's own check, the host's service monitor) says only that it is up. Which model, which provider
  // address and the meeting settings are for signed-in people (/health/detail).
  app.get('/api/v1/health', (_req, res) => {
    res.json({ ok: true, service: 'ai-assistant-api', assistant: { auth: access.status() } })
  })
  app.get('/api/v1/health/detail', access.requireSession('chat'), (_req, res) => res.json(healthDetail()))

  app.get('/api/v1/health/deepseek', access.requireSession('ai.admin'), async (req, res) => {
    // A paid call to the provider: administrators only, and counted like any other.
    const call = meter.begin(req.identity, 'health_probe', { requestId: req.id })
    try {
      const result = await probeDeepSeek()
      call.finish()
      res.status(result.ok ? 200 : result.configured ? 502 : 503).json(result)
    } catch (err) {
      call.fail(err)
      throw err
    }
  })

  // Sign-in routes stay outside the protected area (status, login, logout; and /auth/login, /auth/callback for the Google sign-in);
  // everything else under /assistant needs the person's session.
  app.use('/api/v1/assistant/auth', access.jsonRouter())
  app.use('/auth', access.browserRouter())
  app.get('/api/v1/assistant/usage', access.requireSession('usage.self', { touch: false }), (req, res) => res.json(meter.summary(req.identity)))
  // The camera takes a raw picture body, so it is mounted ahead of the generic assistant router; same access gate.
  app.use('/api/v1/assistant/camera', access.requireSession('camera'), createCameraRouter({ service: cameraService }))
  // Screenshot attachments take a raw picture body too, and belong to a chat conversation: the chat capability gates them.
  app.use('/api/v1/assistant/screenshots', access.requireSession('chat'), createScreenshotRouter({ service: screenshotService }))
  app.use('/api/v1/assistant/academic', access.requireSession('academic'), createAcademicRouter({ lanes: memoryLanes, audit: auditAcademic }))
  app.use('/api/v1/assistant', access.requireSession('chat'), assistantRouter)
  app.use(
    '/api/v1/admin',
    access.requireSession('ai.admin'),
    createAdminRouter({ access, repo: identityRepo, meter, health: healthDetail, probe: probeDeepSeek })
  )
  app.use(
    '/api/v1/meetings',
    createMeetingsRouter({
      meetingService,
      auth: meetingAuth,
      launchGuard: authMode === 'broker' ? access.requireSession('meetings.launch') : null,
      intelligenceService: createMeetingIntelligenceService({ meetingService, generateNotes: generateGroundedNotes }),
      liveIntelligence: liveMeetingIntelligence,
      closeLiveSpeech: (meetingId) => liveSpeech.relay?.closeMeeting(meetingId) ?? 0
    })
  )

  if (isProd) {
    // Built files: precompressed copies when the browser accepts them, hashed assets cached for a year,
    // everything else (index.html above all) revalidated each time. See server/http/staticAssets.js.
    const dist = path.join(rootDir, 'dist')
    const assets = createStaticAssets({ dir: dist })
    app.use(assets)
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/auth/')) return next()
      assets.sendIndex(req, res, next)
    })
  }

  app.use('/api', notFoundHandler)
  app.use(errorHandler())

  return app
}

const listenPort = Number.isFinite(port) ? port : 3001
const app = createApp()
const server = http.createServer(app)
const upgrades = createUpgradeRouter(server, { basePath })
attachSocketServer(server, {
  upgrades,
  authorize: (req) => access.authorizeUpgrade(req, 'chat'),
  meter,
  // A signed-in person's socket is remembered so it can be closed the moment their access ends; talking on it counts as using the app.
  onConnect: (ws, verdict) => verdict.identity && !verdict.identity.legacy && access.trackSocket(verdict.identity, ws, verdict.idHash),
  onActivity: (verdict) => verdict.idHash && access.touchSession(verdict.idHash)
})
liveSpeech.relay = attachLiveSpeechRelay({
  upgrades,
  auth: meetingAuth,
  upstreamUrl: liveSpeechUpstreamUrl(process.env.AUDIO_SERVICE_URL || undefined),
  // With per-person sign-in the ticket is not enough on its own: the holder must also be a signed-in person on our own page.
  access: authMode === 'broker' ? access : null,
  upstreamHeaders: audioKey ? { 'X-Audio-Key': audioKey } : {}
})
access.start()
server.listen(listenPort, () => {
  log('INFO', `API http://localhost:${listenPort}`, {
    env: nodeEnv,
    aiProvider: aiConfig.provider,
    aiConfigured: aiConfig.configured
  })
})
