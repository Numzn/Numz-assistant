import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createAnthropicProvider, toAnthropicRequest } from './anthropicProvider.js'
import { createAiProvider } from './providerFactory.js'
import { getAiConfig, probeDeepSeek } from '../../aiConfig.js'

const quiet = { warn() {} }

/** A stand-in for api.anthropic.com: records what it was sent and answers the way the real streaming endpoint does. */
async function withApi(respond, body) {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const parsed = raw ? JSON.parse(raw) : {}
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed })
      respond(req, res, parsed)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await body({ baseUrl: `http://127.0.0.1:${server.address().port}`, seen })
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

const event = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)

/** Streams `words` as text, then ends the way the API does. */
function say(words, { stop = 'end_turn', usage = {} } = {}) {
  return (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    event(res, 'message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 1, ...usage }
      }
    })
    if (words.length) {
      event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      for (const text of words) event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
      event(res, 'content_block_stop', { index: 0 })
    }
    event(res, 'message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } })
    event(res, 'message_stop', {})
    res.end()
  }
}

const fail = (status, message, headers = {}) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }))
}

const base = { apiKey: 'test-key', maxRetries: 0, logger: quiet }
const ask = [{ role: 'user', content: 'hi' }]

test('the system prompt goes in its own field, the conversation starts with the person, and an empty request is refused', () => {
  const request = toAnthropicRequest([
    { role: 'system', content: 'Be Numz.' },
    { role: 'assistant', content: 'Welcome back.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hello.' },
    { role: 'system', content: 'Short.' },
    { role: 'user', content: '   ' },
    { role: 'user', content: 'again' }
  ])
  assert.equal(request.system, 'Be Numz.\n\nShort.')
  assert.deepEqual(request.messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hello.' },
    { role: 'user', content: 'again' }
  ])
  assert.throws(() => toAnthropicRequest([{ role: 'system', content: 'x' }]), (err) => err.statusCode === 400)
  assert.throws(() => toAnthropicRequest([{ role: 'assistant', content: 'x' }]), (err) => err.statusCode === 400)
})

test('a streamed answer arrives piece by piece and whole, with the model, effort and refusal fallback of the default model', async () => {
  await withApi(say(['Hel', 'lo ', 'there.']), async ({ baseUrl, seen }) => {
    const provider = createAnthropicProvider({ ...base, baseUrl })
    const out = []
    for await (const piece of provider.stream({ messages: [{ role: 'system', content: 'Be Numz.' }, ...ask] })) out.push(piece)
    assert.deepEqual(out, [
      { type: 'token', token: 'Hel' },
      { type: 'token', token: 'lo ' },
      { type: 'token', token: 'there.' },
      { type: 'message', content: 'Hello there.' }
    ])
    const [call] = seen
    assert.equal(call.method, 'POST')
    assert.match(call.url, /^\/v1\/messages(\?|$)/)
    assert.equal(call.headers.authorization, 'Bearer test-key', 'the official SDK sends the key as a bearer token')
    assert.equal(call.body.model, 'claude-opus-5-5')
    assert.equal(call.body.stream, true)
    assert.equal(call.body.max_tokens, 64000)
    assert.equal(call.body.system, 'Be Numz.')
    assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hi' }])
    assert.deepEqual(call.body.output_config, { effort: 'medium' })
    assert.equal(call.body.fallbacks, 'default')
    assert.match(String(call.headers['anthropic-beta']), /server-side-fallback-2026-07-01/)
    assert.equal(call.body.thinking, undefined, 'thinking is left to the model')
    assert.equal(call.body.temperature, undefined)
  })
})

test('generate returns the text, and the usage meter is told the counts (cached input included) and nothing of the text', async () => {
  await withApi(say(['  Hi.  ']), async ({ baseUrl }) => {
    const reports = []
    const answer = await createAnthropicProvider({ ...base, baseUrl }).generate({ messages: ask, onUsage: (u) => reports.push(u) })
    assert.equal(answer, 'Hi.')
    assert.deepEqual(reports, [{ promptTokens: 20, completionTokens: 7, model: 'claude-opus-5-5', provider: 'anthropic' }])
  })
})

