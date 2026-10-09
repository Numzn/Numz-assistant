/**
 * Browser client for the live Speech Intelligence transport
 * (audio/live_speech_ws.py). Captures real microphone audio as raw 16kHz
 * mono float32 PCM via an AudioWorklet (not MediaRecorder — MediaRecorder
 * only produces encoded containers and this app's existing MediaRecorder
 * path (voiceInputLocal.js) intentionally buffers a whole utterance before
 * sending, which is right for batch STT but defeats true low-latency
 * partial/stabilizing/final streaming), and streams it over a dedicated
 * WebSocket connection straight to the audio sidecar.
 *
 * Not wired into the existing voice orchestrator / mic button. The meeting
 * panel (src/interfaces/meeting/) uses it for meetings; public/live-speech-test.html
 * is a bare manual test harness (not a product UI).
 *
 * Format contract (must match audio/live_speech_ws.py exactly):
 *   16000 Hz, mono, 32-bit float PCM, little-endian, raw frames.
 */

import { speechAudioConstraints, stopTracks } from './micUtils.js'
import { safeJsonParse } from '../../utils/json.js'

const FRAME_SAMPLES = 1600 // 100ms @ 16kHz — matches the worklet's default
const SAMPLE_RATE = 16000
const WORKLET_URL = '/worklets/pcm-capture-processor.js'

/** Whether this page can capture live audio at all (secure context, AudioWorklet, WebSocket). */
export function isLiveSpeechSupported() {
  const w = globalThis?.window
  return Boolean(
    globalThis?.navigator?.mediaDevices?.getUserMedia &&
      w?.AudioContext &&
      w?.AudioWorkletNode &&
      w?.WebSocket
  )
}

/**
 * meetingId + meetingTicket (both optional, together): persist this session's final segments
 * to a meeting. The ticket is scoped to that one meeting (it comes from the meeting launch or from
 * an operator); the browser never holds the admin token. Without them the session is standalone.
 *
 * wsProtocols: WebSocket subprotocols to offer. The server's live-speech relay takes the ticket this
 * way ([numz.meeting-ticket.v1, token]) because a browser WebSocket cannot send headers and a ticket
 * must not sit in a URL.
 */
