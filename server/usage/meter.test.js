import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabase } from '../persistence/sqliteDatabase.js'
import { AiLimitError, createMeter, NO_METER } from './meter.js'
import { costMicroUsd, estimateTokens } from './pricing.js'
import { capabilitiesFor, quotasFor } from '../auth/rolePolicy.js'

const quiet = { error() {}, warn() {}, info() {}, log() {} }
const person = (name, role = 'viewer') => ({ ownerKey: name, role })

function rig(env = {}, start = Date.UTC(2026, 10, 21, 12, 0, 0)) {
  const database = createDatabase({ filename: ':memory:' })
  let now = start
  const warnings = []
  const meter = createMeter({ database, env, clock: () => now, logger: { ...quiet, warn: (m) => warnings.push(m) }, timeoutMs: 1000 })
  return { database, meter, warnings, advance: (ms) => (now += ms), rows: () => database.prepare('SELECT * FROM ai_usage ORDER BY id').all() }
}

const refused = (fn, code, status) => assert.throws(fn, (err) => err instanceof AiLimitError && err.code === code && err.statusCode === status && err.expose === true, `${code}`)

test('a call that goes through leaves exactly one record, with sizes and an estimated cost and no text', () => {
  const r = rig({ AI_PRICE_INPUT_PER_MTOK: '0.27', AI_PRICE_OUTPUT_PER_MTOK: '1.10' })
  const call = r.meter.begin(person('u1'), 'chat', { requestId: 'req-1', conversationId: 'c-1' })
  call.usage({ promptTokens: 1000, completionTokens: 500, model: 'deepseek-chat', provider: 'deepseek' })
  r.advance(1200)
  call.finish()
  call.finish() // twice is once
  call.fail(new Error('too late')) // and a late failure does not rewrite it
  const [row, ...rest] = r.rows()
  assert.equal(rest.length, 0)
  assert.deepEqual(
    { user: row.user_id, kind: row.kind, provider: row.provider, model: row.model, in: row.tokens_in, out: row.tokens_out, status: row.status, ms: row.duration_ms, req: row.request_id, conv: row.conversation_id },
    { user: 'u1', kind: 'chat', provider: 'deepseek', model: 'deepseek-chat', in: 1000, out: 500, status: 'ok', ms: 1200, req: 'req-1', conv: 'c-1' }
  )
  assert.equal(row.est_cost_micro_usd, Math.round(0.27 * 1000 + 1.1 * 500), 'dollars per million tokens, in millionths of a dollar')
})

test('with no prices set the cost is unknown, not zero; with no provider counts the size is estimated from lengths, never stored text', () => {
  const r = rig()
  const call = r.meter.begin(person('u1'), 'chat')
  call.estimate({ inText: 'x'.repeat(400), outText: 'y'.repeat(80) })
  call.finish()
  const [row] = r.rows()
  assert.equal(row.est_cost_micro_usd, null)
  assert.deepEqual([row.tokens_in, row.tokens_out], [100, 20])
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens(''), 0)
  assert.equal(costMicroUsd({ kind: 'stt', audioSeconds: 120 }, { AI_PRICE_STT_PER_MINUTE: '0.006' }), 12000)
  assert.equal(costMicroUsd({ kind: 'vision_read', tokensIn: 1_000_000 }, { AI_PRICE_INPUT_PER_MTOK: '1', AI_PRICE_VISION_INPUT_PER_MTOK: '5' }), 5_000_000, 'vision has its own price when given')
  assert.equal(costMicroUsd({ kind: 'chat', tokensIn: 5 }, { AI_PRICE_INPUT_PER_MTOK: 'cheap' }), null, 'a bad price is ignored, not guessed')
})

test('how a call ended is recorded: ok, error, timeout, aborted', async () => {
  const r = rig()
  r.meter.begin(person('u'), 'chat').finish()
  r.meter.begin(person('u'), 'chat').fail(new Error('provider 500'))
  const timed = r.meter.begin(person('u'), 'chat', { timeout: 20 })
  const keepAlive = setTimeout(() => {}, 500) // the meter's own timer must not hold a process open, so the test does
  await new Promise((resolve) => timed.signal.addEventListener('abort', resolve))
  clearTimeout(keepAlive)
  timed.fail(timed.signal.reason)
  const outer = new AbortController()
  const closed = r.meter.begin(person('u'), 'chat', { signal: outer.signal })
  outer.abort(new Error('the browser went away'))
  assert.equal(closed.signal.aborted, true, 'the caller\'s own signal stops the model call')
  closed.fail(closed.signal.reason)
  r.meter.begin(person('u'), 'chat').abort(new Error('stop pressed'))
  assert.deepEqual(r.rows().map((x) => x.status), ['ok', 'error', 'timeout', 'aborted', 'aborted'])
})

