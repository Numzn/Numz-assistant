import { createAiProvider } from '../ai/providers/providerFactory.js'

const provider = createAiProvider()

/**
 * @param {{ role: string, content: string }[]} messages
 * @returns {Promise<string>}
 */
export async function generateResponse(messages) {
  return provider.generate({ messages })
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @returns {AsyncGenerator<{ type: 'token', token: string } | { type: 'message', content: string }>}
 */
export async function* streamResponse(messages) {
  yield* provider.stream({ messages })
}
