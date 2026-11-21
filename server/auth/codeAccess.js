import { Router } from 'express'
import { LEGACY_IDENTITY } from './identity.js'

/**
 * The single-tenant fallback (ASSISTANT_AUTH_MODE=code): the one shared access code of assistantAuth.js, presented through the same
 * interface as the per-person sign-in, so the server wires both identically. Everything a person does here belongs to the owner
 * 'legacy' (the conversations that existed before NUMZ AI 2.0). This is the rollback position, not the destination.
 */
export function createCodeAccess(assistantAuth) {
  return {
    mode: 'code',
    requireSession() {
      return (req, res, next) =>
        assistantAuth.requireAccess(req, res, () => {
          req.identity = LEGACY_IDENTITY
          next()
        })
    },
    async authorizeUpgrade(req) {
      const verdict = assistantAuth.authorizeUpgrade(req)
      return verdict.ok ? { ok: true, identity: LEGACY_IDENTITY, idHash: null } : verdict
    },
    jsonRouter: () => assistantAuth.router(),
    browserRouter: () => Router(),
    trackSocket: () => null,
    touchSession() {},
    revokeUser: () => 0,
    status: () => ({ mode: 'code', ...assistantAuth.status() }),
    start() {},
    stop() {}
  }
}