test('settings: another model, effort and limit are honoured; an older model gets neither effort nor fallback; off means off', async () => {
  await withApi(say(['ok']), async ({ baseUrl, seen }) => {
    await createAnthropicProvider({ ...base, baseUrl, model: 'claude-sonnet-5-5', effort: 'low', maxTokens: '2000' }).generate({ messages: ask })
    await createAnthropicProvider({ ...base, baseUrl, model: 'claude-haiku-4-5' }).generate({ messages: ask })
    await createAnthropicProvider({ ...base, baseUrl, effort: 'off', fallbacks: 'off' }).generate({ messages: ask })
    const [sonnet, haiku, off] = seen.map((s) => s.body)
    assert.equal(sonnet.model, 'claude-sonnet-5-5')
    assert.deepEqual(sonnet.output_config, { effort: 'low' })
    assert.equal(sonnet.max_tokens, 2000)
    assert.equal(sonnet.fallbacks, 'default')
    assert.equal(haiku.output_config, undefined)
    assert.equal(haiku.fallbacks, undefined)
    assert.equal(seen[1].headers['anthropic-beta'], undefined)
    assert.equal(off.output_config, undefined)
    assert.equal(off.fallbacks, undefined)
  })
})

test('a base URL given with /v1 reaches the same place', async () => {
  await withApi(say(['ok']), async ({ baseUrl, seen }) => {
    await createAnthropicProvider({ ...base, baseUrl: `${baseUrl}/v1/` }).generate({ messages: ask })
    assert.match(seen[0].url, /^\/v1\/messages/)
  })
})

test('a model that declines and says nothing still gives the person a sentence', async () => {
  await withApi(say([], { stop: 'refusal' }), async ({ baseUrl }) => {
    const provider = createAnthropicProvider({ ...base, baseUrl })
    assert.equal(await provider.generate({ messages: ask }), "I can't help with that one.")
    const out = []
    for await (const piece of provider.stream({ messages: ask })) out.push(piece)
    assert.deepEqual(out, [{ type: 'message', content: "I can't help with that one." }])
  })
})

test('a missing key is a 503 before anything is sent', async () => {
  await withApi(say(['x']), async ({ baseUrl, seen }) => {
    const provider = createAnthropicProvider({ ...base, baseUrl, apiKey: '' })
    await assert.rejects(provider.generate({ messages: ask }), (err) => err.statusCode === 503 && /AI_API_KEY/.test(err.message))
    await assert.rejects(provider.stream({ messages: ask }).next(), (err) => err.statusCode === 503)
    assert.equal(seen.length, 0)
  })
})

test('a rejected key is not the person\'s sign-in, an empty account says so, a busy provider asks to wait, a wrong model is named', async () => {
  const outcomes = []
  const run = async (respond) =>
    withApi(respond, async ({ baseUrl }) => {
      await createAnthropicProvider({ ...base, baseUrl }).generate({ messages: ask }).then(
        () => outcomes.push(null),
        (err) => outcomes.push({ status: err.statusCode, code: err.code, expose: err.expose, message: err.message, retry: err.retryAfterSeconds })
      )
    })
  await run(fail(401, 'invalid x-api-key'))
  await run(fail(400, 'Your credit balance is too low to access the Anthropic API.'))
  await run(fail(429, 'slow down', { 'retry-after': '4' }))
  await run(fail(404, 'model: claude-nope'))
  await run(fail(400, 'messages: text content blocks must be non-empty'))
  assert.deepEqual(outcomes[0], { status: 502, code: 'ai-provider-rejected', expose: true, message: "The AI provider rejected the server's API key.", retry: undefined })
  assert.equal(outcomes[1].status, 503)
  assert.equal(outcomes[1].code, 'ai-provider-no-credit')
  assert.match(outcomes[1].message, /no credit/)
  assert.equal(outcomes[2].status, 429)
  assert.equal(outcomes[2].retry, 4)
  assert.equal(outcomes[3].status, 502)
  assert.match(outcomes[3].message, /claude-nope/)
  assert.equal(outcomes[4].status, 400, 'a refusal of our own request keeps its status')
  assert.equal(outcomes[4].expose, undefined)
})

