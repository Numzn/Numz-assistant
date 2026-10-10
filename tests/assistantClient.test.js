import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantClient } from '../src/assistant/client.js'

/** Only the session handling is under test: fetch is replaced, and answers when the test says so. */
function withFetch(handler, run) {
  const real = globalThis.fetch
  globalThis.fetch = handler
  return Promise.resolve(run()).finally(() => (globalThis.fetch = real))
}

const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })

test('createSession remembers the new session id', async () => {
  await withFetch(async () => json({ sessionId: 'new-1' }), async () => {
    const client = createAssistantClient()
    await client.createSession({})
    assert.equal(client.getSessionId(), 'new-1')
  })
})

test('useSession chooses an existing session, and createSession no longer overrides it', async () => {
  await withFetch(async () => json({ sessionId: 'new-1' }), async () => {
    const client = createAssistantClient()
    client.useSession('saved-1')
    assert.equal(client.getSessionId(), 'saved-1')
    await client.createSession({})
    assert.equal(client.getSessionId(), 'new-1', 'a later, deliberate createSession (New chat) still works')
  })
})

test('a createSession that was already in flight cannot overwrite a saved conversation chosen meanwhile (the page-load race)', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  await withFetch(async () => {
    await gate // the server answers late
    return json({ sessionId: 'fresh-empty-session' })
  }, async () => {
    const client = createAssistantClient()
    const creating = client.createSession({}) // page load: asks for a new session...
    client.useSession('saved-1') // ...while the saved conversation is opened
    release()
    await creating
    assert.equal(client.getSessionId(), 'saved-1', 'the saved conversation stays the current session')
  })
})

test('useSession ignores an empty or non-string id', () => {
  const client = createAssistantClient()
  client.useSession('keep-me')
  client.useSession('')
  client.useSession(null)
  client.useSession(42)
  assert.equal(client.getSessionId(), 'keep-me')
})

// Every call that echoes a session id back must respect a session chosen while it was in flight.
for (const [name, call, answer] of [
  ['getState', (client) => client.getState(), { sessionId: 'old-session', state: 'IDLE' }],
  ['setState', (client) => client.setState('IDLE'), { sessionId: 'old-session', state: 'IDLE' }],
  ['sendMessage', (client) => client.sendMessage('hello'), { sessionId: 'old-session', reply: 'hi' }]
]) {
  test(`a late ${name} answer for the old session does not undo a saved conversation chosen meanwhile`, async () => {
    let release
    const gate = new Promise((resolve) => (release = resolve))
    await withFetch(async () => {
      await gate
      return json(answer)
    }, async () => {
      const client = createAssistantClient()
      client.useSession('old-session')
      const inFlight = call(client) // asked while 'old-session' was current (the app's startup calls)
      client.useSession('saved-1') // the user opens a saved conversation
      release()
      await inFlight
      assert.equal(client.getSessionId(), 'saved-1')
    })
  })
}

test('a streamed reply for the old session does not undo a saved conversation chosen meanwhile', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const body = {
    getReader: () => {
      let done = false
      return {
        read: async () => {
          await gate
          if (done) return { done: true }
          done = true
          return { done: false, value: new TextEncoder().encode('event: message\ndata: {"reply":"hi","sessionId":"old-session"}\n\n') }
        }
      }
    }
  }
  await withFetch(async () => ({ ok: true, status: 200, body }), async () => {
    const client = createAssistantClient()
    const streaming = client.streamMessage('hello', {})
    client.useSession('saved-1')
    release()
    await streaming
    assert.equal(client.getSessionId(), 'saved-1')
  })
})

test('without a deliberate choice the server answer still sets the session (nothing else changed)', async () => {
  await withFetch(async () => json({ sessionId: 'server-chosen', state: 'IDLE' }), async () => {
    const client = createAssistantClient()
    await client.getState()
    assert.equal(client.getSessionId(), 'server-chosen')
  })
})
