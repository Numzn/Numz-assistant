/**
 * The limits an owner may change from the environment. Only the cost control is exposed: how many pictures one camera
 * session may read (CAMERA_MAX_READS, 1 to 1000; each picture is a paid vision call). Anything that is not a plain whole
 * number in that range is ignored, so a typo can never switch the limit off or set it to something absurd.
 */
export function cameraLimitsFromEnv(env = process.env) {
  const raw = String(env.CAMERA_MAX_READS ?? '').trim()
  if (!/^\d{1,4}$/.test(raw)) return {}
  const maxReads = Number.parseInt(raw, 10)
  return maxReads >= 1 && maxReads <= 1000 ? { maxReads } : {}
}
