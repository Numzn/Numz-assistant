import { DEFAULT_SYSTEM_PROMPT } from './prompts.js'

function normalizeRole(role) {
  const r = String(role ?? '').toLowerCase()
  if (r === 'system' || r === 'user' || r === 'assistant') return r
  return 'user'
}

function normalizeContent(content) {
  if (typeof content === 'string') return content
  if (content == null) return ''
  return String(content)
}

/**
 * Ensures messages follow the OpenAI-compatible chat format and includes a
 * system prompt if one isn't present.
 * @param {{ role: string, content: string }[]} messages
 * @param {{ systemPrompt?: string }} [opts]
 */
export function formatChatMessages(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : []
  const normalized = list
    .map((m) => ({
      role: normalizeRole(m?.role),
      content: normalizeContent(m?.content)
    }))
    .filter((m) => m.content.trim().length > 0 || m.role === 'system')

  const hasSystem = normalized.some((m) => m.role === 'system')
  if (hasSystem) return normalized

  const systemPrompt =
    typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim()
      ? opts.systemPrompt.trim()
      : DEFAULT_SYSTEM_PROMPT

  return [{ role: 'system', content: systemPrompt }, ...normalized]
}

