import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { assistantRouter } from './routes/assistant.js'
import { attachSocketServer } from './websocket/socketServer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const nodeEnv = process.env.NODE_ENV ?? 'development'
const isProd = nodeEnv === 'production'
const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173'

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
      origin: isProd ? true : corsOrigin,
      credentials: true
    })
  )
  app.use(express.json({ limit: '256kb' }))

  app.get('/api/v1/health', (_req, res) => {
    res.json({ ok: true, service: 'ai-assistant-api' })
  })

  app.use('/api/v1/assistant', assistantRouter)

  if (isProd) {
    const dist = path.join(rootDir, 'dist')
    app.use(express.static(dist, { index: false }))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next()
      res.sendFile(path.join(dist, 'index.html'))
    })
  }

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not Found', requestId: req.id })
  })

  app.use((err, req, res, _next) => {
    const status = err.statusCode ?? err.status ?? 500
    const message = status >= 500 ? 'Internal Server Error' : err.message ?? 'Error'
    if (status >= 500) console.error(err)
    res.status(status).json({ error: message, requestId: req.id })
  })

  return app
}

const listenPort = Number.isFinite(port) ? port : 3001
const app = createApp()
const server = http.createServer(app)
attachSocketServer(server)
server.listen(listenPort, () => {
  log('INFO', `API http://localhost:${listenPort}`, { env: nodeEnv })
})
