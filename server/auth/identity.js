import { capabilitiesFor, CAPABILITIES } from './rolePolicy.js'

/**
 * Who is making a request, as every route sees it: `req.identity`, set by the access middleware and by nothing else. A route never
 * reads a user id from a header, a query string or a body.
 *
 *   person      a signed-in NUMZLAB account: ownerKey is their stable NUMZLAB user id; conversations, camera sessions and usage are theirs.
 *   fallback    ASSISTANT_AUTH_MODE=code (one shared access code): everything belongs to the single-tenant owner 'legacy'.
 */

export const LEGACY_IDENTITY = Object.freeze({
  legacy: true,
  ownerKey: 'legacy',
  userId: null,
  externalId: null,
  email: null,
  name: null,
  role: 'admin',
  capabilities: new Set(CAPABILITIES),
  sessionRef: null
})

export function personIdentity(user, session) {
  return Object.freeze({
    legacy: false,
    ownerKey: user.id,
    userId: user.id,
    externalId: user.external_id,
    email: user.email,
    name: user.name ?? null,
    role: user.role,
    capabilities: capabilitiesFor(user.role),
    sessionRef: session.ref,
    csrf: session.csrf
  })
}

export function can(identity, capability) {
  return Boolean(identity?.capabilities?.has(capability))
}

/** The identity of this request. A route that finds none was mounted without the access middleware: that is a bug, never "allow". */
export function requireIdentity(req) {
  if (!req.identity) {
    throw Object.assign(new Error('This route was reached without an access check'), { statusCode: 500, code: 'identity-missing' })
  }
  return req.identity
}

/** Work that belongs to no signed-in person (analysis of a meeting, started with the meeting's own ticket): recorded as 'system'. */
export const SYSTEM_IDENTITY = Object.freeze({
  legacy: false,
  system: true,
  ownerKey: 'system',
  userId: null,
  externalId: null,
  email: null,
  name: null,
  role: 'admin',
  capabilities: new Set(),
  sessionRef: null
})
