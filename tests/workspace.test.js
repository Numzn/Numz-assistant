import assert from 'node:assert/strict'
import test from 'node:test'
import { greetingFor } from '../src/interfaces/chat/chatView.js'
import { createRecentConversations, enableWebFonts, loadModelLabel, watchOnline } from '../src/interfaces/layout/workspace.js'
import { isLowBandwidth } from '../src/utils/network.js'
import { formatElapsed } from '../src/interfaces/meeting/meetingPanel.js'

const conversation = (id, title = id) => ({ id, title, createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:00:00Z', messageCount: 2 })

function fakeChat() {
  const listeners = new Set()
  const opened = []
  return {
    opened,
    open: async (c) => opened.push(c),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (state) => listeners.forEach((listener) => listener({ busy: false, messages: [], ...state }))
  }
}

function fakeApi({ list, get = async (id) => ({ id, messages: [] }) } = {}) {
  const calls = { list: 0, get: [] }
  return {
    calls,
    list: async (args) => {
      calls.list += 1
      return typeof list === 'function' ? list(args) : list
    },
    get: async (id) => {
      calls.get.push(id)
      return get(id)
    }
  }
}

const httpError = (status, code = 'request-error') => Object.assign(new Error(`HTTP ${status}`), { status, code })

test('the recent list reflects the server: ready, empty, off, locked and failing', async () => {
  const cases = [
    [{ enabled: true, total: 2, conversations: [conversation('a'), conversation('b')] }, 'ready', 2],
    [{ enabled: true, total: 0, conversations: [] }, 'empty', 0],
    [{ enabled: false, total: 0, conversations: [] }, 'off', 0]
  ]
  for (const [answer, status, count] of cases) {
    const recent = createRecentConversations({ api: fakeApi({ list: answer }), chat: fakeChat() })
    assert.equal(recent.getState().status, 'loading', 'nothing is claimed before the server has answered')
    await recent.refresh()
    assert.equal(recent.getState().status, status)
    assert.equal(recent.getState().items.length, count)
  }
  const locked = createRecentConversations({ api: fakeApi({ list: () => Promise.reject(httpError(401)) }), chat: fakeChat() })
  await locked.refresh()
  assert.equal(locked.getState().status, 'locked')
  const failing = createRecentConversations({ api: fakeApi({ list: () => Promise.reject(httpError(0, 'network')) }), chat: fakeChat() })
  await failing.refresh()
  assert.equal(failing.getState().status, 'error')
})

test('a failed refresh keeps the list that was already showing', async () => {
  let fail = false
  const api = fakeApi({ list: () => (fail ? Promise.reject(httpError(503)) : { enabled: true, total: 1, conversations: [conversation('a')] }) })
  const recent = createRecentConversations({ api, chat: fakeChat() })
  await recent.refresh()
  fail = true
  await recent.refresh()
  assert.equal(recent.getState().status, 'error')
  assert.deepEqual(recent.getState().items.map((c) => c.id), ['a'])
})

test('opening a conversation fetches it and hands it to the chat, the same way ?conversation= does', async () => {
  const chat = fakeChat()
  const api = fakeApi({ list: { enabled: true, total: 1, conversations: [conversation('a')] }, get: async (id) => ({ id, title: 'T', messages: [{ role: 'user', content: 'hi' }] }) })
  const recent = createRecentConversations({ api, chat })
  const result = await recent.open('a')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(api.calls.get, ['a'])
  assert.equal(chat.opened.length, 1)
  assert.equal(chat.opened[0].id, 'a')
})

test('a conversation that is gone says so and the list is refreshed; other failures leave the chat alone', async () => {
  const chat = fakeChat()
  const api = fakeApi({ list: { enabled: true, total: 0, conversations: [] }, get: () => Promise.reject(httpError(404, 'not-found')) })
  const recent = createRecentConversations({ api, chat })
  assert.deepEqual(await recent.open('gone'), { ok: false, reason: 'not-found' })
  assert.equal(api.calls.list, 1, 'refreshed, so the stale entry disappears')

  const broken = createRecentConversations({ api: fakeApi({ list: { enabled: true, total: 0, conversations: [] }, get: () => Promise.reject(httpError(500)) }), chat })
  assert.deepEqual(await broken.open('x'), { ok: false, reason: 'error' })
  const locked = createRecentConversations({ api: fakeApi({ list: { enabled: true, total: 0, conversations: [] }, get: () => Promise.reject(httpError(401)) }), chat })
  assert.deepEqual(await locked.open('x'), { ok: false, reason: 'locked' })
  assert.equal(chat.opened.length, 0, 'nothing replaced the conversation on screen')
})

test('a finished turn refreshes the list (the server saved it); a turn still running or an empty chat does not', async () => {
  const chat = fakeChat()
  const api = fakeApi({ list: { enabled: true, total: 0, conversations: [] } })
  createRecentConversations({ api, chat })
  chat.emit({ busy: true, messages: [{}, {}] })
  chat.emit({ busy: true, messages: [{}, {}] })
  assert.equal(api.calls.list, 0, 'streaming a reply does not refetch the list on every token')
  chat.emit({ busy: false, messages: [{}, {}] })
  assert.equal(api.calls.list, 1)
  chat.emit({ busy: false, messages: [] })
  assert.equal(api.calls.list, 1, 'a new, empty chat is not saved yet')
})

test('the highlighted conversation follows the active session and is announced only when it changes', async () => {
  const chat = fakeChat()
  let active = 'a'
  const recent = createRecentConversations({ api: fakeApi({ list: { enabled: true, total: 2, conversations: [conversation('a'), conversation('b')] } }), chat, getActiveId: () => active })
  await recent.refresh()
  const seen = []
  recent.subscribe((state) => seen.push(state.activeId))
  chat.emit({ messages: [{}] })
  assert.deepEqual(seen, [], 'same conversation: no redraw')
  active = 'b'
  chat.emit({ messages: [{}] })
  assert.deepEqual(seen, ['b'])
  active = 'brand-new-session'
  chat.emit({ messages: [] })
  assert.deepEqual(seen, ['b', 'brand-new-session'], 'a new chat highlights nothing in the list')
})

test('the model label is shown only when the server is configured and names a model', async () => {
  const answer = (body, ok = true) => async () => ({ ok, json: async () => body })
  assert.equal(await loadModelLabel({ fetchFn: answer({ aiConfigured: true, aiModel: ' deepseek-chat ' }) }), 'deepseek-chat')
  assert.equal(await loadModelLabel({ fetchFn: answer({ aiConfigured: false, aiModel: 'deepseek-chat' }) }), null, 'not configured: nothing is claimed')
  assert.equal(await loadModelLabel({ fetchFn: answer({ aiConfigured: true, aiModel: null }) }), null)
  assert.equal(await loadModelLabel({ fetchFn: answer({ aiConfigured: true, aiModel: 'x' }, false) }), null)
  assert.equal(await loadModelLabel({ fetchFn: async () => Promise.reject(new Error('offline')) }), null)
  assert.equal(await loadModelLabel({ fetchFn: async () => ({ ok: true, json: async () => Promise.reject(new Error('not json')) }) }), null)
})

test('the online dot follows the browser going offline and back', () => {
  const dot = { dataset: {}, attributes: {}, setAttribute(k, v) { this.attributes[k] = v } }
  const handlers = {}
  const win = { navigator: { onLine: true }, addEventListener: (type, fn) => (handlers[type] = fn) }
  watchOnline({ dot, win })
  assert.equal(dot.dataset.online, 'true')
  assert.equal(dot.attributes['aria-label'], 'Online')
  win.navigator.onLine = false
  handlers.offline()
  assert.equal(dot.dataset.online, 'false')
  assert.equal(dot.attributes['aria-label'], 'Offline')
  win.navigator.onLine = true
  handlers.online()
  assert.equal(dot.dataset.online, 'true')
})

test('the greeting follows the hour, uses a name only when given one, and is generic otherwise', () => {
  const at = (hour) => new Date(2026, 9, 18, hour, 30)
  const cases = [[4, 'Hello.'], [5, 'Good morning.'], [11, 'Good morning.'], [12, 'Good afternoon.'], [16, 'Good afternoon.'], [17, 'Good evening.'], [21, 'Good evening.'], [22, 'Hello.'], [0, 'Hello.']]
  for (const [hour, expected] of cases) assert.equal(greetingFor(at(hour)), expected, `${hour}:30`)
  assert.equal(greetingFor(at(19), 'Amina'), 'Good evening, Amina.')
  for (const blank of ['', '   ', null, undefined]) assert.equal(greetingFor(at(19), blank), 'Good evening.', JSON.stringify(blank))
})

test('the meeting timer formats minutes and seconds, then hours, and never shows nonsense', () => {
  assert.equal(formatElapsed(0), '00:00')
  assert.equal(formatElapsed(65_000), '01:05')
  assert.equal(formatElapsed(59_999), '00:59')
  assert.equal(formatElapsed(3_725_000), '1:02:05')
  for (const bad of [-5000, NaN, undefined, null, Infinity]) assert.equal(formatElapsed(bad), '00:00', String(bad))
})

test('data saver and 2G are low bandwidth; 3G, 4G and an unknown connection are not', () => {
  assert.equal(isLowBandwidth({ saveData: true }), true)
  assert.equal(isLowBandwidth({ effectiveType: '2g' }), true)
  assert.equal(isLowBandwidth({ effectiveType: 'slow-2g' }), true)
  assert.equal(isLowBandwidth({ saveData: true, effectiveType: '4g' }), true)
  for (const connection of [{ effectiveType: '3g' }, { effectiveType: '4g' }, { saveData: false }, {}, undefined, null]) {
    assert.equal(isLowBandwidth(connection), false, JSON.stringify(connection))
  }
})

test('the web fonts are switched on once, with a normal connection, and left off on data saver and 2G', () => {
  const page = () => ({ documentElement: { dataset: {} } })
  const normal = page()
  assert.equal(enableWebFonts({ doc: normal, connection: { effectiveType: '4g' } }), true)
  assert.equal(normal.documentElement.dataset.fonts, 'on')
  assert.equal(enableWebFonts({ doc: normal, connection: { effectiveType: '4g' } }), true, 'calling it again changes nothing')
  assert.equal(normal.documentElement.dataset.fonts, 'on')

  for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
    const saving = page()
    assert.equal(enableWebFonts({ doc: saving, connection }), false, JSON.stringify(connection))
    assert.equal(saving.documentElement.dataset.fonts, undefined, 'the system fonts stay')
  }
  assert.equal(enableWebFonts({ doc: null, connection: undefined }), false, 'no document: nothing to switch')
})
