/**
 * Saved assistant conversations (see migrations 4 and 6). A conversation is an assistant session that has had a
 * message; its id is the session id. All statements are synchronous (node:sqlite), single statements where
 * possible, so a failure part-way never leaves a half-written message.
 *
 * Whose conversations? Two views of the same tables, and nothing else is exported to the routes:
 *
 *   forOwner(userId)   one person's conversations. EVERY statement says `owner_user_id = ?` (messages reach their
 *                      conversation through a join on that owner in the same statement), so a conversation that is not
 *                      theirs, or has no owner at all (quarantined), simply does not exist for them: get() is null,
 *                      list() omits it, remove() removes nothing, append() refuses.
 *   the repository     the single-tenant fallback (ASSISTANT_AUTH_MODE=code): conversations with NO owner. It can neither
 *      itself          see nor change a conversation that belongs to a person.
 *
 * Quarantined conversations (no owner) are released only by the host-side administrator (scripts/ai-admin.js), through
 * `legacy`, which is not reachable from any route.
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

// SQLite text stops at a NUL character, which would silently drop the rest of the message. It is kept
// visible as U+FFFD instead, so everything around it survives.
const clean = (content) => content.replace(/\u0000/g, '�')

/** `owned` is the SQL fragment that says whose rows these are: `owner_user_id IS NULL` (fallback) or `owner_user_id = ?`. */
function createView(database, { owned, bind, origin = null }) {
  const ensure = database.prepare(
    `INSERT INTO assistant_conversations (conversation_id, title, created_at, updated_at, owner_user_id, origin)
     VALUES (?, NULL, ?, ?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING`
  )
  const isMine = database.prepare(`SELECT 1 AS yes FROM assistant_conversations WHERE conversation_id = ? AND ${owned}`)
  const insertMessage = database.prepare(
    `INSERT INTO assistant_messages (conversation_id, seq, role, content, created_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM assistant_messages WHERE conversation_id = ?), ?, ?, ?)`
  )
  const touch = database.prepare(
    `UPDATE assistant_conversations SET updated_at = ?, title = COALESCE(title, ?) WHERE conversation_id = ? AND ${owned}`
  )
  const selectConversation = database.prepare(
    `SELECT conversation_id, title, created_at, updated_at FROM assistant_conversations WHERE conversation_id = ? AND ${owned}`
  )
  const selectMessages = database.prepare(
    `SELECT m.role, m.content, m.created_at FROM assistant_messages m
       JOIN assistant_conversations c ON c.conversation_id = m.conversation_id
      WHERE m.conversation_id = ? AND ${owned.replaceAll('owner_user_id', 'c.owner_user_id')} ORDER BY m.seq`
  )
  const selectList = database.prepare(
    `SELECT c.conversation_id, c.title, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM assistant_messages m WHERE m.conversation_id = c.conversation_id) AS message_count
       FROM assistant_conversations c
      WHERE ${owned.replaceAll('owner_user_id', 'c.owner_user_id')}
      ORDER BY c.updated_at DESC, c.conversation_id
      LIMIT ? OFFSET ?`
  )
  const countAll = database.prepare(`SELECT COUNT(*) AS n FROM assistant_conversations WHERE ${owned}`)
  const deleteMessages = database.prepare(
    `DELETE FROM assistant_messages WHERE conversation_id IN (SELECT conversation_id FROM assistant_conversations WHERE conversation_id = ? AND ${owned})`
  )
  const deleteConversation = database.prepare(`DELETE FROM assistant_conversations WHERE conversation_id = ? AND ${owned}`)
  const deleteAllMessages = database.prepare(
    `DELETE FROM assistant_messages WHERE conversation_id IN (SELECT conversation_id FROM assistant_conversations WHERE ${owned})`
  )
  const deleteAllConversations = database.prepare(`DELETE FROM assistant_conversations WHERE ${owned}`)
  const b = bind // the owner id, or nothing for the fallback

  return {
    /** Saves one message, creating the conversation on its first one. Only user and assistant messages are kept. False if it is not this owner's. */
    append(conversationId, { role, content, createdAt }, { conversationCreatedAt, origin: from = origin } = {}) {
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return false
      const at = createdAt ?? new Date().toISOString()
      ensure.run(conversationId, conversationCreatedAt ?? at, at, b[0] ?? null, from)
      if (!isMine.get(conversationId, ...b)) return false // the id already belongs to someone else (or to nobody): never write into it
      insertMessage.run(conversationId, conversationId, role, clean(content), at)
      touch.run(at, role === 'user' ? deriveTitle(content) : null, conversationId, ...b)
      return true
    },

    get(conversationId) {
      const row = selectConversation.get(conversationId, ...b)
      if (!row) return null
      return {
        id: row.conversation_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messages: selectMessages.all(conversationId, ...b).map((m) => ({ role: m.role, content: m.content, createdAt: m.created_at }))
      }
    },

    list({ limit = 50, offset = 0 } = {}) {
      const rows = selectList.all(...b, clamp(limit, 1, 200, 50), clamp(offset, 0, 1_000_000, 0))
      return {
        total: countAll.get(...b).n,
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
      deleteMessages.run(conversationId, ...b)
      return deleteConversation.run(conversationId, ...b).changes > 0
    },

    /** Deletes this owner's conversations only. */
    removeAll() {
      const { n } = countAll.get(...b)
      deleteAllMessages.run(...b)
      deleteAllConversations.run(...b)
      return n
    }
  }
}

export function createConversationRepository(database) {
  const fallback = createView(database, { owned: 'owner_user_id IS NULL', bind: [] })
  const views = new Map()
  const anyOwner = database.prepare('SELECT 1 AS yes FROM assistant_conversations WHERE conversation_id = ?')

  // Host-side administration of quarantined (ownerless) conversations. Not reachable from any route.
  const legacy = {
    list: () =>
      database
        .prepare(
          `SELECT conversation_id AS id, title, created_at AS createdAt, updated_at AS updatedAt,
                  (SELECT COUNT(*) FROM assistant_messages m WHERE m.conversation_id = c.conversation_id) AS messageCount
             FROM assistant_conversations c WHERE owner_user_id IS NULL ORDER BY updated_at`
        )
        .all(),
    /** Gives every ownerless conversation (or just `ids`) to one person. Returns how many moved. */
    claim(userId, ids = null) {
      if (typeof userId !== 'string' || !userId) throw new Error('claim needs a user id')
      const only = Array.isArray(ids) ? ids : null
      const rows = database.prepare('SELECT conversation_id AS id FROM assistant_conversations WHERE owner_user_id IS NULL').all()
      const update = database.prepare('UPDATE assistant_conversations SET owner_user_id = ?, origin = COALESCE(origin, ?) WHERE conversation_id = ? AND owner_user_id IS NULL')
      let moved = 0
      for (const { id } of rows) if (!only || only.includes(id)) moved += update.run(userId, 'legacy', id).changes
      return moved
    },
    /** Deletes every ownerless conversation. Returns how many. */
    purge() {
      const n = database.prepare('SELECT COUNT(*) AS n FROM assistant_conversations WHERE owner_user_id IS NULL').get().n
      database.exec(
        'DELETE FROM assistant_messages WHERE conversation_id IN (SELECT conversation_id FROM assistant_conversations WHERE owner_user_id IS NULL); DELETE FROM assistant_conversations WHERE owner_user_id IS NULL;'
      )
      return n
    }
  }

  return {
    ...fallback,
    /** One person's conversations. The same id for the same person returns the same view. */
    forOwner(userId) {
      if (userId === null || userId === undefined || userId === 'legacy') return fallback
      if (typeof userId !== 'string' || !userId) throw new Error('forOwner needs a user id')
      if (!views.has(userId)) views.set(userId, createView(database, { owned: 'owner_user_id = ?', bind: [userId] }))
      return views.get(userId)
    },
    /** True if ANY owner (or nobody) already has a conversation under this id: used to keep ids unique. */
    idTaken: (conversationId) => Boolean(anyOwner.get(conversationId)),
    /** Quarantined conversations: administration only. */
    legacy
  }
}
