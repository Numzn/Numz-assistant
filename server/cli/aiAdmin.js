import { writeFileSync, chmodSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { createConversationRepository } from '../persistence/conversationRepository.js'
import { createIdentityRepository } from '../persistence/identityRepository.js'
import { createMeter } from '../usage/meter.js'

/**
 * Host-side administration of NUMZ AI, for the person who runs the machine. It works on the database directly (so it needs neither a
 * sign-in nor the web server), which is why it is a command and not a route:
 *
 *   docker exec numz-assistant-production node server/cli/aiAdmin.js <command>
 *
 *   users                          the people who have signed in, their role and live sessions
 *   sessions                       live sessions (handle, person, last used)
 *   revoke-user <email|id>         end all of a person's sessions and block them until they sign in again (open sockets close within seconds)
 *   pause [all|chat|voice|camera]  the emergency stop      resume [feature]      lift it      flags      what is stopped
 *   usage [days]                   counts and estimated cost per person (never any text)
 *   legacy list                    conversations that existed before people had accounts (nobody can see them)
 *   legacy claim <email|id> [--ids a,b]   give them (all, or just those) to one person who has signed in
 *   legacy export <file>           write them to a private file (this one DOES contain the text: keep it safe)
 *   legacy purge --yes             delete them for good
 *   mint-session <email|id> [--minutes 15]   a short session for one person, to run the deployment checks (prints the cookie once)
 */

const MINUTES = (v) => Math.max(1, Math.min(60, Number.parseInt(v ?? '15', 10) || 15))

export async function run(argv, { out = console.log, env = process.env, database = null, clock = Date.now } = {}) {
  const [command, ...rest] = argv
  const flag = (name) => {
    const i = rest.indexOf(name)
    return i === -1 ? undefined : (rest[i + 1] ?? true)
  }
  const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'))
  const db = database ?? createDatabase()
  const people = createIdentityRepository(db, { clock })
  const conversations = createConversationRepository(db)
  const meter = createMeter({ database: db, env, clock, logger: { warn() {}, error() {}, log() {}, info() {} } })
  const audit = (event, detail = null) => people.audit({ event, detail: { by: 'host', ...(detail ?? {}) } })
  const find = (who) => {
    const needle = String(who ?? '').trim().toLowerCase()
    const user = people.listUsers().find((u) => u.id === who || u.email.toLowerCase() === needle || u.externalId === who)
    if (!user) throw new Error(`no such person: ${who ?? '(nothing given)'} (they appear after their first sign-in)`)
    return user
  }
  const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : 'never')

  switch (command) {
    case 'users': {
      for (const u of people.listUsers()) out(`${u.email.padEnd(36)} ${u.role.padEnd(9)} ${u.status.padEnd(8)} sessions ${u.sessions}  last sign-in ${u.lastLoginAt ?? 'never'}  id ${u.id}`)
      return 0
    }
    case 'sessions': {
      for (const u of people.listUsers()) for (const s of people.listSessions(u.id)) out(`${u.email.padEnd(36)} handle ${s.handle}  since ${when(s.createdAt * 1000)}  last used ${when(s.lastActivityAt * 1000)}  from ${s.ip ?? '?'}`)
      return 0
    }
    case 'revoke-user': {
      const user = find(positional[0])
      people.setUserStatus(user.id, 'revoked')
      const n = people.revokeUserSessions(user.id, 'revoked at the console')
      audit('admin.revoke_user', { target: user.id, sessions: n })
      out(`${user.email}: ${n} session(s) ended; they can sign in again only if NUMZLAB still approves them`)
      return 0
    }
    case 'pause':
    case 'resume': {
      const feature = positional[0] ?? 'all'
      if (command === 'pause') meter.pause(feature, 'host')
      else meter.resume(feature, 'host')
      audit(command === 'pause' ? 'ai.paused' : 'ai.resumed', { feature })
      out(`${command}: ${feature} -> now stopped: ${meter.flags().on.join(', ') || 'nothing'}`)
      return 0
    }
    case 'flags': {
      const flags = meter.flags()
      out(`environment kill switch: ${flags.killSwitchEnv ? 'ON' : 'off'}; stopped by switch: ${flags.on.join(', ') || 'nothing'}`)
      return 0
    }
    case 'usage': {
      const names = new Map(people.listUsers().map((u) => [u.id, u.email]))
      for (const r of meter.report(Number.parseInt(positional[0] ?? '7', 10) || 7)) {
        out(`${(names.get(r.userId) ?? r.userId).padEnd(36)} calls ${String(r.calls).padStart(5)}  chat ${String(r.chat).padStart(4)}  camera ${String(r.vision).padStart(4)}  speech ${String(r.sttSeconds).padStart(5)}s  tokens ${r.tokensIn}/${r.tokensOut}  cost ${r.costMicroUsd ? `$${(r.costMicroUsd / 1e6).toFixed(4)}` : 'unknown'}  not ok ${r.notOk}`)
      }
      return 0
    }
    case 'legacy': {
      const [sub, ...args] = positional
      if (sub === 'list') {
        const rows = conversations.legacy.list()
        for (const c of rows) out(`${c.id}  ${c.updatedAt}  ${String(c.messageCount).padStart(3)} messages  ${c.title ?? ''}`)
        out(`${rows.length} conversation(s) nobody can see`)
        return 0
      }
      if (sub === 'claim') {
        const user = find(args[0])
        const ids = typeof flag('--ids') === 'string' ? String(flag('--ids')).split(',').map((v) => v.trim()).filter(Boolean) : null
        const moved = conversations.legacy.claim(user.id, ids)
        audit('legacy.claim', { to: user.id, moved })
        out(`${moved} conversation(s) now belong to ${user.email}`)
        return 0
      }
      if (sub === 'export') {
        const file = args[0]
        if (!file) throw new Error('give a file name')
        const rows = conversations.legacy.list().map((c) => ({ ...c, messages: db.prepare('SELECT role, content, created_at AS createdAt FROM assistant_messages WHERE conversation_id = ? ORDER BY seq').all(c.id) }))
        writeFileSync(file, JSON.stringify(rows, null, 2), { mode: 0o600 })
        chmodSync(file, 0o600)
        audit('legacy.export', { count: rows.length })
        out(`${rows.length} conversation(s) written to ${file} (private to you; it holds the words)`)
        return 0
      }
      if (sub === 'purge') {
        if (flag('--yes') !== true && flag('--yes') !== 'true') throw new Error('this deletes them for good: add --yes')
        const n = conversations.legacy.purge()
        audit('legacy.purge', { count: n })
        out(`${n} conversation(s) deleted`)
        return 0
      }
      throw new Error('legacy list | claim <person> [--ids a,b] | export <file> | purge --yes')
    }
    case 'mint-session': {
      const user = find(positional[0])
      if (user.status !== 'active') throw new Error(`${user.email} is not active`)
      const minutes = MINUTES(flag('--minutes'))
      const session = people.createSession({ userId: user.id, ttlSeconds: minutes * 60, ip: 'host' })
      audit('admin.mint_session', { target: user.id, minutes })
      const secure = String(env.AI_COOKIE_SECURE ?? '').toLowerCase() !== 'off'
      out(JSON.stringify({ cookieName: secure ? '__Secure-numzai_session' : 'numzai_session', cookieValue: session.secret, csrf: session.csrf, expiresInMinutes: minutes, person: user.email }))
      return 0
    }
    default:
      out(`usage: node server/cli/aiAdmin.js users | sessions | revoke-user <person> | pause|resume [feature] | flags | usage [days] | legacy ... | mint-session <person>`)
      return command ? 1 : 0
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`error: ${err.message}`)
      process.exit(1)
    }
  )
}
