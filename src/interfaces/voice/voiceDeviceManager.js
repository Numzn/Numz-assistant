const STORAGE_KEY = 'ai-assistant.preferredMicDeviceId'

function getMediaDevices() {
  return globalThis?.navigator?.mediaDevices ?? null
}

function stopStream(stream) {
  for (const track of stream?.getTracks?.() ?? []) {
    track.stop()
  }
}

export function describeMicError(err) {
  const name = err?.name ?? ''
  const message = err?.message ?? ''

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone permission was blocked'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Microphone is already in use'
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'Selected microphone is unavailable'
  }
  if (name === 'SecurityError') {
    return 'Microphone requires a secure browser context'
  }
  if (message) return message
  return 'Microphone test failed'
}

export function hasMicrophoneDeviceSupport() {
  const mediaDevices = getMediaDevices()
  return Boolean(mediaDevices?.getUserMedia && mediaDevices?.enumerateDevices)
}

export function createVoiceDeviceManager({ storage = globalThis?.localStorage } = {}) {
  let preferredDeviceId = storage?.getItem?.(STORAGE_KEY) ?? ''

  function setPreferredDeviceId(deviceId) {
    preferredDeviceId = typeof deviceId === 'string' ? deviceId : ''
    if (preferredDeviceId) storage?.setItem?.(STORAGE_KEY, preferredDeviceId)
    else storage?.removeItem?.(STORAGE_KEY)
  }

  async function ensurePermission(deviceId = preferredDeviceId) {
    const mediaDevices = getMediaDevices()
    if (!mediaDevices?.getUserMedia) {
      throw new Error('Microphone devices are not supported in this browser')
    }

    const audio = deviceId ? { deviceId: { exact: deviceId } } : true
    const stream = await mediaDevices.getUserMedia({ audio, video: false })
    stopStream(stream)
  }

  async function listInputDevices({ requestPermission = false } = {}) {
    const mediaDevices = getMediaDevices()
    if (!mediaDevices?.enumerateDevices) return []

    if (requestPermission) {
      await ensurePermission().catch(() => {})
    }

    const devices = await mediaDevices.enumerateDevices()
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
        groupId: device.groupId
      }))
  }

  async function testDevice(deviceId = preferredDeviceId) {
    await ensurePermission(deviceId)
    return listInputDevices()
  }

  return {
    isSupported() {
      return hasMicrophoneDeviceSupport()
    },

    getPreferredDeviceId() {
      return preferredDeviceId
    },

    setPreferredDeviceId,
    listInputDevices,
    testDevice
  }
}
