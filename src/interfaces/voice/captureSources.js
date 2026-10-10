/**
 * Where a meeting's audio comes from, and whether each source is really delivering it.
 *
 * Three modes:
 *   microphone  getUserMedia                    the default; works from a voice command too
 *   tab         getDisplayMedia (audio only)    a browser tab's audio, or the whole system's where the browser
 *                                               offers it. It needs a click and the user's choice in the
 *                                               browser's picker: a page cannot capture sound silently.
 *   both        the two together               one mixed stream. Where one is refused the other carries on, and
 *                                               the refused one is reported as not recorded, never hidden.
 *
 * Every source is checked when it arrives (a live audio track) and while it runs (it can end: a microphone is
 * unplugged, "Stop sharing" is pressed), and every track is released by one deterministic call.
 *
 * Nothing here knows about the speech service. The caller feeds the streams into its audio graph.
 */

export const CAPTURE_MODES = Object.freeze(['microphone', 'tab', 'both'])

const LABELS = { microphone: 'Microphone', tab: 'Tab or system audio' }

const NO_AUDIO_MESSAGE =
  'The shared tab or screen has no audio. Choose a browser tab (or, where the browser offers it, the whole ' +
  'screen with system audio) and tick "Share audio" in the browser\'s picker.'
const CANCELLED_MESSAGE = 'Sharing the tab or screen audio was cancelled or blocked.'

export function normalizeCaptureMode(mode) {
  return CAPTURE_MODES.includes(mode) ? mode : 'microphone'
}

/** Whether this browser offers what the mode needs. -> { ok, reason? } */
export function isCaptureSupported(mode, mediaDevices = globalThis?.navigator?.mediaDevices) {
  const wanted = normalizeCaptureMode(mode)
  if (wanted !== 'tab' && typeof mediaDevices?.getUserMedia !== 'function') {
    return { ok: false, reason: 'This browser cannot capture the microphone.' }
  }
  if (wanted !== 'microphone' && typeof mediaDevices?.getDisplayMedia !== 'function') {
    return {
      ok: false,
      reason:
        'This browser cannot share a tab or screen audio. Use Chrome or Edge on a desktop, or record with the microphone only.'
    }
  }
  return { ok: true }
}

function captureError(code, message, cause) {
  const err = new Error(message)
  err.name = 'CaptureError'
  err.code = code
  if (cause) err.cause = cause
  return err
}

function audioTracksOf(stream) {
  if (typeof stream?.getAudioTracks === 'function') return stream.getAudioTracks()
  return (stream?.getTracks?.() ?? []).filter((track) => track.kind === 'audio')
}

function stopAll(stream) {
  for (const track of stream?.getTracks?.() ?? []) {
    if (track.readyState === 'ended') continue // already stopped or ended
    try {
      track.stop()
    } catch {
      /* already gone */
    }
  }
}

/** A stream with at least one live audio track, or a CaptureError (the stream is released). */
function requireLiveAudio(stream) {
  if (audioTracksOf(stream).some((track) => track.readyState === 'live')) return stream
  stopAll(stream)
  throw captureError('capture-unavailable', 'The audio source ended as soon as it started.')
}

async function acquireDisplay(mediaDevices) {
  let stream
  try {
    stream = await mediaDevices.getDisplayMedia({
      // Browsers only offer "share audio" alongside a video request; the picture is dropped below.
      video: true,
      // Remote audio is not speech picked up by a microphone: leave it unprocessed.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include'
    })
  } catch (err) {
    throw captureError('display-capture-failed', CANCELLED_MESSAGE, err)
  }
  for (const track of stream.getVideoTracks?.() ?? []) track.stop()
  if (audioTracksOf(stream).length === 0) {
    stopAll(stream)
    throw captureError('display-capture-no-audio', NO_AUDIO_MESSAGE)
  }
  return requireLiveAudio(stream)
}

async function acquireMicrophone(mediaDevices, micConstraints) {
  const stream = await mediaDevices.getUserMedia({ audio: micConstraints, video: false })
  return requireLiveAudio(stream)
}

function describeProblem(err) {
  if (err?.code === 'display-capture-no-audio') return NO_AUDIO_MESSAGE
  if (err?.code === 'display-capture-failed') return CANCELLED_MESSAGE
  const name = err?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The microphone is blocked in the browser.'
  if (name === 'NotFoundError') return 'No microphone was found.'
  return String(err?.message || 'The source could not be started.')
}

/**
 * -> { mode, sources: [{ id, label, state: 'active' | 'unavailable', detail?, stream? }], streams, release() }
 * Throws when no source at all could be started (the microphone's error in preference, with its browser name
 * intact, so a caller can tell "blocked" from "missing").
 */
