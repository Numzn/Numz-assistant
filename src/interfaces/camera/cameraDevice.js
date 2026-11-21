import { toGray } from './frameAnalysis.js'

/**
 * The phone's camera as the Smart Camera's state machine sees it (see the `device` contract in cameraSession.js):
 *
 *   start()                  asks for the camera (the back one if there is one) and shows it in the preview
 *   stop()                   releases it: the browser's camera light goes out
 *   sampleFrame()            a small grayscale frame for the on-phone checks, or null before the camera is ready
 *   captureImage(options)    one JPEG of what the camera sees now; nothing is kept
 *
 * plus a few camera controls (switch camera, torch) and a notice if the camera is taken away. The camera opens only
 * when start() is called, which the page calls only from a button the person pressed.
 *
 * Browser-only (video, canvas, getUserMedia): checked in a real browser, not in the unit tests.
 */

export const SAMPLE_WIDTH = 160
export const SAMPLE_HEIGHT = 120
const CAPTURE_DEFAULTS = { maxEdge: 1568, quality: 0.85 }

function problem(name, message) {
  return Object.assign(new Error(message), { name })
}

export function createCameraDevice({ video, doc = document, nav = navigator, secure = () => globalThis.isSecureContext !== false } = {}) {
  const sampler = doc.createElement('canvas')
  sampler.width = SAMPLE_WIDTH
  sampler.height = SAMPLE_HEIGHT
  const samplerContext = sampler.getContext('2d', { willReadFrequently: true })
  const grabber = doc.createElement('canvas')

  let stream = null
  let facing = 'environment'
  const lostListeners = new Set()

  const track = () => stream?.getVideoTracks?.()[0] ?? null

  async function open() {
    stream = await nav.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    })
    const [videoTrack] = stream.getVideoTracks()
    videoTrack?.addEventListener('ended', () => {
      // Taken away from under us (permission withdrawn, another app, unplugged): say so, and let go.
      if (stream && track() === videoTrack) {
        release()
        for (const listener of lostListeners) listener()
      }
    })
    video.srcObject = stream
    await video.play()
    if (!video.videoWidth) {
      await new Promise((resolve) => {
        video.addEventListener('loadedmetadata', resolve, { once: true })
        setTimeout(resolve, 3000)
      })
    }
  }

  function release() {
    for (const t of stream?.getTracks?.() ?? []) t.stop()
    stream = null
    video.srcObject = null
  }

  return {
    async start() {
      if (!nav.mediaDevices?.getUserMedia) {
        throw secure() ? problem('NotFoundError', 'No camera API') : problem('InsecureContextError', 'The camera needs a secure connection')
      }
      if (stream) return
      await open()
    },

    stop: release,

    sampleFrame() {
      if (!stream || video.readyState < 2 || !video.videoWidth) return null
      samplerContext.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
      const { data } = samplerContext.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
      return { gray: toGray(data, SAMPLE_WIDTH, SAMPLE_HEIGHT), width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT }
    },

    async captureImage({ maxEdge = CAPTURE_DEFAULTS.maxEdge, quality = CAPTURE_DEFAULTS.quality } = {}) {
      if (!stream || !video.videoWidth) throw problem('NotReadableError', 'The camera is not ready')
      const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight))
      grabber.width = Math.max(1, Math.round(video.videoWidth * scale))
      grabber.height = Math.max(1, Math.round(video.videoHeight * scale))
      grabber.getContext('2d').drawImage(video, 0, 0, grabber.width, grabber.height)
      const blob = await new Promise((resolve) => grabber.toBlob(resolve, 'image/jpeg', quality))
      if (!blob) throw problem('EncodingError', 'The picture could not be encoded')
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: 'image/jpeg' }
    },

    /** What this camera can do: { canSwitch, canTorch }. Known once it is open. */
    async capabilities() {
      let canSwitch = false
      try {
        const devices = (await nav.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
        canSwitch = devices.length > 1
      } catch {
        canSwitch = false
      }
      const caps = track()?.getCapabilities?.() ?? {}
      return { canSwitch, canTorch: caps.torch === true }
    },

    /** Swaps between the back and the front camera. */
    async switchCamera() {
      if (!stream) return
      facing = facing === 'environment' ? 'user' : 'environment'
      release()
      await open()
    },

    async setTorch(on) {
      await track()?.applyConstraints?.({ advanced: [{ torch: on === true }] })
    },

    onLost(listener) {
      lostListeners.add(listener)
      return () => lostListeners.delete(listener)
    }
  }
}
