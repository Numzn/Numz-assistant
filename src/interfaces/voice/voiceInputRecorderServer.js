function createUnsupportedError() {
  return new Error('MediaRecorder/getUserMedia is not supported in this browser')
}

function getMediaDevices() {
  return globalThis?.navigator?.mediaDevices ?? null
}

function pickMimeType() {
  const w = globalThis?.window
  const MR = w?.MediaRecorder
  if (!MR?.isTypeSupported) return ''
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ]
  return candidates.find((t) => MR.isTypeSupported(t)) ?? ''
}

async function parseJson(res) {
  const text = await res.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * Records microphone audio and sends it to the backend STT endpoint.
 * Intended to be more accurate than browser SpeechRecognition.
 */
export function createVoiceInputRecorderServer({
  endpoint = '/api/v1/assistant/stt',
  lang = 'en-US',
  prompt = '',
  sttBackend = '',
  getDeviceId = () => ''
} = {}) {
  /** @type {(text: string) => void} */
  let onPartial = () => {}
  /** @type {(text: string) => void} */
  let onFinal = () => {}
  /** @type {(err: unknown) => void} */
  let onError = () => {}

  /** @type {MediaRecorder | null} */
  let recorder = null
  /** @type {MediaStream | null} */
  let stream = null
  let active = false
  let chunks = []

  function stopTracks(s) {
    for (const t of s?.getTracks?.() ?? []) t.stop()
  }

  async function ensureStream() {
    const mediaDevices = getMediaDevices()
    if (!mediaDevices?.getUserMedia) throw createUnsupportedError()

    const deviceId = typeof getDeviceId === 'function' ? getDeviceId() : ''
    const audio = deviceId ? { deviceId: { exact: deviceId } } : true
    return await mediaDevices.getUserMedia({ audio, video: false })
  }

  async function transcribe(blob) {
    const buf = await blob.arrayBuffer()
    const headers = {
      'Content-Type': 'application/octet-stream',
      'x-audio-mime': blob.type || 'audio/webm',
      'x-stt-lang': lang,
      'x-stt-prompt': prompt
    }
    if (sttBackend) headers['x-stt-backend'] = sttBackend

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: buf
    })

    const data = await parseJson(res)
    if (!res.ok) {
      throw new Error(data.error ?? `STT failed: ${res.status}`)
    }
    if (data.error === 'no-speech') {
      const err = new Error('no-speech')
      err.error = 'no-speech'
      throw err
    }
    return String(data.text ?? '').trim()
  }

  function isSupported() {
    const w = globalThis?.window
    return Boolean(getMediaDevices()?.getUserMedia) && typeof w?.MediaRecorder === 'function'
  }

  return {
    isSupported,

    setOnPartial(fn) {
      onPartial = typeof fn === 'function' ? fn : () => {}
    },

    setOnFinal(fn) {
      onFinal = typeof fn === 'function' ? fn : () => {}
    },

    setOnError(fn) {
      onError = typeof fn === 'function' ? fn : () => {}
    },

    async start() {
      if (active) return
      if (!isSupported()) throw createUnsupportedError()

      active = true
      chunks = []
      onPartial('') // keep interface parity (no interim for recorder mode)

      try {
        stream = await ensureStream()
        const mimeType = pickMimeType()
        recorder = new globalThis.window.MediaRecorder(stream, mimeType ? { mimeType } : undefined)

        recorder.ondataavailable = (ev) => {
          if (!ev?.data || ev.data.size === 0) return
          chunks.push(ev.data)
        }

        recorder.onerror = (ev) => {
          onError(ev?.error ?? ev)
        }

        recorder.onstop = async () => {
          try {
            if (!chunks.length) return
            const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
            const text = await transcribe(blob)
            if (text) onFinal(text)
            else onError({ error: 'no-speech' })
          } catch (err) {
            onError(err)
          } finally {
            chunks = []
            stopTracks(stream)
            stream = null
            recorder = null
          }
        }

        recorder.start()
      } catch (err) {
        active = false
        stopTracks(stream)
        stream = null
        recorder = null
        onError(err)
      }
    },

    stop() {
      active = false
      try {
        recorder?.stop()
      } catch (err) {
        onError(err)
      }
    }
  }
}

