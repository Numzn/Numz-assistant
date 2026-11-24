import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiProvider } from './providerFactory.js'

/** Replaces fetch for one test and records what the provider sent. */
async function withFetch(reply, body) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    return reply(init)
  }
  try {
    await body(calls)
  } finally {
    globalThis.fetch = real
  }
}

const json = (content) => ({ ok: true, status: 200, json: async () => ({ model: 'm', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), text: async () => '' })
const sse = (words) => {
  const encoder = new TextEncoder()
  const chunks = [...words.map((w) => `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`), 'data: [DONE]\n\n']
  let i = 0
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: encoder.encode(chunks[i++]), done: false } : { value: undefined, done: true }) }) } }
}
const env = { AI_PROVIDER: 'openai', AI_API_KEY: 'test-key', AI_MODEL: 'test-model' }

test('the OpenAI provider talks to OpenAI with the chosen model, and gives a chat with no system message the Numz persona', async () => {
  await withFetch(() => json('hello'), async (calls) => {
    const provider = createAiProvider(env)
    assert.equal(provider.name, 'openai')
    assert.equal(await provider.generate({ messages: [{ role: 'user', content: 'hi' }] }), 'hello')
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions')
    assert.equal(calls[0].body.model, 'test-model')
    assert.equal(calls[0].headers.Authorization, 'Bearer test-key')
    assert.equal(calls[0].body.messages[0].role, 'system')
    assert.match(calls[0].body.messages[0].content, /You are Numz, a voice assistant/)
    assert.deepEqual(calls[0].body.messages.slice(1), [{ role: 'user', content: 'hi' }])
  })
})

test('a request that brings its own system message keeps it, with no persona added (meetings, camera and study write their own)', async () => {
  await withFetch(() => json('ok'), async (calls) => {
    await createAiProvider(env).generate({ messages: [{ role: 'system', content: 'Only summarise.' }, { role: 'user', content: 'x' }] })
    assert.deepEqual(calls[0].body.messages.map((m) => m.content), ['Only summarise.', 'x'])
  })
})

test('streaming gets the persona too, and still asks for token counts', async () => {
  await withFetch(() => sse(['Hel', 'lo']), async (calls) => {
    const events = []
    for await (const e of createAiProvider(env).stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
    assert.equal(calls[0].body.stream, true)
    assert.deepEqual(calls[0].body.stream_options, { include_usage: true })
    assert.match(calls[0].body.messages[0].content, /You are Numz/)
    assert.ok(events.length > 0)
  })
})

test('DeepSeek keeps the same persona, and a custom provider is left exactly as it was (the test servers rely on that)', async () => {
  await withFetch(() => json('d'), async (calls) => {
    await createAiProvider({ AI_PROVIDER: 'deepseek', AI_API_KEY: 'k', AI_MODEL: 'm' }).generate({ messages: [{ role: 'user', content: 'hi' }] })
    await createAiProvider({ AI_PROVIDER: 'custom', AI_API_KEY: 'k', AI_MODEL: 'm', AI_BASE_URL: 'http://127.0.0.1:1/v1' }).generate({ messages: [{ role: 'user', content: 'hi' }] })
    assert.match(calls[0].body.messages[0].content, /You are Numz/)
    assert.deepEqual(calls[1].body.messages, [{ role: 'user', content: 'hi' }])
  })
})

test('a service that ignores stream: true and answers with one ordinary completion still gives its answer', async () => {
  // like a real response: once a reader has been taken from the body, it can no longer be read as text
  const plain = (content) => {
    let locked = false
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
      body: { getReader: () => ((locked = true), { read: async () => ({ value: undefined, done: true }) }) },
      text: async () => {
        if (locked) throw new TypeError('Body is unusable: Body has already been read')
        return JSON.stringify({ model: 'm', choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 3 } })
      }
    }
  }
  await withFetch(() => plain('The window is blue.'), async (calls) => {
    const provider = createAiProvider(env)
    const seen = []
    const usage = []
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }], onUsage: (u) => usage.push(u) })) seen.push(chunk)
    assert.equal(calls[0].body.stream, true)
    assert.deepEqual(seen, [{ type: 'message', content: 'The window is blue.' }])
    assert.deepEqual([usage[0].promptTokens, usage[0].completionTokens], [7, 3])
  })
})
