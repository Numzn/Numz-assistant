import assert from 'node:assert/strict'
import test from 'node:test'
import { createUnconfiguredVision, createVisionFromEnv, describeVision } from '../server/camera/vision.js'

/**
 * The vision adapters, against a fake `fetch`. These pin the request each provider is sent (so a change to it is a
 * deliberate one) and how its reply and its failures are read. They do NOT prove the provider accepts the request:
 * that needs a real key and one real call.
 */

const KEY = 'sk-test-key-do-not-leak-0123456789'
const image = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mimeType: 'image/jpeg' }
const messages = [
  { role: 'system', content: 'You read photographs.' },
  { role: 'user', content: 'Read the question shown in this picture.' }
]

function fakeFetch(reply) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const r = typeof reply === 'function' ? await reply(calls.length) : reply
    return { ok: r.status < 400, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)), json: async () => r.body }
  }
  fn.calls = calls
  return fn
}

const openAiEnv = { CAMERA_VISION_PROVIDER: 'openai-compatible', CAMERA_VISION_API_KEY: KEY, CAMERA_VISION_MODEL: 'some-vision-model', CAMERA_VISION_BASE_URL: 'https://vision.example.com/v1' }
const openaiEnv = { CAMERA_VISION_PROVIDER: 'openai', CAMERA_VISION_API_KEY: KEY, CAMERA_VISION_MODEL: 'some-openai-model' }
const anthropicEnv = { CAMERA_VISION_PROVIDER: 'anthropic', CAMERA_VISION_API_KEY: KEY, CAMERA_VISION_MODEL: 'some-claude-model' }

// ---- configuration -------------------------------------------------------------------------------------------------

test('nothing is configured until a provider, a key and a model are all given', () => {
  assert.equal(createVisionFromEnv({}).configured, false)
  assert.equal(createVisionFromEnv({ CAMERA_VISION_PROVIDER: 'anthropic' }).configured, false)
  assert.equal(createVisionFromEnv({ ...anthropicEnv, CAMERA_VISION_API_KEY: '' }).configured, false)
  assert.equal(createVisionFromEnv({ ...anthropicEnv, CAMERA_VISION_MODEL: '' }).configured, false, 'no silent default model: it decides the cost')
  assert.equal(createVisionFromEnv({ ...openAiEnv, CAMERA_VISION_BASE_URL: '' }).configured, false, 'an OpenAI-compatible service needs its address')
  assert.equal(createVisionFromEnv({ ...anthropicEnv, CAMERA_VISION_PROVIDER: 'carrier-pigeon' }).configured, false)
  assert.equal(createVisionFromEnv(anthropicEnv).configured, true)
  assert.equal(createVisionFromEnv(openAiEnv).configured, true)
  assert.equal(createVisionFromEnv(openaiEnv).configured, true, 'OpenAI itself needs no address')
  assert.equal(createVisionFromEnv({ ...openaiEnv, CAMERA_VISION_MODEL: '' }).configured, false)
})

test('an unconfigured vision refuses to read, and says which setting is missing without printing any value', async () => {
  const vision = createUnconfiguredVision()
  assert.equal(vision.configured, false)
  await assert.rejects(vision.read({ messages, image }), (err) => err.statusCode === 503)
  assert.match(describeVision(createVisionFromEnv({ CAMERA_VISION_PROVIDER: 'anthropic', CAMERA_VISION_API_KEY: KEY })), /CAMERA_VISION_MODEL/)
  assert.doesNotMatch(describeVision(createVisionFromEnv({ CAMERA_VISION_PROVIDER: 'anthropic', CAMERA_VISION_API_KEY: KEY })), new RegExp(KEY))
  assert.match(describeVision(createVisionFromEnv({})), /not configured/i)
  assert.match(describeVision(createVisionFromEnv(anthropicEnv)), /anthropic/)
  assert.doesNotMatch(describeVision(createVisionFromEnv(anthropicEnv)), new RegExp(KEY))
})

// ---- OpenAI-compatible ---------------------------------------------------------------------------------------------

