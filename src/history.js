/**
 * The conversation history screen (history.html): a list of saved conversations to reopen or delete.
 * Reopening goes back to Home with ?conversation=<id>; deleting asks twice, and "delete all" asks first.
 */

import { createHistoryApi } from './interfaces/history/historyApi.js'

const PAGE = 50
const ARM_MS = 4000

const api = createHistoryApi()
const $ = (id) => document.getElementById(id)
const list = $('conversationList')
const status = $('historyStatus')
const more = $('loadMore')
const deleteAll = $('deleteAll')
const confirmBox = $('deleteAllConfirm')

let items = []
let total = 0

function when(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function say(text) {
  status.textContent = text
  status.hidden = !text
}

function messages(count) {
  return `${count} ${count === 1 ? 'message' : 'messages'}`
}

function row(conversation) {
  const title = conversation.title || 'Untitled conversation'
  const li = document.createElement('li')
  li.className = 'conv'
  li.dataset.id = conversation.id

  const open = document.createElement('a')
  open.className = 'conv-main'
  open.href = `/?conversation=${encodeURIComponent(conversation.id)}`
  const name = document.createElement('span')
  name.className = 'conv-title'
  name.textContent = title
  const meta = document.createElement('span')
  meta.className = 'conv-meta'
  meta.textContent = `${when(conversation.updatedAt)} · ${messages(conversation.messageCount)}`
  open.append(name, meta)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'conv-delete'
  remove.textContent = 'Delete'
  remove.setAttribute('aria-label', `Delete conversation: ${title}`)
  let timer = null
  remove.addEventListener('click', async () => {
    if (remove.dataset.armed !== 'true') {
      // First click only asks. A second click within a few seconds deletes.
      remove.dataset.armed = 'true'
      remove.textContent = 'Click again to delete'
      timer = setTimeout(() => {
        remove.dataset.armed = 'false'
        remove.textContent = 'Delete'
      }, ARM_MS)
      return
    }
    clearTimeout(timer)
    remove.disabled = true
    try {
      await api.remove(conversation.id)
      items = items.filter((item) => item.id !== conversation.id)
      total = Math.max(0, total - 1)
      render()
      say(`Deleted “${title}”`)
    } catch (err) {
      remove.disabled = false
      remove.dataset.armed = 'false'
      remove.textContent = 'Delete'
      say(err?.code === 'not-found' ? 'That conversation was already gone.' : `Could not delete it: ${err?.message ?? 'try again'}.`)
      if (err?.code === 'not-found') await load()
    }
  })

  li.append(open, remove)
  return li
}

function render() {
  list.replaceChildren(...items.map(row))
  more.hidden = items.length >= total
  deleteAll.hidden = total === 0
  if (total === 0) say('No saved conversations yet. They appear here once you have chatted.')
}

async function load(append = false) {
  const offset = append ? items.length : 0
  try {
    const result = await api.list({ limit: PAGE, offset })
    if (!result.enabled) {
      items = []
      total = 0
      render()
      say('Conversation history is turned off on this server.')
      deleteAll.hidden = true
      return
    }
    items = append ? [...items, ...result.conversations] : result.conversations
    total = result.total
    render()
    if (total > 0) say('')
  } catch (err) {
    say(`Could not load your conversations: ${err?.message ?? 'try again'}.`)
  }
}

more.addEventListener('click', () => load(true))

deleteAll.addEventListener('click', () => {
  $('deleteAllQuestion').textContent = `Delete all ${total} saved ${total === 1 ? 'conversation' : 'conversations'}? This cannot be undone.`
  confirmBox.hidden = false
  deleteAll.hidden = true
  $('deleteAllNo').focus()
})

$('deleteAllNo').addEventListener('click', () => {
  confirmBox.hidden = true
  deleteAll.hidden = total === 0
  deleteAll.focus()
})

$('deleteAllYes').addEventListener('click', async () => {
  try {
    const { deleted } = await api.removeAll()
    confirmBox.hidden = true
    items = []
    total = 0
    render()
    say(`Deleted ${deleted} ${deleted === 1 ? 'conversation' : 'conversations'}.`)
  } catch (err) {
    say(`Could not delete them: ${err?.message ?? 'try again'}.`)
  }
})

load()
