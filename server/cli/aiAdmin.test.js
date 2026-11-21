import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createConversationRepository } from '../persistence/conversationRepository.js'
import { createIdentityRepository } from '../persistence/identityRepository.js'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { run } from './aiAdmin.js'

function rig() {
  const database = createDatabase({ filename: ':memory:' })
  const people = createIdentityRepository(database)
  const store = createConversationRepository(database)
  const ada = people.upsertUser({ externalId: 'aaaaaaaaaaaa', email: 'ada@example.com', name: 'Ada', role: 'admin' })
  const bob = people.upsertUser({ externalId: 'bbbbbbbbbbbb', email: 'bob@example.com', name: 'Bob', role: 'viewer' })
  const lines = []
  const cli = (...argv) => run(argv, { out: (l) => lines.push(l), database, env: {} })
  return { database, people, store, ada, bob, lines, cli }
}

test('people, sessions and usage are listed without any text', async () => {
  const r = rig()
  r.people.createSession({ userId: r.ada.id, ttlSeconds: 600, ip: '10.0.0.1' })
  await r.cli('users')
  await r.cli('sessions')
  await r.cli('usage')
  const text = r.lines.join('\n')
  assert.match(text, /ada@example\.com\s+admin\s+active\s+sessions 1/)
  assert.match(text, /handle [0-9a-f]{12}/)
  assert.ok(!/secret|csrf/i.test(text))
})

test('revoking a person ends their sessions and blocks them; asking for someone unknown fails clearly', async () => {
  const r = rig()
  r.people.createSession({ userId: r.bob.id, ttlSeconds: 600 })
  await r.cli('revoke-user', 'bob@example.com')
  assert.equal(r.people.getUser(r.bob.id).status, 'revoked')
  assert.equal(r.database.prepare('SELECT COUNT(*) AS n FROM ai_sessions WHERE revoked_at IS NULL').get().n, 0)
  assert.ok(r.people.listAudit(5).some((e) => e.event === 'admin.revoke_user'))
  await assert.rejects(r.cli('revoke-user', 'nobody@example.com'), /no such person/)
  await assert.rejects(r.cli('revoke-user'), /no such person/)
})

test('the emergency stop from the host: pause, flags, resume', async () => {
  const r = rig()
  await r.cli('pause', 'camera')
  await r.cli('flags')
  assert.match(r.lines.at(-1), /stopped by switch: camera/)
  await r.cli('resume', 'camera')
  await r.cli('pause')
  assert.match(r.lines.at(-1), /all/)
  await assert.rejects(r.cli('pause', 'dishes'), /feature must be/)
})

test('conversations from before people: invisible, listed here, released to one person on purpose, exported privately, or deleted only when asked twice', async () => {
  const r = rig()
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  r.store.append(a, { role: 'user', content: 'old words one' })
  r.store.append(a, { role: 'assistant', content: 'old reply' })
  r.store.append(b, { role: 'user', content: 'old words two' })
  await r.cli('legacy', 'list')
  assert.match(r.lines.join('\n'), /2 conversation\(s\) nobody can see/)
  assert.equal(r.store.forOwner(r.ada.id).list().total, 0)

  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-cli-'))
  const file = path.join(dir, 'old.json')
  await r.cli('legacy', 'export', file)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 2)
  rmSync(dir, { recursive: true })

  await r.cli('legacy', 'claim', 'ada@example.com', '--ids', a)
  assert.equal(r.store.forOwner(r.ada.id).list().total, 1)
  assert.equal(r.store.forOwner(r.bob.id).list().total, 0)
  assert.equal(r.store.legacy.list().length, 1)
  await assert.rejects(r.cli('legacy', 'claim', 'nobody@example.com'), /no such person/, 'only someone who has signed in can be given them')
  await assert.rejects(r.cli('legacy', 'purge'), /--yes/)
  assert.equal(r.store.legacy.list().length, 1)
  await r.cli('legacy', 'purge', '--yes')
  assert.equal(r.store.legacy.list().length, 0)
  assert.equal(r.store.forOwner(r.ada.id).get(a).messages.length, 2, 'what was released is untouched by the purge')
  assert.deepEqual(r.people.listAudit(10).map((e) => e.event).filter((e) => e.startsWith('legacy')).sort(), ['legacy.claim', 'legacy.export', 'legacy.purge'])
})

test('a short session for the deployment checks: for an active person only, with a time limit, audited', async () => {
  const r = rig()
  await r.cli('mint-session', 'ada@example.com', '--minutes', '10')
  const minted = JSON.parse(r.lines.at(-1))
  assert.equal(minted.cookieName, '__Secure-numzai_session')
  assert.equal(minted.expiresInMinutes, 10)
  const row = r.people.findSession(minted.cookieValue)
  assert.equal(row.email, 'ada@example.com')
  assert.ok(row.expires_at - row.created_at <= 600)
  assert.ok(r.people.listAudit(5).some((e) => e.event === 'admin.mint_session'))
  r.people.setUserStatus(r.bob.id, 'revoked')
  await assert.rejects(r.cli('mint-session', 'bob@example.com'), /not active/)
  assert.equal(JSON.parse((await r.cli('mint-session', 'ada@example.com', '--minutes', '9999'), r.lines.at(-1))).expiresInMinutes, 60, 'capped at an hour')
})