test('too many requests in a minute: refused with when to come back, and the minute passes', () => {
  const r = rig()
  for (let i = 0; i < 30; i++) r.meter.begin(person('u'), 'chat').finish()
  const err = (() => { try { r.meter.begin(person('u'), 'chat') } catch (e) { return e } })()
  assert.equal(err.code, 'rate-limited')
  assert.equal(err.statusCode, 429)
  assert.ok(err.retryAfterSeconds >= 1 && err.retryAfterSeconds <= 60)
  r.meter.begin(person('someone-else'), 'chat').finish() // not theirs
  r.advance(61_000)
  r.meter.begin(person('u'), 'chat').finish()
})

test('only so many calls at once, per person and overall; a finished call frees its place', () => {
  const r = rig({ AI_MAX_CONCURRENT: '3' })
  const a = r.meter.begin(person('u'), 'stream')
  const b = r.meter.begin(person('u'), 'stream')
  refused(() => r.meter.begin(person('u'), 'stream'), 'too-many-at-once', 429) // a viewer may have two
  const c = r.meter.begin(person('v'), 'stream')
  refused(() => r.meter.begin(person('w'), 'stream'), 'ai-busy', 503) // three in all
  a.finish()
  r.meter.begin(person('w'), 'stream').abort()
  b.fail(new Error('x'))
  c.finish()
  const again = r.meter.begin(person('u'), 'stream')
  again.finish()
})

test('the day\'s allowance, by kind, per person: questions, camera reads, speech seconds; it starts again at midnight UTC', () => {
  const r = rig({ AI_QUOTA_OVERRIDES: JSON.stringify({ viewer: { chatPerDay: 2, visionPerDay: 1, sttSecondsPerDay: 100, perMinute: 1000, concurrent: 10 } }) })
  r.meter.begin(person('u'), 'chat').finish()
  r.meter.begin(person('u'), 'stream').finish()
  refused(() => r.meter.begin(person('u'), 'chat'), 'daily-limit', 429)
  refused(() => r.meter.begin(person('u'), 'stream'), 'daily-limit', 429)
  r.meter.begin(person('u'), 'vision_answer').finish() // the answer to a read is not a second read
  r.meter.begin(person('u'), 'vision_read').finish()
  refused(() => r.meter.begin(person('u'), 'vision_read'), 'daily-limit', 429)
  r.meter.begin(person('u'), 'stt').finish({ audioSeconds: 100 })
  refused(() => r.meter.begin(person('u'), 'stt'), 'daily-limit', 429)
  r.meter.begin(person('v'), 'chat').finish()
  const summary = r.meter.summary(person('u'))
  assert.deepEqual(summary.used, { chat: 2, vision: 1, sttSeconds: 100 })
  assert.equal(summary.day, '2026-11-21')
  r.advance(12 * 3600_000 + 1000) // past midnight
  r.meter.begin(person('u'), 'chat').finish()
  assert.equal(r.meter.summary(person('u')).day, '2026-11-22')
})

test('roles have their own allowances and capabilities; only administrators administer; nobody reads anybody else\'s conversations', () => {
  assert.ok(quotasFor('admin').chatPerDay > quotasFor('operator').chatPerDay && quotasFor('operator').chatPerDay > quotasFor('viewer').chatPerDay)
  for (const role of ['viewer', 'operator', 'admin']) for (const c of ['chat', 'voice', 'camera', 'history', 'meetings.launch', 'usage.self', 'academic']) assert.ok(capabilitiesFor(role).has(c), `${role} ${c}`)
  assert.ok(capabilitiesFor('admin').has('ai.admin'))
  assert.ok(!capabilitiesFor('operator').has('ai.admin') && !capabilitiesFor('viewer').has('ai.admin'))
  assert.equal(capabilitiesFor('nonsense').size, 0)
  for (const role of ['viewer', 'operator', 'admin']) assert.ok(![...capabilitiesFor(role)].some((c) => /read|content|conversation/i.test(c) && c !== 'history'), 'no capability reaches other people\'s content')
  assert.equal(quotasFor('viewer', { AI_QUOTA_OVERRIDES: '{"viewer":{"chatPerDay":-5,"perMinute":"lots"}}' }).chatPerDay, quotasFor('viewer').chatPerDay, 'a bad override is ignored')
  assert.equal(quotasFor('viewer', { AI_QUOTA_OVERRIDES: 'not json' }).perMinute, 30)
})

