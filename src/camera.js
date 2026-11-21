/**
 * The Smart Camera page (camera.html): point a phone at a practice question on another screen, have it read and
 * answered, then show the next one. This file only connects the parts:
 *
 *   cameraDevice   the camera (opens only when the person presses Start)
 *   cameraSession  the flow: when a picture is worth sending, what to do with the reply
 *   cameraApi      the server
 *   cameraView     the screen
 *
 * The camera is released when the page is hidden or closed, and a hidden page is paused, so nothing is scanned
 * from the background.
 */

import { createCameraApi } from './interfaces/camera/cameraApi.js'
import { createCameraDevice } from './interfaces/camera/cameraDevice.js'
import { createCameraSession } from './interfaces/camera/cameraSession.js'
import { createCameraView } from './interfaces/camera/cameraView.js'
import { createAccessApi, createAccessController, watchForUnauthorized } from './interfaces/auth/access.js'
import { createAccessGateView } from './interfaces/auth/accessGateView.js'
import { enableWebFonts } from './interfaces/layout/workspace.js'

const TICK_MS = 250

enableWebFonts()

const accessController = createAccessController({ api: createAccessApi(), onUnlocked: () => location.reload() })
createAccessGateView({ controller: accessController })
watchForUnauthorized(globalThis, () => accessController.require())
accessController.start()

const device = createCameraDevice({ video: document.getElementById('cameraPreview') })
const session = createCameraSession({ device, api: createCameraApi() })
createCameraView({ session, device })

setInterval(() => session.tick(performance.now()), TICK_MS)

// If the camera is taken away (permission withdrawn, another app, unplugged) say so and let go.
device.onLost(() => session.stop('The camera was disconnected.'))

// Never scan from the background: a hidden page pauses, and leaving the page turns the camera off.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) session.pause(performance.now())
})
addEventListener('pagehide', () => session.stop())
