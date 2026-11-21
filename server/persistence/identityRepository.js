import { createHash, randomBytes, randomUUID } from 'node:crypto'

/**
 * People, their NUMZ AI sessions and the security audit trail (migration 5). A session's secret is a random 256-bit value that exists
 * only in the person's cookie: here only its SHA-256 is kept, so a copy of this database cannot be used to sign in. Nothing in this
 * file ever stores or returns a cookie, a token, a prompt or a reply.
 */

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const iso = (ms) => new Date(ms).toISOString()

export function createIdentityRepository(database, { clock = Date.now } = {}) {
  const q = {
    userByExternal: database.prepare(`SELECT * FROM ai_users WHERE external_provider = 'numzlab' AND external_id = ?`),
    user: database.prepare('SELECT * FROM ai_users WHERE id = ?'),
    insertUser: database.prepare(
      `INSERT INTO ai_users (id, external_provider, external_id, email, name, role, status, created_at, last_login_at, last_verified_at)
       VALUES (?, 'numzlab', ?, ?, ?, ?, 'active', ?, ?, ?)`
    ),
    refreshUser: database.prepare(
      `UPDATE ai_users SET email = ?, name = ?, role = ?, status = 'active', last_login_at = ?, last_verified_at = ? WHERE id = ?`
    ),
    setStatus: database.prepare('UPDATE ai_users SET status = ? WHERE id = ?'),
    verified: database.prepare('UPDATE ai_users SET role = ?, last_verified_at = ? WHERE id = ?'),
    users: database.prepare(
      `SELECT u.id, u.external_id AS externalId, u.email, u.name, u.role, u.status, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
              (SELECT COUNT(*) FROM ai_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS sessions
         FROM ai_users u ORDER BY u.created_at`
    ),
    insertSession: database.prepare(
      `INSERT INTO ai_sessions (id_hash, user_id, csrf, created_at, expires_at, last_activity_at, ip, user_agent_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    session: database.prepare(
      `SELECT s.id_hash, s.user_id, s.csrf, s.created_at, s.expires_at, s.last_activity_at, s.revoked_at, s.revoked_reason,
              u.external_id, u.email, u.name, u.role, u.status, u.last_verified_at
         FROM ai_sessions s JOIN ai_users u ON u.id = s.user_id WHERE s.id_hash = ?`
    ),
    sessionByHash: database.prepare(
      `SELECT s.id_hash, s.user_id, s.csrf, s.created_at, s.expires_at, s.last_activity_at, s.revoked_at, s.revoked_reason,
              u.external_id, u.email, u.name, u.role, u.status, u.last_verified_at
         FROM ai_sessions s JOIN ai_users u ON u.id = s.user_id WHERE s.id_hash = ?`
    ),
    touch: database.prepare('UPDATE ai_sessions SET last_activity_at = ? WHERE id_hash = ? AND revoked_at IS NULL'),
    revoke: database.prepare('UPDATE ai_sessions SET revoked_at = ?, revoked_reason = ? WHERE id_hash = ? AND revoked_at IS NULL'),
    revokeUser: database.prepare('UPDATE ai_sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL'),
    revokeHandle: database.prepare(
      `UPDATE ai_sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND substr(id_hash, 1, 12) = ? AND revoked_at IS NULL`
    ),
    listSessions: database.prepare(
      `SELECT substr(id_hash, 1, 12) AS handle, created_at AS createdAt, last_activity_at AS lastActivityAt, expires_at AS expiresAt, ip
         FROM ai_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at`
    ),
    sweep: database.prepare('DELETE FROM ai_sessions WHERE expires_at < ? OR revoked_at < ?'),
    audit: database.prepare('INSERT INTO ai_audit (ts, event, user_id, session_ref, ip, request_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    auditList: database.prepare('SELECT id, ts, event, user_id AS userId, session_ref AS sessionRef, ip, request_id AS requestId, detail_json AS detail FROM ai_audit ORDER BY id DESC LIMIT ?')
  }

  return {
    /** Create the person on first sign-in, or refresh them: role and name as NUMZLAB says today, status active. */
    upsertUser({ externalId, email, name, role }) {
      const at = iso(clock())
      const found = q.userByExternal.get(externalId)
      if (found) {
        q.refreshUser.run(email, name ?? null, role, at, at, found.id)
        return q.user.get(found.id)
      }
      const id = randomUUID()
      q.insertUser.run(id, externalId, email, name ?? null, role, at, at, at)
      return q.user.get(id)
    },
    getUser: (id) => q.user.get(id) ?? null,
    getUserByExternal: (externalId) => q.userByExternal.get(externalId) ?? null,
    setUserStatus: (id, status) => q.setStatus.run(status, id),
    markVerified(id, role) {
      q.verified.run(role, iso(clock()), id)
      return q.user.get(id)
    },
    listUsers: () => q.users.all(Math.floor(clock() / 1000)),

    /** A new session. The returned `secret` is for the cookie and is never stored. */
    createSession({ userId, csrf = randomBytes(24).toString('base64url'), ttlSeconds, ip = null, userAgent = '' }) {
      const secret = randomBytes(32).toString('base64url')
      const now = Math.floor(clock() / 1000)
      q.insertSession.run(sha256(secret), userId, csrf, now, now + ttlSeconds, now, ip, userAgent ? sha256(userAgent) : null)
      return { secret, csrf, ref: sha256(secret).slice(0, 8), expiresAt: now + ttlSeconds }
    },
    findSession(secret) {
      if (typeof secret !== 'string' || secret.length < 20 || secret.length > 128) return null
      return q.session.get(sha256(secret)) ?? null
    },
    findSessionByHash: (idHash) => q.sessionByHash.get(idHash) ?? null,
    touch: (idHash) => q.touch.run(Math.floor(clock() / 1000), idHash),
    revokeSession: (idHash, reason) => q.revoke.run(Math.floor(clock() / 1000), reason, idHash).changes,
    revokeUserSessions: (userId, reason) => q.revokeUser.run(Math.floor(clock() / 1000), reason, userId).changes,
    revokeSessionByHandle: (userId, handle, reason) => q.revokeHandle.run(Math.floor(clock() / 1000), reason, userId, handle).changes,
    listSessions: (userId) => q.listSessions.all(userId, Math.floor(clock() / 1000)),
    /** Forget sessions that ended more than a day ago. */
    sweep() {
      const cutoff = Math.floor(clock() / 1000) - 86_400
      return q.sweep.run(cutoff, cutoff).changes
    },

    /** One security event. `detail` holds short codes and numbers only (never text a person wrote, a cookie or a token). */
    audit({ event, userId = null, sessionRef = null, ip = null, requestId = null, detail = null }) {
      q.audit.run(iso(clock()), event, userId, sessionRef, ip, requestId, detail ? JSON.stringify(detail) : null)
    },
    listAudit: (limit = 100) => q.auditList.all(Math.max(1, Math.min(500, limit))),
    sha256
  }
}
