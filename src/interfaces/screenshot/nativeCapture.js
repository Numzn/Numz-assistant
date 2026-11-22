/**
 * The page's side of NATIVE screen capture. The page never captures anything itself: in the NUMZ AI desktop app (Tauri) the Rust layer
 * takes the picture through the operating system's own capture API (Windows Graphics Capture, ScreenCaptureKit on macOS, the X11 / desktop
 * portal path on Linux) and hands the page a preview. In a plain browser there is no such layer, and this module says so.
 *
 *   createNativeCapture({ invoke }) ->
 *     available                         false in a browser: there is nothing to ask
 *     status()      -> { platform, session, modes: { screen, window, region }, permission, note? }
 *     listWindows() -> [{ id, title, app, width, height }]
 *     capture({ mode: 'screen' | 'window', windowId? }) -> { captureId, width, height, preview }      (preview: a data: URL, small)
 *     exportCapture({ captureId, rect?, maxSide?, quality? }) -> { bytes: Uint8Array, mimeType, width, height }
 *     discard(captureId)                the native side forgets the capture (it also forgets on its own after a few minutes)
 *
 * A region is a crop of a capture, chosen on the preview INSIDE the app: nothing is drawn over the desktop, nothing is dimmed or frozen.
 * Nothing here sends keys or mouse events, and nothing is captured without the person pressing a button in the app.
 *
 * Every failure is a CaptureError with a stable `code`: permission-denied, unsupported, cancelled, no-such-window, capture-failed,
 * busy, expired, invalid-region, unavailable (not in the desktop app).
 */

export class CaptureError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}

const MESSAGES = {
  'permission-denied': 'NUMZ AI is not allowed to capture the screen. Allow it in your system\'s screen-recording / screen-capture privacy settings, then try again.',
  unsupported: 'This desktop session cannot be captured by NUMZ AI.',
  cancelled: 'The capture was cancelled.',
  'no-such-window': 'That window is no longer open. Pick another one.',
  'capture-failed': 'The screenshot could not be taken. Try again.',
  busy: 'A capture is already in progress.',
  expired: 'That capture is no longer held. Take it again.',
  'invalid-region': 'That area is not inside the screenshot.',
  unavailable: 'Screenshots are taken by the NUMZ AI desktop app. Open NUMZ AI there to use them.'
}

/** The words for a code; a message the native side supplied is used when it is a string we can show. */
export function describeCaptureError(code, fallback = '') {
  return MESSAGES[code] ?? (fallback || MESSAGES['capture-failed'])
}

function normalize(err) {
  if (err instanceof CaptureError) return err
  // The Rust layer rejects with { code, message }; anything else (a string, an Error) is a failure of the bridge itself.
  if (err && typeof err === 'object' && typeof err.code === 'string') return new CaptureError(err.code, describeCaptureError(err.code, typeof err.message === 'string' ? err.message : ''))
  return new CaptureError('capture-failed', describeCaptureError('capture-failed'))
}

function defaultInvoke() {
  const internals = globalThis.__TAURI_INTERNALS__
  return typeof internals?.invoke === 'function' ? (command, args) => internals.invoke(command, args) : null
}

function fromBase64(text) {
  const binary = globalThis.atob(String(text))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function createNativeCapture({ invoke = defaultInvoke() } = {}) {
  const available = typeof invoke === 'function'

  async function call(command, args) {
    if (!available) throw new CaptureError('unavailable', MESSAGES.unavailable)
    try {
      return await invoke(command, args)
    } catch (err) {
      throw normalize(err)
    }
  }

  return {
    available,

    async status() {
      const s = await call('screenshot_status', {})
      return {
        platform: String(s?.platform ?? ''),
        session: String(s?.session ?? ''),
        modes: { screen: s?.modes?.screen === true, window: s?.modes?.window === true, region: s?.modes?.region === true },
        permission: ['granted', 'denied', 'prompt', 'unknown'].includes(s?.permission) ? s.permission : 'unknown',
        note: typeof s?.note === 'string' ? s.note : ''
      }
    },

    async listWindows() {
      const list = await call('screenshot_windows', {})
      return (Array.isArray(list) ? list : []).map((w) => ({
        id: String(w.id),
        title: String(w.title ?? ''),
        app: String(w.app ?? ''),
        width: Number(w.width) || 0,
        height: Number(w.height) || 0
      }))
    },

    async capture({ mode = 'screen', windowId = null } = {}) {
      if (mode !== 'screen' && mode !== 'window') throw new CaptureError('capture-failed', MESSAGES['capture-failed'])
      const c = await call('screenshot_capture', { mode, windowId })
      if (!c || typeof c.captureId !== 'string' || typeof c.preview !== 'string') throw new CaptureError('capture-failed', MESSAGES['capture-failed'])
      return { captureId: c.captureId, width: Number(c.width) || 0, height: Number(c.height) || 0, preview: c.preview }
    },

    async exportCapture({ captureId, rect = null, maxSide = 2048, quality = 85 } = {}) {
      const out = await call('screenshot_export', { captureId, rect, maxSide, quality })
      if (!out || typeof out.data !== 'string') throw new CaptureError('capture-failed', MESSAGES['capture-failed'])
      return { bytes: fromBase64(out.data), mimeType: out.mimeType === 'image/png' ? 'image/png' : 'image/jpeg', width: Number(out.width) || 0, height: Number(out.height) || 0 }
    },

    async discard(captureId) {
      if (!available || !captureId) return
      try {
        await invoke('screenshot_discard', { captureId })
      } catch {
        /* the native side also forgets on its own */
      }
    }
  }
}
