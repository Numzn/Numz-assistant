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
import { createMeetingsRouter } from './routes/meetings.js'
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
import { logMeetingsConfig, meetingsHealth } from './meetings/meetingHealth.js'
import { errorHandler, notFoundHandler } from './http/errorHandler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const nodeEnv = process.env.NODE_ENV ?? 'development'
const isProd = nodeEnv === 'production'
const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const aiConfig = logAiConfig()
const speechDatabase = createDatabase()
// Saved conversations live in the same database. ASSISTANT_HISTORY=off keeps conversations in memory only.
const historyEnabled = !['off', '0', 'false', 'no'].includes(String(process.env.ASSISTANT_HISTORY ?? 'on').trim().toLowerCase())
if (historyEnabled) sessionService.useStore(createConversationRepository(speechDatabase))
console.log(`[history] assistant conversation history is ${historyEnabled ? 'ON (saved in the database)' : 'OFF (memory only)'}`)
const meetingService = createMeetingSessionService({
  meetingRepository: createMeetingRepository(speechDatabase),
  speechSessionRepository: createSpeechSessionRepository(speechDatabase),
  transcriptRepository: createTranscriptRepository(speechDatabase),
  eventBus: new EventEmitter()
})
const meetingAuth = createMeetingAuth({
  adminToken: process.env.MEETING_API_TOKEN ?? '',
  ticketSecret: process.env.MEETING_TICKET_SECRET ?? '',
  launchCode: process.env.MEETING_LAUNCH_CODE ?? '',
  ticketTtlSeconds: Number.parseInt(process.env.MEETING_TICKET_TTL_S ?? '43200', 10) || 43200,
  // How long typing the launch code once covers starting further meetings (default 8 h).
  launchSessionTtlSeconds: Number.parseInt(process.env.MEETING_LAUNCH_SESSION_TTL_S ?? '28800', 10) || 28800
})
// One shared access code protects the assistant API (HTTP, its WebSocket and the DeepSeek probe). Unset keeps it
// open exactly as before; see server/auth/assistantAuth.js.
const assistantAuth = createAssistantAuth({
  accessCode: process.env.ASSISTANT_ACCESS_CODE ?? '',
  ttlSeconds: Number.parseInt(process.env.ASSISTANT_SESSION_TTL_S ?? '43200', 10) || 43200
})
logMeetingsConfig({ auth: meetingAuth })
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

function createApp() {
  const app = express()
  app.disable('x-powered-by')

  app.use((req, res, next) => {
    const id = req.headers['x-request-id']?.toString() || randomUUID()
    req.id = id
    res.setHeader('x-request-id', id)
    next()
  })

  app.use(helmet(isProd ? {} : { contentSecurityPolicy: false }))
  app.use(
    cors({
      origin: isProd ? true : corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
      credentials: true
    })
  )
  app.use(express.json({ limit: '256kb' }))

  app.get('/api/v1/health', (_req, res) => {
    const cfg = getAiConfig()
    res.json({
      ok: true,
      service: 'ai-assistant-api',
      aiProvider: cfg.provider,
      aiConfigured: cfg.configured,
      aiModel: cfg.model || null,
      aiBaseUrl: cfg.baseUrl || null,
      meetings: meetingsHealth({ auth: meetingAuth }),
      assistant: { auth: assistantAuth.status() }
    })
  })

  app.get('/api/v1/health/deepseek', assistantAuth.requireAccess, async (_req, res) => {
    const result = await probeDeepSeek()
    res.status(result.ok ? 200 : result.configured ? 502 : 503).json(result)
  })

  // Login, logout and status stay outside the protected area; everything else under /assistant needs the cookie.
  app.use('/api/v1/assistant/auth', assistantAuth.router())
  app.use('/api/v1/assistant', assistantAuth.requireAccess, assistantRouter)
  app.use('/api/v1/meetings', createMeetingsRouter({ meetingService, auth: meetingAuth }))

  if (isProd) {
    const dist = path.join(rootDir, 'dist')
    app.use(express.static(dist, { index: false }))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next()
      res.sendFile(path.join(dist, 'index.html'))
    })
  }

  app.use('/api', notFoundHandler)
  app.use(errorHandler())

  return app
}

const listenPort = Number.isFinite(port) ? port : 3001
const app = createApp()
const server = http.createServer(app)
const upgrades = createUpgradeRouter(server)
attachSocketServer(server, { upgrades, authorize: assistantAuth.authorizeUpgrade })
attachLiveSpeechRelay({
  upgrades,
  auth: meetingAuth,
  upstreamUrl: liveSpeechUpstreamUrl(process.env.AUDIO_SERVICE_URL || undefined)
})
server.listen(listenPort, () => {
  log('INFO', `API http://localhost:${listenPort}`, {
    env: nodeEnv,
    aiProvider: aiConfig.provider,
    aiConfigured: aiConfig.configured
  })
})
