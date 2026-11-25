import { randomUUID } from 'node:crypto'

/**
 * What the assistant remembers about a person (migration 12): short facts, preferences, goals, people and notes, one per row. Like the
 * conversations, a person's memories are reached only through `forOwner(userId)`: every statement says whose rows these are, so another
 * person's memory does not exist for them. `forOwner(null)` is the single-tenant fallback (rows with no owner).
 *
 * A memory is something the person said ("remember that ...") or added themselves in the panel: `source` says which. Nothing is written
 * here without the person's act, and every row can be seen, changed and deleted by them.
 */

export const MEMORY_KINDS = Object.freeze(['fact', 'preference', 'goal', 'person', 'note'])
export const MEMORY_SOURCES = Object.freeze(['said', 'added', 'assistant'])
export const MAX_MEMORIES = 200
export const MAX_MEMORY_CHARS = 400

const normal = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export class MemoryError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.name = 'MemoryError'
    this.statusCode = statusCode
    this.code = code
    this.expose = true
  }
}

function out(row) {
  return row ? { id: row.id, text: row.text, kind: row.kind, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at } : null
}

function clean(text) {
  const t = String(text ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim()
  if (!t) throw new MemoryError(400, 'invalid-input', 'There is nothing to remember in that.')
  if (t.length > MAX_MEMORY_CHARS) throw new MemoryError(400, 'memory-too-long', `A memory is one short thing: at most ${MAX_MEMORY_CHARS} characters.`)
  return t
}

export function createMemoryRepository(database, { clock = Date.now } = {}) {
  const iso = () => new Date(clock()).toISOString()

  function view(owner) {
    const owned = owner === null ? 'owner_user_id IS NULL' : 'owner_user_id = ?'
    const bind = owner === null ? [] : [owner]
    const all = database.prepare(`SELECT * FROM assistant_memories WHERE ${owned} ORDER BY updated_at DESC, rowid DESC`)
    const one = database.prepare(`SELECT * FROM assistant_memories WHERE id = ? AND ${owned}`)
    const insert = database.prepare('INSERT INTO assistant_memories (id, owner_user_id, text, kind, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const update = database.prepare(`UPDATE assistant_memories SET text = ?, kind = ?, updated_at = ? WHERE id = ? AND ${owned}`)
    const remove = database.prepare(`DELETE FROM assistant_memories WHERE id = ? AND ${owned}`)
    const removeAll = database.prepare(`DELETE FROM assistant_memories WHERE ${owned}`)
    const used = database.prepare(`UPDATE assistant_memories SET last_used_at = ? WHERE id = ? AND ${owned}`)

    const api = {
      list: () => all.all(...bind).map(out),
      get: (id) => out(one.get(String(id), ...bind)),
      /** Remembers one thing. The same thing said again (ignoring case and punctuation) is not stored twice: it is just brought up to date. */
      add({ text, kind = 'fact', source = 'said' }) {
        const cleaned = clean(text)
        if (!MEMORY_KINDS.includes(kind)) throw new MemoryError(400, 'invalid-input', `kind must be one of: ${MEMORY_KINDS.join(', ')}.`)
        if (!MEMORY_SOURCES.includes(source)) throw new MemoryError(400, 'invalid-input', 'unknown source')
        const existing = api.list().find((m) => normal(m.text) === normal(cleaned))
        if (existing) {
          update.run(cleaned, existing.kind, iso(), existing.id, ...bind)
          return { memory: api.get(existing.id), created: false }
        }
        if (api.list().length >= MAX_MEMORIES) throw new MemoryError(409, 'memory-full', `There are already ${MAX_MEMORIES} memories. Forget some first.`)
        const id = randomUUID()
        const now = iso()
        insert.run(id, owner, cleaned, kind, source, now, now)
        return { memory: api.get(id), created: true }
      },
      change(id, { text, kind }) {
        const found = api.get(id)
        if (!found) return null
        const nextKind = kind ?? found.kind
        if (!MEMORY_KINDS.includes(nextKind)) throw new MemoryError(400, 'invalid-input', `kind must be one of: ${MEMORY_KINDS.join(', ')}.`)
        update.run(text === undefined ? found.text : clean(text), nextKind, iso(), found.id, ...bind)
        return api.get(found.id)
      },
      remove: (id) => remove.run(String(id), ...bind).changes > 0,
      /** Forgets what a person asked to be forgotten, by what they said: memories that contain all its words. -> the memories removed */
      forget(words) {
        const wanted = normal(words).split(' ').filter((w) => w.length > 1)
        if (!wanted.length) return []
        const gone = api.list().filter((m) => wanted.every((w) => normal(m.text).split(' ').includes(w) || normal(m.text).includes(w)))
        for (const m of gone) remove.run(m.id, ...bind)
        return gone
      },
      removeAll: () => removeAll.run(...bind).changes,
      touch(ids) {
        const now = iso()
        for (const id of ids) used.run(now, id, ...bind)
      }
    }
    return api
  }

  return { forOwner: (userId) => view(userId ?? null) }
}
