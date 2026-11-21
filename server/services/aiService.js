import { createAiProvider } from '../ai/providers/providerFactory.js'

let provider

function getProvider() {
  if (!provider) provider = createAiProvider()
  return provider
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {{ signal?: AbortSignal, onUsage?: (usage: { promptTokens?: number, completionTokens?: number, model?: string, provider?: string }) => void }} [options]
 *   `signal` stops the request (a closed connection, a time limit); `onUsage` receives the provider's token counts.
 * @returns {Promise<string>}
 */
export async function generateResponse(messages, { signal, onUsage } = {}) {
  return getProvider().generate({ messages, signal, onUsage })
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {{ signal?: AbortSignal, onUsage?: Function }} [options]
 * @returns {AsyncGenerator<{ type: 'token', token: string } | { type: 'message', content: string }>}
 */
export async function* streamResponse(messages, { signal, onUsage } = {}) {
  yield* getProvider().stream({ messages, signal, onUsage })
}
