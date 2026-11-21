/**
 * An error of the Smart Camera that is meant to be shown. `code` is the stable machine name the page acts on
 * (see src/interfaces/camera/cameraApi.js), the message is written for a person, and `expose` lets the shared error
 * handler send both even for a 5xx. `retryAfterSeconds` becomes a Retry-After header on the way out.
 */
export class CameraError extends Error {
  constructor(statusCode, code, message, { retryAfterSeconds = null } = {}) {
    super(message)
    this.name = 'CameraError'
    this.statusCode = statusCode
    this.code = code
    this.expose = true
    if (retryAfterSeconds !== null) this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds))
  }
}