export async function acquireCapture({
  mode = 'microphone',
  mediaDevices = globalThis?.navigator?.mediaDevices,
  micConstraints = {},
  onSourceEnded = () => {}
} = {}) {
  const wanted = normalizeCaptureMode(mode)
  const support = isCaptureSupported(wanted, mediaDevices)
  if (!support.ok) throw captureError('capture-unsupported', support.reason)

  let displayStream = null
  let micStream = null
  let displayError = null
  let micError = null

  // The picker needs the click that started the meeting; the microphone does not. Ask for it first, before
  // another prompt can use up the browser's short window for a user gesture.
  if (wanted !== 'microphone') {
    try {
      displayStream = await acquireDisplay(mediaDevices)
    } catch (err) {
      displayError = err
    }
  }
  if (wanted !== 'tab') {
    try {
      micStream = await acquireMicrophone(mediaDevices, micConstraints)
    } catch (err) {
      micError = err
    }
  }

  if (!displayStream && !micStream) throw micError ?? displayError

  const sources = []
  if (wanted !== 'tab') {
    sources.push(
      micStream
        ? { id: 'microphone', label: LABELS.microphone, state: 'active', stream: micStream }
        : { id: 'microphone', label: LABELS.microphone, state: 'unavailable', detail: describeProblem(micError) }
    )
  }
  if (wanted !== 'microphone') {
    sources.push(
      displayStream
        ? { id: 'tab', label: LABELS.tab, state: 'active', stream: displayStream }
        : { id: 'tab', label: LABELS.tab, state: 'unavailable', detail: describeProblem(displayError) }
    )
  }

  let released = false
  const listeners = []
  for (const source of sources) {
    if (!source.stream) continue
    for (const track of audioTracksOf(source.stream)) {
      const handler = () => {
        if (!released) onSourceEnded(source.id)
      }
      track.addEventListener?.('ended', handler)
      listeners.push({ track, handler })
    }
  }

  return {
    mode: wanted,
    sources,
    streams: sources.filter((source) => source.stream).map((source) => source.stream),
    release() {
      if (released) return
      released = true
      for (const { track, handler } of listeners) track.removeEventListener?.('ended', handler)
      for (const source of sources) stopAll(source.stream)
    }
  }
}

/**
 * Tracks what each source is doing, for the indicators:
 *   active       sound was heard recently
 *   no-signal    NOTHING has been heard since the start (a muted microphone, the wrong device, a tab that plays
 *                nothing). This is the failure that otherwise looks like "Recording" with an empty transcript.
 *   quiet        sound was heard earlier, none for a while (a pause; informational)
 *   ended        the browser ended the source (final)
 *   unavailable  it was asked for and refused (final; not being recorded)
 * onChange receives the whole snapshot, and only when something changed.
 */
export function createSourceMonitor({
  sources,
  onChange = () => {},
  noSignalAfterMs = 8000,
  quietAfterMs = 20000,
  signalThreshold = 1e-4,
  now = () => Date.now()
}) {
  const startedAt = now()
  const entries = new Map(
    sources.map((source) => [
      source.id,
      { id: source.id, label: source.label, state: source.state, detail: source.detail ?? '', lastSignalAt: null }
    ])
  )
  const FINAL = new Set(['ended', 'unavailable'])

  function snapshot() {
    return [...entries.values()].map(({ id, label, state, detail }) => ({ id, label, state, detail }))
  }

  function setState(entry, state) {
    if (entry.state === state) return
    entry.state = state
    onChange(snapshot())
  }

  return {
    snapshot,

    /** level: the RMS of the latest audio from that source, 0..1 */
    reportLevel(id, level) {
      const entry = entries.get(id)
      if (!entry || FINAL.has(entry.state)) return
      const t = now()
      if (level >= signalThreshold) {
        entry.lastSignalAt = t
        setState(entry, 'active')
      } else if (entry.lastSignalAt === null) {
        if (t - startedAt >= noSignalAfterMs) setState(entry, 'no-signal')
      } else if (t - entry.lastSignalAt >= quietAfterMs) {
        setState(entry, 'quiet')
      }
    },

    markEnded(id) {
      const entry = entries.get(id)
      if (!entry || entry.state === 'ended') return
      entry.detail = entry.detail || 'The browser ended this source.'
      entry.state = 'ended'
      onChange(snapshot())
    },

    anyLive() {
      return [...entries.values()].some((entry) => !FINAL.has(entry.state))
    }
  }
}
