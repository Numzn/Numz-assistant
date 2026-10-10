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

import { speechAudioConstraints } from './micUtils.js'
import { acquireCapture, createSourceMonitor, normalizeCaptureMode } from './captureSources.js'
import { safeJsonParse } from '../../utils/json.js'

const FRAME_SAMPLES = 1600 // 100ms @ 16kHz — matches the worklet's default
const SAMPLE_RATE = 16000
// How long stop() waits for the speech service to finish. It may still be decoding audio it has queued,
// then it saves the last lines and reports how many it produced; closing earlier cuts that off.
const DEFAULT_STOP_TIMEOUT_MS = 45000
const WORKLET_URL = '/worklets/pcm-capture-processor.js'
// Audio the network could not take is dropped, not queued without limit. f32le at 16 kHz is 64,000 bytes a second,
// so 4 MiB is about a minute of backlog: past that the connection is stalled, and holding more only costs memory.
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE
const DROP_REPORT_EVERY_FRAMES = 100 // tell the caller at the first drop, then every 10 s of dropped audio
const DEFAULT_MONITOR_INTERVAL_MS = 500
const MIX_GAIN = 0.7 // two sources are summed: leave headroom so loud speech on both does not clip
// How long to wait for a suspended AudioContext to start. Past this, the browser is waiting for a user gesture.
const DEFAULT_RESUME_TIMEOUT_MS = 1500

/**
 * A page that starts recording without a click (a voice command, a reconnect) can be handed an AudioContext the
 * browser keeps suspended. Its worklet then never runs: the meeting would say "Recording" and capture silence.
 * Resume it, and if the browser still holds it back, say so with a code the caller can act on.
 */
