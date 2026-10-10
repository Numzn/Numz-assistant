/**
 * Saved assistant conversations (see migration 4). A conversation is an assistant session that has had a
 * message; its id is the session id. All statements are synchronous (node:sqlite), single statements where
 * possible, so a failure part-way never leaves a half-written message.
 */

const MAX_TITLE = 80
const ATTACHMENT_MARKER = '[Attached file: '

/** A short title from the first user message, without the contents of any attached file. */
export function deriveTitle(content) {
  const text = String(content ?? '')
  const marker = text.indexOf(ATTACHMENT_MARKER)
  let title = (marker === -1 ? text : text.slice(0, marker)).replace(/\s+/g, ' ').trim()
  if (!title && marker !== -1) {
    const named = text.match(/\[Attached file: ([^\]\n]+)\]/)
    title = named ? named[1].trim() : ''
  }
  if (!title) return null
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title
}

function clamp(value, min, max, fallback) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

export function createConversationRepository(database) {
  const ensure = database.prepare(
    `INSERT INTO assistant_conversations (conversation_id, title, created_at, updated_at)
     VALUES (?, NULL, ?, ?) ON CONFLICT(conversation_id) DO NOTHING`
  )
  const insertMessage = database.prepare(
    `INSERT INTO assistant_messages (conversation_id, seq, role, content, created_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM assistant_messages WHERE conversation_id = ?), ?, ?, ?)`
  )
  const touch = database.prepare(
    `UPDATE assistant_conversations SET updated_at = ?, title = COALESCE(title, ?) WHERE conversation_id = ?`
  )
  const selectConversation = database.prepare(
    `SELECT conversation_id, title, created_at, updated_at FROM assistant_conversations WHERE conversation_id = ?`
  )
  const selectMessages = database.prepare(
    `SELECT role, content, created_at FROM assistant_messages WHERE conversation_id = ? ORDER BY seq`
  )
  const selectList = database.prepare(
    `SELECT c.conversation_id, c.title, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM assistant_messages m WHERE m.conversation_id = c.conversation_id) AS message_count
       FROM assistant_conversations c
      ORDER BY c.updated_at DESC, c.conversation_id
      LIMIT ? OFFSET ?`
  )
  const countAll = database.prepare(`SELECT COUNT(*) AS n FROM assistant_conversations`)
  const deleteMessages = database.prepare(`DELETE FROM assistant_messages WHERE conversation_id = ?`)
  const deleteConversation = database.prepare(`DELETE FROM assistant_conversations WHERE conversation_id = ?`)

  return {
    /** Saves one message, creating the conversation on its first one. Only user and assistant messages are kept. */
    append(conversationId, { role, content, createdAt }, { conversationCreatedAt } = {}) {
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return false
      const at = createdAt ?? new Date().toISOString()
      // SQLite text stops at a NUL character, which would silently drop the rest of the message. It is kept
      // visible as U+FFFD instead, so everything around it survives.
      const text = content.replace(/\u0000/g, '\uFFFD')
      ensure.run(conversationId, conversationCreatedAt ?? at, at)
      insertMessage.run(conversationId, conversationId, role, text, at)
      touch.run(at, role === 'user' ? deriveTitle(text) : null, conversationId)
      return true
    },

    get(conversationId) {
      const row = selectConversation.get(conversationId)
      if (!row) return null
      return {
        id: row.conversation_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messages: selectMessages.all(conversationId).map((m) => ({ role: m.role, content: m.content, createdAt: m.created_at }))
      }
    },

    list({ limit = 50, offset = 0 } = {}) {
      const rows = selectList.all(clamp(limit, 1, 200, 50), clamp(offset, 0, 1_000_000, 0))
      return {
        total: countAll.get().n,
        conversations: rows.map((row) => ({
          id: row.conversation_id,
          title: row.title,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          messageCount: row.message_count
        }))
      }
    },

    remove(conversationId) {
      deleteMessages.run(conversationId)
      return deleteConversation.run(conversationId).changes > 0
    },

    removeAll() {
      const { n } = countAll.get()
      database.exec('DELETE FROM assistant_messages; DELETE FROM assistant_conversations;')
      return n
    }
  }
}
