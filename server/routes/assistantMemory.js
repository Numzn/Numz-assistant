import express from 'express'
import { MEMORY_KINDS, MemoryError } from '../persistence/memoryRepository.js'
import { requireIdentity } from '../auth/identity.js'
import { kindOf } from '../assistant/memoryCommands.js'

/**
 * What the assistant remembers about the person (under /api/v1/assistant/memory, behind the chat gate). Always the signed-in person's own memories:
 *
 *   GET    /memory            { memories: [{ id, text, kind, source, createdAt, updatedAt, lastUsedAt }], kinds }
 *   POST   /memory            { text, kind? }   -> 201 { memory, created }  (the person typing it in the panel: source "added")
 *   PATCH  /memory/:id        { text?, kind? }  -> the memory
 *   DELETE /memory/:id        -> 204
 *   DELETE /memory?confirm=all  -> { forgotten: n }  (everything the assistant remembers about them; never without the confirm)
 */
const wrap = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next)

export function createMemoryRouter({ memories, audit = () => {} }) {
  const router = express.Router()
  const mine = (req) => {
    const identity = requireIdentity(req)
    return { store: memories.forOwner(identity.legacy ? null : identity.ownerKey), identity }
  }

  router.get('/', wrap((req, res) => res.json({ memories: mine(req).store.list(), kinds: MEMORY_KINDS })))

  router.post('/', wrap((req, res) => {
    const { store, identity } = mine(req)
    const result = store.add({ text: req.body?.text, kind: req.body?.kind ?? kindOf(req.body?.text ?? ''), source: 'added' })
    audit('assistant.memory_add', { userId: identity.userId ?? null, detail: { id: result.memory.id } })
    res.status(201).json(result)
  }))

  router.patch('/:id', wrap((req, res) => {
    const { store } = mine(req)
    const changed = store.change(req.params.id, { text: req.body?.text, kind: req.body?.kind })
    if (!changed) throw new MemoryError(404, 'memory-not-found', 'That memory does not exist.')
    res.json(changed)
  }))

  router.delete('/', wrap((req, res) => {
    const { store, identity } = mine(req)
    if (req.query.confirm !== 'all') throw new MemoryError(400, 'confirm-required', 'To forget everything, say so: ?confirm=all.')
    const forgotten = store.removeAll()
    audit('assistant.memory_clear', { userId: identity.userId ?? null, detail: { forgotten } })
    res.json({ forgotten })
  }))

  router.delete('/:id', wrap((req, res) => {
    const { store, identity } = mine(req)
    if (!store.remove(req.params.id)) throw new MemoryError(404, 'memory-not-found', 'That memory does not exist.')
    audit('assistant.memory_forget', { userId: identity.userId ?? null, detail: { id: req.params.id } })
    res.status(204).end()
  }))

  return router
}
