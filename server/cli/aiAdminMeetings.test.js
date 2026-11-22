import assert from 'node:assert/strict'
import test from 'node:test'
import { rig } from '../academic/testSupport.js'
import { createMeetingRepository } from '../persistence/meetingRepository.js'
import { run } from './aiAdmin.js'

test('the host can list the meetings nobody owns and give them to one person; a person\'s own meetings are never taken', async () => {
  const { database, who } = rig()
  const meetings = createMeetingRepository(database)
  const old1 = meetings.create({ metadata: { title: 'old lecture' } })
  const old2 = meetings.create({ metadata: { title: 'old lecture 2' } })
  const hers = meetings.create({ metadata: { title: 'hers' }, ownerUserId: who.bob })
  const lines = []
  const out = (line) => lines.push(line)

  assert.equal(await run(['meetings', 'list'], { database, out }), 0)
  assert.ok(lines.some((l) => l.includes(old1.meetingId)) && lines.some((l) => l.includes(old2.meetingId)))
  assert.ok(!lines.some((l) => l.includes(hers.meetingId)))
  assert.match(lines.at(-1), /2 meeting\(s\) with no owner/)

  lines.length = 0
  await run(['meetings', 'claim', 'alice@example.com', '--ids', old1.meetingId], { database, out })
  assert.match(lines[0], /1 meeting\(s\) now belong to alice@example.com/)
  assert.equal(meetings.getOwner(old1.meetingId), who.alice)
  assert.equal(meetings.getOwner(old2.meetingId), null)

  lines.length = 0
  await run(['meetings', 'claim', 'alice@example.com', '--ids', hers.meetingId], { database, out })
  assert.match(lines[0], /0 meeting\(s\)/)
  assert.equal(meetings.getOwner(hers.meetingId), who.bob)

  await run(['meetings', 'claim', 'alice@example.com'], { database, out })
  assert.equal(meetings.getOwner(old2.meetingId), who.alice)
  const audited = database.prepare(`SELECT detail_json FROM ai_audit WHERE event = 'meetings.claim'`).all().map((r) => JSON.parse(r.detail_json))
  assert.ok(audited.length === 3 && audited.every((d) => d.by === 'host' && typeof d.moved === 'number'))

  await assert.rejects(run(['meetings', 'claim', 'nobody@example.com'], { database, out }), /no such person/)
  await assert.rejects(run(['meetings', 'bogus'], { database, out }), /meetings list \| claim/)
})