export function createLiveSpeechClient({
  wsUrl,
  language = '',
  saveRecording = false,
  reprocessOnStop = false,
  meetingId = '',
  meetingTicket = '',
  wsProtocols = [],
  getDeviceId = () => ''
} = {}) {
  if (!wsUrl) throw new Error('createLiveSpeechClient requires wsUrl (ws:// or wss:// to the audio sidecar)')

  let onPartial = () => {}
  let onStabilizing = () => {}
  let onFinalSegment = () => {}
  let onError = () => {}
  let onStopped = () => {}
  let onReady = () => {}

  let stream = null
  let audioContext = null
  let workletNode = null
  let sourceNode = null
  let ws = null
  let active = false

  const isSupported = isLiveSpeechSupported

  function handleServerMessage(ev) {
    const parsed = safeJsonParse(String(ev.data ?? ''))
    if (!parsed.ok) return
    const msg = parsed.value
    const type = msg?.type

    if (type === 'ready') {
      onReady({ sessionId: msg.sessionId, meetingId: msg.meetingId ?? null, persistence: msg.persistence ?? null })
      return
    }
    if (type === 'transcript') {
      if (msg.state === 'PARTIAL') onPartial(msg.text ?? '')
      else if (msg.state === 'STABILIZING') onStabilizing(msg.text ?? '')
      else if (msg.state === 'FINAL') onFinalSegment(msg.segment ?? null, msg.persisted ?? null)
      return
    }
    if (type === 'error') {
      onError(new Error(`[${msg.code}] ${msg.message}`))
      return
    }
    if (type === 'stopped') {
      onStopped(msg.transcript ?? null)
    }
  }

  async function teardownAudio() {
    try {
      workletNode?.port?.close?.()
    } catch {
      /* ignore */
    }
    try {
      workletNode?.disconnect?.()
    } catch {
      /* ignore */
    }
    try {
      sourceNode?.disconnect?.()
    } catch {
      /* ignore */
    }
    if (audioContext) {
      try {
        await audioContext.close()
      } catch {
        /* ignore */
      }
    }
    stopTracks(stream)
    workletNode = null
    sourceNode = null
    audioContext = null
    stream = null
  }

  /** stop() ran while start() was still waiting (permission prompt, worklet load, socket open). */
  async function releaseCancelledStart() {
    await teardownAudio()
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    ws = null
  }

  async function start() {
    if (active) return
    if (!isSupported()) throw new Error('Live speech capture is not supported in this browser')
    active = true

    try {
      const deviceId = typeof getDeviceId === 'function' ? getDeviceId() : ''
      stream = await navigator.mediaDevices.getUserMedia({
        audio: speechAudioConstraints({ deviceId, channelCount: 1 }),
        video: false
      })
      // stop() may have been called while the browser's permission prompt was open. Release what was
      // just granted instead of carrying on and leaving the microphone running.
      if (!active) return releaseCancelledStart()

      audioContext = new window.AudioContext({ sampleRate: SAMPLE_RATE })
      if (audioContext.sampleRate !== SAMPLE_RATE) {
        throw new Error(
          `Browser would not honor a ${SAMPLE_RATE}Hz AudioContext (got ${audioContext.sampleRate}Hz) — ` +
            'live speech capture requires an exact sample rate match with the server.'
        )
      }

      await audioContext.audioWorklet.addModule(WORKLET_URL)
      if (!active) return releaseCancelledStart()
      sourceNode = audioContext.createMediaStreamSource(stream)
      workletNode = new window.AudioWorkletNode(audioContext, 'pcm-capture-processor', {
        processorOptions: { frameSamples: FRAME_SAMPLES }
      })

      ws = wsProtocols.length ? new WebSocket(wsUrl, wsProtocols) : new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'

      await new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true })
        ws.addEventListener('error', () => reject(new Error('WebSocket connection error')), { once: true })
      })
      if (!active) return releaseCancelledStart()

      ws.addEventListener('message', handleServerMessage)
      ws.addEventListener('close', () => {
        if (active) onError(new Error('Live speech connection closed unexpectedly'))
      })

      ws.send(
        JSON.stringify({
          type: 'start',
          sampleRate: SAMPLE_RATE,
          channels: 1,
          format: 'f32le',
          language,
          saveRecording,
          reprocessOnStop,
          ...(meetingId ? { meetingId, meetingTicket } : {})
        })
      )

      workletNode.port.onmessage = (ev) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(ev.data)
      }
      sourceNode.connect(workletNode)
    } catch (err) {
      active = false
      await teardownAudio()
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      ws = null
      onError(err)
      throw err
    }
  }

  function pause() {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pause' }))
  }

  function resume() {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resume' }))
  }

  async function stop() {
    if (!active) return
    active = false

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }))
      // Give the server a moment to flush + reply with 'stopped' before closing.
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    await teardownAudio()
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    ws = null
  }

  return {
    isSupported,
    start,
    stop,
    pause,
    resume,
    setOnReady(fn) {
      onReady = typeof fn === 'function' ? fn : () => {}
    },
    setOnPartial(fn) {
      onPartial = typeof fn === 'function' ? fn : () => {}
    },
    setOnStabilizing(fn) {
      onStabilizing = typeof fn === 'function' ? fn : () => {}
    },
    setOnFinalSegment(fn) {
      onFinalSegment = typeof fn === 'function' ? fn : () => {}
    },
    setOnError(fn) {
      onError = typeof fn === 'function' ? fn : () => {}
    },
    setOnStopped(fn) {
      onStopped = typeof fn === 'function' ? fn : () => {}
    }
  }
}
