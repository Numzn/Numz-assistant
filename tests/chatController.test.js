import assert from 'node:assert/strict'
import test from 'node:test'
import { createEventBus } from '../src/core/events/eventBus.js'
import { createChatController, EMPTY_REPLY_TEXT, ERROR_TEXT } from '../src/interfaces/chat/chatController.js'

/**
 * The Home conversation. The assistant controller is a stand-in that emits the same events the real one does
 * (turn:start, assistant:token, ai:response, turn:interrupt, error:recoverable); tests/assistantController.test.js
 * covers the real controller against the real state machine.
 */

function rig({ reply = 'Hello there', tokens = ['Hello', ' there'], fail = false, hold = false, ...options } = {}) {
  const eventBus = createEventBus()
  const calls = { submit: [], interrupt: 0, sessions: 0 }
  let release = null
  let sessionError = null
  const assistantController = {
    async submitText(text) {
      calls.submit.push(text)
      eventBus.emit('turn:start', { inputType: 'text', text })
      if (hold) await new Promise((resolve) => (release = resolve))
      if (fail) {
        eventBus.emit('error:recoverable', { source: 'assistant:requestReply' })
        return null
      }
      for (const token of tokens) eventBus.emit('assistant:token', { token })
      eventBus.emit('ai:response', { reply })
      return reply
    },
    async interrupt() {
      calls.interrupt += 1
      eventBus.emit('turn:interrupt', {})
      release?.()
    }
  }
  const assistantClient = {
    async createSession() {
      calls.sessions += 1
      if (sessionError) throw sessionError
      return { sessionId: `s${calls.sessions}` }
    }
  }
  const chat = createChatController({ assistantController, assistantClient, eventBus, ...options })
  return {
    chat,
    eventBus,
    calls,
    failSessions: (err) => (sessionError = err),
    releaseTurn: () => release?.(),
    text: () => chat.getState().messages.map((m) => `${m.role}:${m.status}:${m.text}`)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('sending text uses the existing request path and shows the exchange', async () => {
  const r = rig()
  const result = await r.chat.send('  What is the speed limit?  ')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(r.calls.submit, ['What is the speed limit?'], 'trimmed, sent once, through submitText')
  assert.deepEqual(r.text(), ['user:done:What is the speed limit?', 'assistant:done:Hello there'])
  assert.equal(r.chat.getState().busy, false)
})

test('while the reply streams, the assistant message grows and the chat is busy (thinking state)', async () => {
  const r = rig({ hold: true })
  const sending = r.chat.send('hello')
  await tick()
  let state = r.chat.getState()
  assert.equal(state.busy, true)
  assert.deepEqual(r.text(), ['user:done:hello', 'assistant:thinking:'], 'a thinking placeholder, no text yet')

  r.eventBus.emit('assistant:token', { token: 'Hel' })
  r.eventBus.emit('assistant:token', { token: 'lo' })
  assert.deepEqual(r.text().at(-1), 'assistant:streaming:Hello')

  r.releaseTurn()
  await sending
  assert.equal(r.chat.getState().busy, false)
})

test('empty text is ignored, and a second message cannot be sent while one is in flight', async () => {
  const r = rig({ hold: true })
  assert.deepEqual(await r.chat.send('   '), { ok: false, reason: 'empty' })
  const first = r.chat.send('one')
  await tick()
  assert.deepEqual(await r.chat.send('two'), { ok: false, reason: 'busy' })
  r.releaseTurn()
  await first
  assert.deepEqual(r.calls.submit, ['one'])
})

test('a failed request shows an error on the reply, keeps the question, and offers retry', async () => {
  const r = rig({ fail: true })
  await r.chat.send('hello')
  const [user, assistant] = r.chat.getState().messages
  assert.equal(user.text, 'hello')
  assert.equal(assistant.status, 'error')
  assert.equal(assistant.text, ERROR_TEXT)
  assert.equal(assistant.retryText, 'hello')
  assert.equal(r.chat.getState().busy, false, 'the composer is usable again')
})

test('retry on the same controller resends once and replaces the failed reply', async () => {
  const eventBus = createEventBus()
  let attempt = 0
  const submitted = []
  const assistantController = {
    async submitText(text) {
      attempt += 1
      submitted.push(text)
      eventBus.emit('turn:start', { text })
      if (attempt === 1) {
        eventBus.emit('error:recoverable', {})
        return null
      }
      eventBus.emit('ai:response', { reply: 'Second time lucky' })
      return 'Second time lucky'
    }
  }
  const chat = createChatController({ assistantController, assistantClient: {}, eventBus })
  await chat.send('hello')
  const failed = chat.getState().messages[1]
  assert.equal(failed.status, 'error')

  await chat.retry(failed.id)

  assert.deepEqual(submitted, ['hello', 'hello'])
  const rows = chat.getState().messages.map((m) => `${m.role}:${m.status}:${m.text}`)
  assert.deepEqual(rows, ['user:done:hello', 'assistant:done:Second time lucky'], 'one question, one answer, no leftover error')
})

test('cancel stops a reply in flight; a partial reply is kept and marked stopped', async () => {
  const r = rig({ hold: true })
  const sending = r.chat.send('tell me a story')
  await tick()
  r.eventBus.emit('assistant:token', { token: 'Once upon' })
  assert.equal(await r.chat.cancel(), true)
  await sending
  assert.equal(r.calls.interrupt, 1)
  assert.deepEqual(r.text(), ['user:done:tell me a story', 'assistant:stopped:Once upon'])
  assert.equal(r.chat.getState().busy, false)
})

test('cancelling before any text arrives removes the empty reply instead of leaving a blank bubble', async () => {
  const r = rig({ hold: true })
  const sending = r.chat.send('hello')
  await tick()
  await r.chat.cancel()
  await sending
  assert.deepEqual(r.text(), ['user:done:hello'])
})

test('cancel uses the interrupt it is given (voice playback as well as the stream)', async () => {
  let custom = 0
  const r = rig({ hold: true, interrupt: async () => (custom += 1) })
  const sending = r.chat.send('hello')
  await tick()
  await r.chat.cancel()
  assert.equal(custom, 1)
  assert.equal(r.calls.interrupt, 0)
  r.releaseTurn()
  await sending
})

test('cancel with nothing in flight does nothing', async () => {
  const r = rig()
  assert.equal(await r.chat.cancel(), false)
  assert.equal(r.calls.interrupt, 0)
})

test('a reply that comes back empty is shown as a problem, not as a blank message', async () => {
  const r = rig({ reply: '   ', tokens: [] })
  await r.chat.send('hello')
  const assistant = r.chat.getState().messages[1]
  assert.equal(assistant.status, 'error')
  assert.equal(assistant.text, EMPTY_REPLY_TEXT)
})

test('messages are not sent while voice mode or a meeting blocks them, and the user is told why', async () => {
  let reason = 'meeting'
  const r = rig({ isBlocked: () => reason })
  assert.deepEqual(await r.chat.send('hello'), { ok: false, reason: 'meeting' })
  assert.deepEqual(r.calls.submit, [])
  assert.match(r.chat.getState().messages[0].text, /meeting is recording/i)

  reason = 'voice'
  await r.chat.send('hello')
  assert.match(r.chat.getState().messages.at(-1).text, /voice mode is on/i)

  reason = null
  assert.deepEqual(await r.chat.send('hello'), { ok: true })
  assert.deepEqual(r.calls.submit, ['hello'])
})

test('a meeting command is answered locally and never reaches the assistant', async () => {
  const commands = { handle: async (text) => (text === 'start meeting' ? { reply: 'Opened the meeting panel.' } : null) }
  const r = rig({ commands })
  const result = await r.chat.send('start meeting')
  assert.deepEqual(result, { ok: true, handled: true })
  assert.deepEqual(r.calls.submit, [])
  assert.deepEqual(r.text(), ['user:done:start meeting', 'assistant:done:Opened the meeting panel.'])

  await r.chat.send('what is a meeting')
  assert.deepEqual(r.calls.submit, ['what is a meeting'], 'other text still goes to the assistant')
})

test('a meeting command works even while a meeting blocks ordinary messages', async () => {
  const commands = { handle: async () => ({ reply: 'Stop and save the meeting? Reply yes to confirm.' }) }
  const r = rig({ commands, isBlocked: () => 'meeting' })
  const result = await r.chat.send('stop meeting')
  assert.equal(result.handled, true)
  assert.deepEqual(r.calls.submit, [])
})

test('a command that throws is reported, not swallowed', async () => {
  const r = rig({ commands: { handle: async () => { throw new Error('boom') } } })
  const result = await r.chat.send('start meeting')
  assert.deepEqual(result, { ok: false, reason: 'command-error' })
  assert.equal(r.chat.getState().messages.at(-1).status, 'error')
})

test('a spoken turn appears in the same thread through the same events', () => {
  const r = rig()
  r.eventBus.emit('turn:start', { inputType: 'text', text: 'what time is it' })
  r.eventBus.emit('assistant:token', { token: 'It is ' })
  r.eventBus.emit('assistant:token', { token: 'noon.' })
  r.eventBus.emit('ai:response', { reply: 'It is noon.' })
  assert.deepEqual(r.text(), ['user:done:what time is it', 'assistant:done:It is noon.'])
})

test('a meeting command heard by voice is added to the thread', () => {
  const r = rig()
  r.eventBus.emit('command:handled', { text: 'start a meeting', reply: 'Opened the meeting panel.' })
  assert.deepEqual(r.text(), ['user:done:start a meeting', 'assistant:done:Opened the meeting panel.'])
})

test('a new conversation makes a new server session and clears the thread', async () => {
  const r = rig()
  await r.chat.send('hello')
  assert.equal(r.chat.getState().messages.length, 2)
  assert.equal(await r.chat.newChat(), true)
  assert.equal(r.calls.sessions, 1)
  assert.deepEqual(r.chat.getState().messages, [])
})

test('if the new session cannot be created the old conversation is kept and the user is told', async () => {
  const r = rig()
  await r.chat.send('hello')
  r.failSessions(new Error('offline'))
  assert.equal(await r.chat.newChat(), false)
  const rows = r.text()
  assert.equal(rows[0], 'user:done:hello')
  assert.match(rows.at(-1), /Could not start a new conversation/)
})

test('starting a new conversation while a reply is in flight stops that reply first', async () => {
  const r = rig({ hold: true })
  const sending = r.chat.send('long one')
  await tick()
  await r.chat.newChat()
  await sending
  assert.equal(r.calls.interrupt, 1)
  assert.deepEqual(r.chat.getState().messages, [])
})

test('subscribers get snapshots they cannot use to change the thread', async () => {
  const r = rig()
  const seen = []
  const off = r.chat.subscribe((state) => seen.push(state))
  await r.chat.send('hello')
  assert.ok(seen.length >= 2)
  seen.at(-1).messages[0].text = 'tampered'
  assert.equal(r.chat.getState().messages[0].text, 'hello')
  off()
  const count = seen.length
  await r.chat.send('again')
  assert.equal(seen.length, count, 'unsubscribed')
})

// ---- attachments -------------------------------------------------------------------------------------------

const csv = { name: 'prices.csv', size: 12, text: 'item,price\nwidget,5' }

test('a message with a file sends the composed text but the thread shows only the typed text and the file name', async () => {
  const r = rig()
  await r.chat.send('Summarise this', { attachments: [csv] })
  assert.match(r.calls.submit[0], /^Summarise this\n\n\[Attached file: prices\.csv\]\n```\nitem,price\nwidget,5\n```$/)
  const [user] = r.chat.getState().messages
  assert.equal(user.text, 'Summarise this')
  assert.deepEqual(user.attachments, [{ name: 'prices.csv', size: 12 }])
  assert.ok(!JSON.stringify(r.chat.getState().messages).includes('widget,5'), 'the file contents are not in the thread')
})

test('a file alone is a valid message', async () => {
  const r = rig()
  assert.deepEqual(await r.chat.send('', { attachments: [csv] }), { ok: true })
  assert.match(r.calls.submit[0], /^\[Attached file: prices\.csv\]/)
  assert.equal(r.chat.getState().messages[0].text, '')
})

test('no text and no file is still empty', async () => {
  const r = rig()
  assert.deepEqual(await r.chat.send('  ', { attachments: [] }), { ok: false, reason: 'empty' })
})

test('a meeting command phrase with a file attached is an ordinary message, not a command', async () => {
  let handled = 0
  const r = rig({ commands: { handle: async () => { handled += 1; return { reply: 'x' } } } })
  await r.chat.send('start a meeting', { attachments: [csv] })
  assert.equal(handled, 0)
  assert.equal(r.calls.submit.length, 1)
})

test('retry resends the same file and shows the same message, once', async () => {
  const eventBus = createEventBus()
  let attempt = 0
  const submitted = []
  const assistantController = {
    async submitText(text) {
      attempt += 1
      submitted.push(text)
      eventBus.emit('turn:start', { text })
      if (attempt === 1) {
        eventBus.emit('error:recoverable', {})
        return null
      }
      eventBus.emit('ai:response', { reply: 'Done.' })
      return 'Done.'
    }
  }
  const chat = createChatController({ assistantController, assistantClient: {}, eventBus })
  await chat.send('Summarise this', { attachments: [csv] })
  await chat.retry(chat.getState().messages[1].id)
  assert.equal(submitted.length, 2)
  assert.equal(submitted[0], submitted[1], 'the same composed text, file included')
  const rows = chat.getState().messages
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].attachments, [{ name: 'prices.csv', size: 12 }])
})

