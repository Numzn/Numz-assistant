/**
 * What each NUMZLAB role may do inside NUMZ AI, and how much. NUMZLAB decides WHO a person is and whether they are approved (every
 * approved, active account holds `ai.use`); this file decides what that role is entitled to here. It is configuration, not security
 * plumbing: the numbers are starting points to be tuned from the usage records (ai_usage), and can be overridden without a deploy:
 *
 *   AI_QUOTA_OVERRIDES='{"viewer":{"chatPerDay":50},"operator":{"visionPerDay":200}}'
 *
 * No role may read another person's conversations: there is no capability for it and no route that would honour one.
 */

export const CAPABILITIES = Object.freeze(['chat', 'voice', 'camera', 'history', 'meetings.launch', 'usage.self', 'academic', 'ai.admin'])
const EVERYONE = ['chat', 'voice', 'camera', 'history', 'meetings.launch', 'usage.self', 'academic']

const CAPABILITIES_BY_ROLE = {
  viewer: EVERYONE,
  operator: EVERYONE,
  // ai.admin: usage of everybody (counts only), revoke a person's NUMZ AI sessions, pause/resume the AI, diagnostics.
  admin: [...EVERYONE, 'ai.admin']
}

const DEFAULT_QUOTAS = {
  viewer: { chatPerDay: 100, visionPerDay: 30, sttSecondsPerDay: 30 * 60, perMinute: 30, concurrent: 2 },
  operator: { chatPerDay: 300, visionPerDay: 100, sttSecondsPerDay: 90 * 60, perMinute: 30, concurrent: 2 },
  admin: { chatPerDay: 1000, visionPerDay: 300, sttSecondsPerDay: 240 * 60, perMinute: 60, concurrent: 3 }
}

export const ROLES = Object.freeze(Object.keys(CAPABILITIES_BY_ROLE))

export function isKnownRole(role) {
  return typeof role === 'string' && Object.hasOwn(CAPABILITIES_BY_ROLE, role)
}

/** The capabilities of a role (an unknown role has none). */
export function capabilitiesFor(role) {
  return new Set(isKnownRole(role) ? CAPABILITIES_BY_ROLE[role] : [])
}

function overridesFrom(env) {
  try {
    const parsed = JSON.parse(env.AI_QUOTA_OVERRIDES || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** The limits of a role. A bad override value is ignored rather than trusted. */
export function quotasFor(role, env = process.env) {
  const base = DEFAULT_QUOTAS[isKnownRole(role) ? role : 'viewer']
  const given = overridesFrom(env)[role]
  const out = { ...base }
  if (given && typeof given === 'object') {
    for (const key of Object.keys(base)) if (Number.isFinite(given[key]) && given[key] >= 0) out[key] = given[key]
  }
  return Object.freeze(out)
}