test('OpenAI-compatible: the picture goes as a data URL in a chat completion, the system prompt stays a system message', async () => {
  const fetchFn = fakeFetch({ status: 200, body: { choices: [{ message: { content: '{"isQuestion":true}' } }] } })
  const vision = createVisionFromEnv(openAiEnv, { fetchFn })
  const signal = new AbortController().signal
  const text = await vision.read({ messages, image, signal })
  assert.equal(text, '{"isQuestion":true}')

  const [{ url, init, body }] = fetchFn.calls
  assert.equal(url, 'https://vision.example.com/v1/chat/completions')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`)
  assert.equal(init.signal, signal)
  assert.equal(body.model, 'some-vision-model')
  assert.equal(body.temperature, 0)
  assert.ok(body.max_tokens > 0)
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You read photographs.' })
  assert.equal(body.messages[1].role, 'user')
  const [textPart, imagePart] = body.messages[1].content
  assert.deepEqual(textPart, { type: 'text', text: 'Read the question shown in this picture.' })
  assert.equal(imagePart.type, 'image_url')
  assert.equal(imagePart.image_url.url, `data:image/jpeg;base64,${image.bytes.toString('base64')}`)
})

test('OpenAI-compatible: a base address with or without /v1 or a trailing slash works the same', async () => {
  for (const base of ['https://v.example.com', 'https://v.example.com/', 'https://v.example.com/v1', 'https://v.example.com/v1/']) {
    const fetchFn = fakeFetch({ status: 200, body: { choices: [{ message: { content: 'x' } }] } })
    await createVisionFromEnv({ ...openAiEnv, CAMERA_VISION_BASE_URL: base }, { fetchFn }).read({ messages, image })
    assert.equal(fetchFn.calls[0].url, 'https://v.example.com/v1/chat/completions', base)
  }
})

test('OpenAI-compatible: a failure carries the status and never the key or the provider\'s message', async () => {
  const fetchFn = fakeFetch({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } })
  await assert.rejects(createVisionFromEnv(openAiEnv, { fetchFn }).read({ messages, image }), (err) => err.statusCode === 401 && !err.message.includes(KEY) && !/incorrect api key/i.test(err.message))
})

test('OpenAI-compatible: a reply with nothing in it is an error, not an empty string to parse', async () => {
  const fetchFn = fakeFetch({ status: 200, body: { choices: [] } })
  await assert.rejects(createVisionFromEnv(openAiEnv, { fetchFn }).read({ messages, image }), /no text/i)
})

// ---- OpenAI itself -----------------------------------------------------------------------------------------------

test('OpenAI: the request uses the parameters its newer models accept (max_completion_tokens, no temperature, no max_tokens)', async () => {
  const fetchFn = fakeFetch({ status: 200, body: { choices: [{ message: { content: '{"isQuestion":true}' } }] } })
  const vision = createVisionFromEnv(openaiEnv, { fetchFn })
  assert.equal(vision.name, 'openai')
  const text = await vision.read({ messages, image })
  assert.equal(text, '{"isQuestion":true}')

  const [{ url, init, body }] = fetchFn.calls
  assert.equal(url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`)
  assert.equal(body.model, 'some-openai-model')
  assert.ok(body.max_completion_tokens >= 1000, 'room for a model that thinks before it answers')
  assert.equal('max_tokens' in body, false, 'OpenAI refuses it for newer models')
  assert.equal('temperature' in body, false, 'and refuses a temperature other than the default')
  assert.equal('reasoning_effort' in body, false, 'not sent unless asked for: non-reasoning models refuse it')
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You read photographs.' })
  const [textPart, imagePart] = body.messages[1].content
  assert.deepEqual(textPart, { type: 'text', text: 'Read the question shown in this picture.' })
  assert.equal(imagePart.image_url.url, `data:image/jpeg;base64,${image.bytes.toString('base64')}`)
})

test('OpenAI: an address can still be given (a gateway or Azure-style proxy)', async () => {
  const fetchFn = fakeFetch({ status: 200, body: { choices: [{ message: { content: 'x' } }] } })
  await createVisionFromEnv({ ...openaiEnv, CAMERA_VISION_BASE_URL: 'https://gateway.example.com/openai/' }, { fetchFn }).read({ messages, image })
  assert.equal(fetchFn.calls[0].url, 'https://gateway.example.com/openai/v1/chat/completions')
})

test('OpenAI: a reasoning effort can be chosen to trade thinking time for speed, and only a known one is sent', async () => {
  for (const effort of ['minimal', 'low', 'medium', 'high']) {
    const fetchFn = fakeFetch({ status: 200, body: { choices: [{ message: { content: 'x' } }] } })
    await createVisionFromEnv({ ...openaiEnv, CAMERA_VISION_REASONING_EFFORT: effort }, { fetchFn }).read({ messages, image })
    assert.equal(fetchFn.calls[0].body.reasoning_effort, effort)
  }
  for (const bad of ['', 'fast', 'LOW!', '0']) {
    const fetchFn = fakeFetch({ status: 200, body: { choices: [{ message: { content: 'x' } }] } })
    await createVisionFromEnv({ ...openaiEnv, CAMERA_VISION_REASONING_EFFORT: bad }, { fetchFn }).read({ messages, image })
    assert.equal('reasoning_effort' in fetchFn.calls[0].body, false, JSON.stringify(bad))
  }
  const compatible = fakeFetch({ status: 200, body: { choices: [{ message: { content: 'x' } }] } })
  await createVisionFromEnv({ ...openAiEnv, CAMERA_VISION_REASONING_EFFORT: 'low' }, { fetchFn: compatible }).read({ messages, image })
  assert.equal('reasoning_effort' in compatible.calls[0].body, false, 'other services are not sent what only OpenAI defines')
})