test('files are refused while a meeting blocks messages, and nothing is sent', async () => {
  const r = rig({ isBlocked: () => 'meeting' })
  assert.deepEqual(await r.chat.send('hi', { attachments: [csv] }), { ok: false, reason: 'meeting' })
  assert.deepEqual(r.calls.submit, [])
})

// ---- opening a saved conversation ---------------------------------------------------------------------------

test('opening a saved conversation replaces the thread, shows attached files as chips, and continues the same session', async () => {
  const used = []
  const eventBus = createEventBus()
  const chat = createChatController({
    assistantController: { submitText: async () => null, interrupt: async () => {} },
    assistantClient: { useSession: (id) => used.push(id), createSession: async () => ({}) },
    eventBus
  })
  await chat.open({
    id: 'saved-1',
    messages: [
      { role: 'user', content: 'Summarise this\n\n[Attached file: prices.csv]\n```\nitem,price\nwidget,5\n```' },
      { role: 'assistant', content: 'Widgets cost **5**.' },
      { role: 'system', content: 'never shown' },
      { role: 'user', content: 'Thanks' }
    ]
  })
  assert.deepEqual(used, ['saved-1'], 'the next message goes to the saved session, so the assistant has its context')
  const rows = chat.getState().messages
  assert.deepEqual(rows.map((m) => `${m.role}:${m.text}`), ['user:Summarise this', 'assistant:Widgets cost **5**.', 'user:Thanks'])
  assert.deepEqual(rows[0].attachments, [{ name: 'prices.csv', size: 'item,price\nwidget,5'.length }])
  assert.ok(!JSON.stringify(rows).includes('widget,5'), 'file contents are not shown')
  assert.ok(rows.every((m) => m.status === 'done'))
})

test('opening a conversation while a reply is in flight stops that reply first', async () => {
  const r = rig({ hold: true })
  const sending = r.chat.send('long one')
  await tick()
  await r.chat.open({ id: 'other', messages: [{ role: 'user', content: 'old question' }] })
  await sending
  assert.equal(r.calls.interrupt, 1)
  assert.deepEqual(r.chat.getState().messages.map((m) => m.text), ['old question'])
  assert.equal(r.chat.getState().busy, false)
})

test('a conversation with no messages opens as an empty thread', async () => {
  const r = rig()
  await r.chat.send('hello')
  await r.chat.open({ id: 'empty', messages: [] })
  assert.deepEqual(r.chat.getState().messages, [])
})
