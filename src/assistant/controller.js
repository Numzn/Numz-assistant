import { STATES } from './stateMachine.js'

export function createAssistantController({ stateMachine, client, eventBus }) {
  let activeAbort = null

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function syncServerState(state) {
    await client.setState(state)
  }

  function isLocalGenerationState(state) {
    return (
      state === STATES.THINKING ||
      state === STATES.RETRIEVING_MEMORY ||
      state === STATES.TOOL_EXECUTION ||
      state === STATES.GENERATING
    )
  }

  async function requestReplyWithStream(text) {
    if (typeof client.streamMessage !== 'function') return null

    activeAbort?.abort()
    activeAbort = new AbortController()
    let finalReply = ''
    let tokenSeen = false

    try {
      let message
      try {
        message = await client.streamMessage(text, {
          signal: activeAbort.signal,
          onEvent({ event, data }) {
            eventBus?.emit?.('assistant:stream-event', { event, data })

            if (event === 'token') tokenSeen = true

            if (event === 'state' && isLocalGenerationState(data?.state)) {
              // Stream transports can deliver duplicate / out-of-order state events.
              // Never let an invalid transition crash streaming; force-sync as needed.
              try {
                if (stateMachine.canTransition(data.state)) {
                  stateMachine.setState(data.state)
                } else {
                  stateMachine.setState(data.state, { force: true, source: 'stream' })
                }
              } catch (err) {
                console.warn('[assistant] ignoring invalid stream state', {
                  from: stateMachine.getState?.(),
                  to: data?.state,
                  err
                })
              }
            }

            if (event === 'token') {
              eventBus?.emit?.('assistant:token', data)
            }

            if (event === 'message' && typeof data?.reply === 'string') {
              finalReply = data.reply
            }
          }
        })
      } catch (err) {
        // A deliberate interrupt() abort is a normal, expected cancellation
        // — let the outer catch's existing AbortError handling deal with it
        // unchanged. Anything else that fails after tokens already streamed
        // (and were likely already spoken) must not look like "no reply
        // yet, safe to retry" to the caller below.
        if (err?.name !== 'AbortError' && tokenSeen) {
          const wrapped = new Error('Stream failed after producing partial output')
          wrapped.code = 'partial-stream-no-final'
          throw wrapped
        }
        throw err
      }

      const resolved = typeof message?.reply === 'string' ? message.reply : finalReply
      if (!resolved && tokenSeen) {
        // Tokens streamed (and were likely already spoken incrementally by
        // the voice UI) but no final reply text ever arrived — don't let
        // the caller retry via a fresh request: that would regenerate and
        // re-speak the same turn from scratch.
        const err = new Error('Stream ended without a final reply after producing partial output')
        err.code = 'partial-stream-no-final'
        throw err
      }
      return resolved
    } finally {
      activeAbort = null
    }
  }

  return {
    async init() {
      // In dev, the web server can come up before the API proxy target.
      // Treat init as "best effort" and retry briefly to avoid noisy console errors.
      const maxAttempts = 8
      let lastErr

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          if (!client.getSessionId?.()) {
            const session = await client.createSession?.({
              client: 'browser',
              transport: 'http'
            })
            eventBus?.emit?.('session:created', session)
          }
          const { state } = await client.getState()
          if (state && Object.values(STATES).includes(state)) {
            stateMachine.setState(state)
          }
          return
        } catch (err) {
          lastErr = err
          // Backoff: 80ms, 140ms, 220ms, ... up to ~1s
          const delayMs = Math.min(80 * Math.pow(1.35, attempt), 1000)
          await sleep(delayMs)
        }
      }

      console.warn('[assistant] init: API not ready (continuing in local state)', lastErr)
    },

    async setListening() {
      stateMachine.setState(STATES.LISTENING)
      await syncServerState(STATES.LISTENING)
    },

    async setTranscribing() {
      stateMachine.setState(STATES.TRANSCRIBING)
      await syncServerState(STATES.TRANSCRIBING)
    },

    async setThinking() {
      stateMachine.setState(STATES.THINKING)
      await syncServerState(STATES.THINKING)
    },

    async setProcessing() {
      stateMachine.setState(STATES.PROCESSING)
      await syncServerState(STATES.PROCESSING)
    },

    async setSpeaking() {
      stateMachine.setState(STATES.SPEAKING)
      await syncServerState(STATES.SPEAKING)
    },

    async setIdle() {
      stateMachine.setState(STATES.IDLE)
      await syncServerState(STATES.IDLE)
    },

    async setError() {
      stateMachine.setState(STATES.ERROR)
      try {
        await syncServerState(STATES.ERROR)
      } catch {
        /* server may reject ERROR if not in valid set — backend includes ERROR */
      }
    },

    async interrupt() {
      activeAbort?.abort()
      activeAbort = null
      eventBus?.emit?.('turn:interrupt', {
        sessionId: client.getSessionId?.() ?? null
      })

      try {
        stateMachine.setState(STATES.INTERRUPTED)
        await syncServerState(STATES.INTERRUPTED)
      } catch (err) {
        console.warn('[assistant] interrupt state sync failed', err)
      }
    },

    /**
     * Runs LISTENING -> PROCESSING and returns the assistant reply text.
     * SPEAKING/IDLE is intentionally left to the caller (e.g. TTS playback).
     */
    async requestReply(text) {
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (!trimmed) return null

      try {
        eventBus?.emit?.('turn:start', {
          inputType: 'text',
          text: trimmed,
          sessionId: client.getSessionId?.() ?? null
        })
        await this.setListening()
        await this.setProcessing()
        eventBus?.emit?.('ai:request', {
          text: trimmed,
          sessionId: client.getSessionId?.() ?? null
        })
        let reply = null
        let skipFallback = false
        try {
          reply = await requestReplyWithStream(trimmed)
        } catch (err) {
          if (err?.name === 'AbortError') {
            await this.interrupt()
            return null
          }

          if (err?.code === 'partial-stream-no-final') {
            console.warn('[assistant] stream produced partial output but no final reply; not retrying to avoid duplicate speech', err)
            skipFallback = true
          } else {
            console.warn('[assistant] stream failed; falling back to JSON chat', err)
          }
        }

        if (!reply && !skipFallback) {
          const data = await client.sendMessage(trimmed)
          reply = data.reply
        }

        eventBus?.emit?.('ai:response', {
          reply,
          sessionId: client.getSessionId?.() ?? null
        })
        return typeof reply === 'string' ? reply : null
      } catch (err) {
        console.error('[assistant] requestReply', err)
        eventBus?.emit?.('error:recoverable', {
          source: 'assistant:requestReply',
          error: err
        })
        await this.setError()
        return null
      }
    },

    async handleUserInput(text) {
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (!trimmed) return

      try {
        const reply = await this.requestReply(trimmed)
        if (!reply) return
        await this.setSpeaking()
        await this.setIdle()
      } catch (err) {
        console.error('[assistant] handleUserInput', err)
        await this.setError()
      }
    }
  }
}
