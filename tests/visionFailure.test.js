import assert from 'node:assert/strict'
import test from 'node:test'
import { createVisionFromEnv } from '../server/camera/vision.js'

const picture = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }
const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
const answers = (status, body) => async () => ({ ok: false, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
const vision = (provider, fetchFn) => createVisionFromEnv({ CAMERA_VISION_PROVIDER: provider, CAMERA_VISION_API_KEY: 'sk-secret-123', CAMERA_VISION_MODEL: 'm' }, { fetchFn })
const refusal = async (v) => v.read({ messages, image: picture }).then(() => null, (err) => err)

test('a refused key, an account with no billing and one out of credit are named; a plain rate limit is not', async () => {
  const cases = [
    ['openai', 401, { error: { message: 'Incorrect API key provided: sk-secret-123', code: 'invalid_api_key' } }, 'key'],
    ['openai', 429, { error: { message: 'Your account is not active, please check your billing details.', type: 'billing_not_active', code: 'billing_not_active' } }, 'billing'],
    ['openai', 429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } }, 'billing'],
    ['openai', 429, { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, undefined],
    ['anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'billing'],
    ['anthropic', 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'key'],
    ['anthropic', 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your rate limit' } }, undefined],
    ['anthropic', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined]
  ]
  for (const [provider, status, body, reason] of cases) {
    const err = await refusal(vision(provider, answers(status, body)))
    assert.equal(err?.statusCode, status, `${provider} ${status}`)
    assert.equal(err?.reason, reason, `${provider} ${status} ${JSON.stringify(body.error?.code ?? body.error?.type)}`)
    assert.equal(err?.message, `The vision service answered ${status}`, 'the provider\'s own words are never passed on')
    assert.ok(!/sk-secret|credit|billing|quota/i.test(err?.message ?? ''))
  }
})

test('a refusal whose body cannot be read, or is not JSON, is still just its status', async () => {
  for (const fetchFn of [answers(503, '<html>down</html>'), async () => ({ ok: false, status: 503 }), async () => ({ ok: false, status: 503, text: async () => { throw new Error('socket') } })]) {
    const err = await refusal(vision('openai', fetchFn))
    assert.equal(err?.statusCode, 503)
    assert.equal(err?.reason, undefined)
  }
})
