import express, { Router } from 'express'
import { generateResponse, streamResponse } from '../services/aiService.js'
import {
  checkAudioServiceHealth,
  transcribeAudio,
  transcribeAudioLocalWithMetrics,
  resolveSttBackend
} from '../services/sttService.js'
import { ASSISTANT_STATES, isValidAssistantState, sessionService } from '../sessions/sessionService.js'
import { createSseStream } from '../transport/sse.js'
import { createAssistantOrchestrator } from '../orchestrator/assistantOrchestrator.js'

export const assistantRouter = Router()

const legacySession = sessionService.createSession({ source: 'legacy' })
const orchestrator = createAssistantOrchestrator()

function serializeSession(session) {
  return {
    sessionId: session.id,
    state: session.state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }
}

function getSessionId(req) {
  return (
    req.params?.sessionId ||
    req.body?.sessionId ||
    req.headers['x-assistant-session-id']?.toString() ||
    legacySession.id
  )
}

assistantRouter.post('/sessions', (req, res) => {
  const metadata = typeof req.body?.metadata === 'object' && req.body.metadata !== null
    ? req.body.metadata
    : {}
  const session = sessionService.createSession(metadata)
  res.status(201).json(serializeSession(session))
})

assistantRouter.get('/state', (_req, res) => {
  res.json(serializeSession(legacySession))
})

assistantRouter.patch('/state', (req, res) => {
  const nextState = req.body?.state
  if (typeof nextState !== 'string') {
    return res.status(400).json({
      error: 'Body must include string "state"',
      requestId: req.id
    })
  }
  if (!isValidAssistantState(nextState)) {
    return res.status(400).json({
      error: `Invalid state: ${nextState}`,
      requestId: req.id
    })
  }
  const session = sessionService.setState(legacySession.id, nextState)
  res.json(serializeSession(session))
})

assistantRouter.get('/sessions/:sessionId/state', (req, res) => {
  const session = sessionService.getSession(req.params.sessionId)
  if (!session) {
    return res.status(404).json({ error: 'Session not found', requestId: req.id })
  }
  res.json(serializeSession(session))
})

assistantRouter.patch('/sessions/:sessionId/state', (req, res) => {
  const nextState = req.body?.state
  if (typeof nextState !== 'string') {
    return res.status(400).json({
      error: 'Body must include string "state"',
      requestId: req.id
    })
  }
  if (!isValidAssistantState(nextState)) {
    return res.status(400).json({
      error: `Invalid state: ${nextState}`,
      requestId: req.id
    })
  }
  const session = sessionService.setState(req.params.sessionId, nextState)
  res.json(serializeSession(session))
})

async function handleChat(req, res, next) {
  try {
    const message = req.body?.message
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'Body must include non-empty string "message"',
        requestId: req.id
      })
    }

    const session = sessionService.getOrCreateSession(getSessionId(req))
    const userMessage = { role: 'user', content: message.trim() }
    sessionService.appendMessage(session.id, userMessage)

    const messages = session.messages.map(({ role, content }) => ({ role, content }))
    const reply = await generateResponse(messages)
    sessionService.appendMessage(session.id, { role: 'assistant', content: reply })

    res.json({ reply, sessionId: session.id })
  } catch (err) {
    next(err)
  }
}

assistantRouter.post('/chat', handleChat)
assistantRouter.post('/sessions/:sessionId/chat', handleChat)

assistantRouter.get('/audio-health', async (req, res, next) => {
  try {
    const health = await checkAudioServiceHealth({ force: req.query.force === '1' })
    res.json({ ...health, requestId: req.id })
  } catch (err) {
    next(err)
  }
})

assistantRouter.post(
  '/stt',
  express.raw({ type: 'application/octet-stream', limit: '12mb' }),
  async (req, res, next) => {
    try {
      const audioBuffer = req.body
      if (!audioBuffer || !(audioBuffer instanceof Buffer) || audioBuffer.length === 0) {
        return res.status(400).json({ error: 'Missing audio body', requestId: req.id })
      }

      const mimeType = req.headers['x-audio-mime']?.toString() || 'audio/webm'
      const language = req.headers['x-stt-lang']?.toString() || ''
      const prompt = req.headers['x-stt-prompt']?.toString() || ''
      const backend = req.headers['x-stt-backend']?.toString() || ''

      if (resolveSttBackend({ headerBackend: backend }) === 'local') {
        const result = await transcribeAudioLocalWithMetrics({
          audioBuffer,
          mimeType,
          language,
          prompt
        })
        return res.json({ text: result.text, ...result.metrics, requestId: req.id })
      }

      const text = await transcribeAudio({
        audioBuffer,
        mimeType,
        language,
        prompt,
        backend
      })

      res.json({ text, requestId: req.id })
    } catch (err) {
      if (err?.code === 'no-speech') {
        return res.json({ text: '', error: 'no-speech', requestId: req.id })
      }
      if (err?.code === 'audio-service-offline') {
        return res.status(503).json({
          error: err.message,
          text: '',
          requestId: req.id
        })
      }
      next(err)
    }
  }
)

async function handleChatStream(req, res, next) {
  const message = req.body?.message
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      error: 'Body must include non-empty string "message"',
      requestId: req.id
    })
  }

  const stream = createSseStream(req, res)

  try {
    const sessionId = getSessionId(req)
    await orchestrator.runStreamingTurn({
      sessionId,
      message,
      requestId: req.id,
      emit(eventType, data) {
        if (stream.closed) {
          try {
            const existing = sessionService.getOrCreateSession(sessionId)
            sessionService.setState(existing.id, ASSISTANT_STATES.INTERRUPTED)
          } catch {
            // ignore
          }
          return false
        }
        return stream.send(eventType, data)
      }
    })
    stream.end()
  } catch (err) {
    try {
      stream.send('AI_RESPONSE_ERROR', {
        error: err.statusCode && err.statusCode < 500 ? err.message : 'Internal Server Error',
        requestId: req.id
      })
      stream.end()
    } catch {
      // Express will handle the original error if headers were not sent.
    }
    if (!res.headersSent) next(err)
  }
}

assistantRouter.post('/chat/stream', handleChatStream)
assistantRouter.post('/sessions/:sessionId/chat/stream', handleChatStream)