test('spending limits: per person, per day overall and per month overall; warned at 80 per cent, refused at 100', () => {
  const r = rig({
    AI_PRICE_INPUT_PER_MTOK: '1000000', // one dollar per token: makes the arithmetic plain
    AI_PRICE_OUTPUT_PER_MTOK: '0',
    AI_DAILY_COST_LIMIT_USD_PER_USER: '10',
    AI_DAILY_COST_LIMIT_USD: '15',
    AI_MONTHLY_COST_LIMIT_USD: '100',
    AI_QUOTA_OVERRIDES: JSON.stringify({ viewer: { chatPerDay: 1000, perMinute: 1000, concurrent: 100 } })
  })
  const spend = (who, dollars) => {
    const call = r.meter.begin(person(who), 'chat')
    call.usage({ promptTokens: dollars, completionTokens: 0 })
    call.finish()
  }
  spend('u', 8)
  spend('u', 1) // the next call begins at 80 per cent of the person's limit: a warning
  spend('u', 1)
  assert.equal(r.warnings.filter((w) => /\d+% of a spending limit/.test(w)).length, 1, 'a warning, once')
  refused(() => r.meter.begin(person('u'), 'chat'), 'spend-limit', 429)
  spend('v', 4) // 14 in all today
  spend('v', 1) // 15
  refused(() => r.meter.begin(person('w'), 'chat'), 'ai-spend-limit', 503)
  r.advance(24 * 3600_000) // a new day, the same month
  spend('u', 9)
  spend('v', 9)
  r.advance(24 * 3600_000)
  spend('u', 9)
  spend('v', 9) // 15 + 18 + 18 = 51 so far this month
  r.advance(24 * 3600_000)
  spend('u', 9)
  spend('v', 9)
  r.advance(24 * 3600_000)
  spend('u', 9)
  spend('v', 9)
  r.advance(24 * 3600_000)
  spend('u', 9)
  spend('v', 9)
  r.advance(24 * 3600_000)
  refused(() => r.meter.begin(person('u'), 'chat'), 'ai-spend-limit', 503) // the month's cap is reached
  assert.ok(r.warnings.length >= 1)
})

test('the emergency stop: by environment, by switch, for everything or one feature, and only what is switched off stops', () => {
  const env = {}
  const r = rig(env)
  r.meter.begin(person('u'), 'chat').finish()
  r.meter.pause('chat', 'ada@example.com')
  refused(() => r.meter.begin(person('u'), 'chat'), 'ai-paused', 503)
  refused(() => r.meter.begin(person('u'), 'stream'), 'ai-paused', 503)
  refused(() => r.meter.begin(person('u'), 'meeting_intel'), 'ai-paused', 503)
  r.meter.begin(person('u'), 'stt').finish({ audioSeconds: 1 })
  r.meter.begin(person('u'), 'vision_read').finish()
  assert.deepEqual(r.meter.flags().on, ['chat'])
  r.meter.pause('all')
  refused(() => r.meter.begin(person('u'), 'stt'), 'ai-paused', 503)
  r.meter.resume('all')
  r.meter.resume('chat')
  r.meter.begin(person('u'), 'chat').finish()
  env.AI_KILL_SWITCH = 'on'
  refused(() => r.meter.begin(person('u'), 'chat'), 'ai-paused', 503)
  assert.equal(r.meter.flags().killSwitchEnv, true)
  assert.throws(() => r.meter.pause('everything'), /feature must be/)
  assert.throws(() => r.meter.begin(person('u'), 'not-a-kind'), /unknown usage kind/)
  assert.equal(r.database.prepare("SELECT updated_by FROM ai_runtime_flags WHERE key = 'chat'").get().updated_by, null, 'resumed by nobody in particular')
})

test('the administrator\'s report is counts and money per person, with no text in it', () => {
  const r = rig({ AI_PRICE_INPUT_PER_MTOK: '1', AI_PRICE_OUTPUT_PER_MTOK: '2' })
  for (const [who, n] of [['u1', 3], ['u2', 1]]) for (let i = 0; i < n; i++) { const c = r.meter.begin(person(who), 'chat'); c.usage({ promptTokens: 100, completionTokens: 50 }); c.finish() }
  r.meter.begin(person('u1'), 'chat').fail(new Error('x'))
  const report = r.meter.report(7)
  assert.deepEqual(report.map((x) => [x.userId, x.calls, x.chat, x.notOk]), [['u1', 4, 4, 1], ['u2', 1, 1, 0]])
  assert.equal(report[0].tokensIn, 300)
  assert.deepEqual(Object.keys(report[0]).sort(), ['calls', 'chat', 'costMicroUsd', 'notOk', 'sttSeconds', 'tokensIn', 'tokensOut', 'userId', 'vision'])
})

test('a route without a meter (a one-route test) is not limited, but the real server always supplies one', () => {
  const call = NO_METER.begin({}, 'chat')
  assert.doesNotThrow(() => { call.usage({}); call.estimate({}); call.finish(); call.fail(); call.abort() })
})