test('a request stopped on our side is an AbortError, and a listener that leaves early stops the call', async () => {
  let closed
  const slow = (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    event(res, 'message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'one ' } })
    closed = new Promise((resolve) => res.on('close', resolve))
    // never finishes
  }
  await withApi(slow, async ({ baseUrl }) => {
    const provider = createAnthropicProvider({ ...base, baseUrl })
    const controller = new AbortController()
    const iterator = provider.stream({ messages: ask, signal: controller.signal })
    assert.deepEqual(await iterator.next(), { value: { type: 'token', token: 'one ' }, done: false })
    controller.abort()
    await assert.rejects(iterator.next(), (err) => err.name === 'AbortError')
    await closed
  })
  await withApi(slow, async ({ baseUrl }) => {
    const iterator = createAnthropicProvider({ ...base, baseUrl }).stream({ messages: ask })
    await iterator.next()
    await iterator.return()
    await closed // the connection to the provider is closed, not left running
  })
})

test('the factory builds it from the environment, with the Numz persona when a chat brings no system message', async () => {
  await withApi(say(['hello']), async ({ baseUrl, seen }) => {
    const provider = createAiProvider({ AI_PROVIDER: 'Anthropic', AI_API_KEY: 'k', AI_MODEL: 'claude-sonnet-5-5', AI_BASE_URL: baseUrl, AI_EFFORT: 'high', AI_MAX_TOKENS: '900' })
    assert.equal(provider.name, 'anthropic')
    assert.equal(await provider.generate({ messages: ask }), 'hello')
    assert.match(seen[0].body.system, /You are Numz, a voice assistant/)
    assert.equal(seen[0].body.model, 'claude-sonnet-5-5')
    assert.deepEqual(seen[0].body.output_config, { effort: 'high' })
    assert.equal(seen[0].body.max_tokens, 900)
    await provider.generate({ messages: [{ role: 'system', content: 'Own prompt.' }, ...ask] })
    assert.equal(seen[1].body.system, 'Own prompt.', 'a request with its own system message is untouched')
  })
  await withApi(say(['x']), async ({ baseUrl, seen }) => {
    await createAiProvider({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'k', AI_MODEL: '', AI_BASE_URL: baseUrl }).generate({ messages: ask })
    assert.equal(seen[0].body.model, 'claude-opus-5-5', 'an empty AI_MODEL means the default')
  })
})

test('Claude counts as configured with only a key, and the admin probe reaches it through the provider', async () => {
  assert.equal(getAiConfig({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'k' }).configured, true)
  assert.equal(getAiConfig({ AI_PROVIDER: 'anthropic' }).configured, false)
  assert.equal(getAiConfig({ AI_PROVIDER: 'openai', AI_API_KEY: 'k', AI_MODEL: 'm' }).configured, false, 'the others still need an address')
  await withApi(say(['pong']), async ({ baseUrl, seen }) => {
    const result = await probeDeepSeek({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'k', AI_BASE_URL: baseUrl })
    assert.equal(result.ok, true)
    assert.equal(result.reply, 'pong')
    assert.equal(result.model, 'claude-opus-5-5')
    assert.equal(seen.length, 1)
  })
  const failed = await probeDeepSeek({ AI_PROVIDER: 'anthropic', AI_API_KEY: '' })
  assert.equal(failed.configured, false)
})
