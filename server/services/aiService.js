import { createAiProvider } from '../ai/providers/providerFactory.js'

let provider

function getProvider() {
  if (!provider) provider = createAiProvider()
  return provider
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @returns {Promise<string>}
 */
export async function generateResponse(messages) {
  return getProvider().generate({ messages })
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @returns {AsyncGenerator<{ type: 'token', token: string } | { type: 'message', content: string }>}
 */
export async function* streamResponse(messages) {
  yield* getProvider().stream({ messages })
}