async function ensureAudioRunning(context, timeoutMs) {
  if (!context.state || context.state === 'running') return
  let timer
  try {
    await Promise.race([
      Promise.resolve(context.resume?.()),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
  } catch {
    /* judged by the state below */
  } finally {
    clearTimeout(timer)
  }
  if (context.state && context.state !== 'running') {
    const err = new Error('The browser is holding back audio until you interact with the page.')
    err.code = 'audio-context-suspended'
    throw err
  }
}

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
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  resumeTimeoutMs = DEFAULT_RESUME_TIMEOUT_MS,
  // 'microphone' (default) | 'tab' (a shared tab's or the system's audio) | 'both' (mixed). See captureSources.js.
  captureMode = 'microphone',
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  monitorIntervalMs = DEFAULT_MONITOR_INTERVAL_MS,
  sourceTiming = {},
  // true asks the browser to level the microphone (a soft or distant voice reaches a usable level).
  // Left undefined, the shared speech constraints apply (off, as the assistant's own VAD expects).
  autoGainControl = undefined,
  getDeviceId = () => ''
} = {}) {
  if (!wsUrl) throw new Error('createLiveSpeechClient requires wsUrl (ws:// or wss:// to the audio sidecar)')

  let onPartial = () => {}
  let onStabilizing = () => {}
  let onFinalSegment = () => {}
  let onError = () => {}
  let onStopped = () => {}
  let onReady = () => {}
  let onSources = () => {}
  let onDropped = () => {}

  let capture = null // the acquired sources (captureSources.js); released as one
  let monitor = null // what each source is doing (active / no-signal / ended ...)
  let audioContext = null
  let workletNode = null
  let mixNode = null
  let sourceNodes = [] // { id, node, analyser }
  let monitorTimer = null
  let droppedFrames = 0
  let ws = null
  let active = false
  let stoppedWaiters = [] // resolved when the server confirms the session is finished

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
      // The code travels with the error: the caller decides which problems end a recording (see meetingController).
      const err = new Error(`[${msg.code}] ${msg.message}`)
      err.code = typeof msg.code === 'string' ? msg.code : undefined
      if (typeof msg.segmentId === 'string') err.segmentId = msg.segmentId
      onError(err)
      return
    }
    if (type === 'stopped') {
      onStopped(msg.transcript ?? null)
      for (const resolve of stoppedWaiters.splice(0)) resolve()
    }
  }

  function stopMonitor() {
    if (monitorTimer !== null) clearInterval(monitorTimer)
    monitorTimer = null
  }

  async function teardownAudio() {
    stopMonitor()
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
    for (const entry of sourceNodes) {
      for (const node of [entry.node, entry.analyser]) {
        try {
          node?.disconnect?.()
        } catch {
          /* ignore */
        }
      }
    }
    try {
      mixNode?.disconnect?.()
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
    capture?.release()
    workletNode = null
    mixNode = null
    sourceNodes = []
    audioContext = null
    capture = null
    monitor = null
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

  function handleSourceEnded(id) {
    if (!monitor) return
    monitor.markEnded(id)
    if (active && !monitor.anyLive()) {
      const err = new Error('Every audio source has stopped (the microphone was unplugged or sharing was stopped).')
      err.code = 'capture-ended'
      onError(err)
    }
  }

  /** Reads each source's level a couple of times a second, so a silent source shows as such. */
  function startMonitor() {
    const withAnalyser = sourceNodes.filter((entry) => entry.analyser)
    if (!monitor || withAnalyser.length === 0) return
    const floats = new Float32Array(1024)
    const bytes = new Uint8Array(1024)
    const rms = (analyser) => {
      let sum = 0
      if (typeof analyser.getFloatTimeDomainData === 'function') {
        analyser.getFloatTimeDomainData(floats)
        for (let i = 0; i < floats.length; i++) sum += floats[i] * floats[i]
        return Math.sqrt(sum / floats.length)
      }
      analyser.getByteTimeDomainData?.(bytes)
      for (let i = 0; i < bytes.length; i++) sum += ((bytes[i] - 128) / 128) ** 2
      return Math.sqrt(sum / bytes.length)
    }
    monitorTimer = setInterval(() => {
      for (const entry of withAnalyser) monitor?.reportLevel(entry.id, rms(entry.analyser))
    }, monitorIntervalMs)
  }

  async function start() {
    if (active) return
    if (!isSupported()) throw new Error('Live speech capture is not supported in this browser')
    active = true

    try {
      const deviceId = typeof getDeviceId === 'function' ? getDeviceId() : ''
      droppedFrames = 0
      capture = await acquireCapture({
        mode: normalizeCaptureMode(captureMode),
        mediaDevices: navigator.mediaDevices,
        micConstraints: speechAudioConstraints({
          deviceId,
          channelCount: 1,
          ...(typeof autoGainControl === 'boolean' ? { autoGainControl } : {})
        }),
        onSourceEnded: handleSourceEnded
      })
      // stop() may have been called while a browser prompt (microphone, share picker) was open. Release what
      // was just granted instead of carrying on and leaving a source running.
      if (!active) return releaseCancelledStart()

      monitor = createSourceMonitor({
        sources: capture.sources,
        onChange: (snapshot) => onSources(snapshot),
        ...sourceTiming
      })
      onSources(monitor.snapshot())

      audioContext = new window.AudioContext({ sampleRate: SAMPLE_RATE })
      if (audioContext.sampleRate !== SAMPLE_RATE) {
        throw new Error(
          `Browser would not honor a ${SAMPLE_RATE}Hz AudioContext (got ${audioContext.sampleRate}Hz) — ` +
            'live speech capture requires an exact sample rate match with the server.'
        )
      }

      await ensureAudioRunning(audioContext, resumeTimeoutMs)
      if (!active) return releaseCancelledStart()

      await audioContext.audioWorklet.addModule(WORKLET_URL)
      if (!active) return releaseCancelledStart()
      workletNode = new window.AudioWorkletNode(audioContext, 'pcm-capture-processor', {
        processorOptions: { frameSamples: FRAME_SAMPLES }
      })
      // One recording stream: a single source goes straight to the recorder, several are summed first.
      const live = capture.sources.filter((source) => source.stream)
      if (live.length > 1 && typeof audioContext.createGain === 'function') {
        mixNode = audioContext.createGain()
        mixNode.gain.value = MIX_GAIN
        mixNode.connect(workletNode)
      }
      sourceNodes = live.map((source) => {
        const node = audioContext.createMediaStreamSource(source.stream)
        const analyser = typeof audioContext.createAnalyser === 'function' ? audioContext.createAnalyser() : null
        if (analyser) analyser.fftSize = 1024
        return { id: source.id, node, analyser }
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
        const socket = ws
        if (socket?.readyState !== WebSocket.OPEN) return
        if (socket.bufferedAmount > maxBufferedBytes) {
          // The connection is not keeping up. Say so rather than grow without bound: the transcript has a gap.
          droppedFrames += 1
          if (droppedFrames === 1 || droppedFrames % DROP_REPORT_EVERY_FRAMES === 0) {
            onDropped({ frames: droppedFrames, seconds: droppedFrames * FRAME_SECONDS })
          }
          return
        }
        socket.send(ev.data)
      }
      for (const entry of sourceNodes) {
        entry.node.connect(mixNode ?? workletNode)
        entry.analyser && entry.node.connect(entry.analyser)
      }
      startMonitor()
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

    // Stop capturing first, so no audio follows the stop message.
    await teardownAudio()

    const socket = ws
    if (socket?.readyState === WebSocket.OPEN) {
      // Wait until the speech service says it is finished ('stopped'), the connection closes, or the
      // timeout passes. Only then are all of this session's lines saved and its count reported.
      await new Promise((resolve) => {
        const timer = setTimeout(done, stopTimeoutMs)
        function done() {
          clearTimeout(timer)
          resolve()
        }
        stoppedWaiters.push(done)
        socket.addEventListener('close', done, { once: true })
        socket.send(JSON.stringify({ type: 'stop' }))
      })
    }
    stoppedWaiters = []
    try {
      socket?.close()
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
    },
    /** Called with [{ id, label, state, detail }] when a source starts, goes quiet, has no sound, or ends. */
    setOnSources(fn) {
      onSources = typeof fn === 'function' ? fn : () => {}
    },
    /** Called with { frames, seconds } when audio had to be dropped because the connection could not keep up. */
    setOnDropped(fn) {
      onDropped = typeof fn === 'function' ? fn : () => {}
    }
  }
}