test('OpenAI: failures never carry the key or the provider\'s words, and an empty reply is an error', async () => {
  const rejected = fakeFetch({ status: 400, body: { error: { message: `Unsupported parameter, key ${KEY}` } } })
  await assert.rejects(createVisionFromEnv(openaiEnv, { fetchFn: rejected }).read({ messages, image }), (err) => err.statusCode === 400 && !err.message.includes(KEY) && !/unsupported/i.test(err.message))
  const empty = fakeFetch({ status: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } })
  await assert.rejects(createVisionFromEnv(openaiEnv, { fetchFn: empty }).read({ messages, image }), /no text/i)
})

test('the generic OpenAI-compatible mode is unchanged: other services still get max_tokens and a temperature of 0', async () => {
  const fetchFn = fakeFetch({ status: 200, body: { choices: [{ message: { content: 'x' } }] } })
  await createVisionFromEnv(openAiEnv, { fetchFn }).read({ messages, image })
  const { body } = fetchFn.calls[0]
  assert.equal(body.temperature, 0)
  assert.ok(body.max_tokens > 0)
  assert.equal('max_completion_tokens' in body, false)
})

// ---- Anthropic ---------------------------------------------------------------------------------------------------

test('Anthropic: the picture goes as a base64 image block in a Messages request, with the system prompt in its own field', async () => {
  const fetchFn = fakeFetch({ status: 200, body: { content: [{ type: 'text', text: '{"isQuestion":' }, { type: 'text', text: 'true}' }] } })
  const vision = createVisionFromEnv(anthropicEnv, { fetchFn })
  const text = await vision.read({ messages, image })
  assert.equal(text, '{"isQuestion":true}', 'text blocks are joined')

  const [{ url, init, body }] = fetchFn.calls
  assert.equal(url, 'https://api.anthropic.com/v1/messages')
  assert.equal(init.headers['x-api-key'], KEY)
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.equal(body.model, 'some-claude-model')
  assert.ok(body.max_tokens > 0)
  assert.equal(body.system, 'You read photographs.')
  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.bytes.toString('base64') } },
        { type: 'text', text: 'Read the question shown in this picture.' }
      ]
    }
  ])
})

test('Anthropic: a base address can be set (a proxy or gateway), and failures never leak the key or the provider\'s words', async () => {
  const fetchFn = fakeFetch({ status: 529, body: { error: { message: `overloaded for ${KEY}` } } })
  const vision = createVisionFromEnv({ ...anthropicEnv, CAMERA_VISION_BASE_URL: 'https://gateway.example.com/' }, { fetchFn })
  await assert.rejects(vision.read({ messages, image }), (err) => err.statusCode === 529 && !err.message.includes(KEY) && !/overloaded/.test(err.message))
  assert.equal(fetchFn.calls[0].url, 'https://gateway.example.com/v1/messages')
})

test('both adapters can answer a question that depends on a figure, with the same picture', async () => {
  const answerMessages = [{ role: 'system', content: 'You help a student.' }, { role: 'user', content: '<question>\nArea of the triangle?\n</question>' }]
  const a = fakeFetch({ status: 200, body: { content: [{ type: 'text', text: 'ok' }] } })
  const o = fakeFetch({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } })
  assert.equal(await createVisionFromEnv(anthropicEnv, { fetchFn: a }).answer({ messages: answerMessages, image }), 'ok')
  assert.equal(await createVisionFromEnv(openAiEnv, { fetchFn: o }).answer({ messages: answerMessages, image }), 'ok')
  assert.equal(a.calls[0].body.messages[0].content[0].source.data, image.bytes.toString('base64'))
  assert.match(o.calls[0].body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/)
})

test('the picture is sent to the provider and nowhere else: only one request is made per call', async () => {
  const fetchFn = fakeFetch({ status: 200, body: { content: [{ type: 'text', text: 'ok' }] } })
  await createVisionFromEnv(anthropicEnv, { fetchFn }).read({ messages, image })
  assert.equal(fetchFn.calls.length, 1)
})
