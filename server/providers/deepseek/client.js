import { createOpenAiCompatibleProvider } from '../../ai/providers/openAiCompatibleProvider.js'
import { formatChatMessages } from './formatter.js'

export function createDeepSeekProvider({ apiKey, baseUrl, model }) {
  const provider = createOpenAiCompatibleProvider({
    name: 'deepseek',
    apiKey,
    baseUrl,
    model
  })

  return {
    name: provider.name,

    async generate({ messages, signal }) {
      return provider.generate({ messages: formatChatMessages(messages), signal })
    },

    async *stream({ messages, signal }) {
      yield* provider.stream({ messages: formatChatMessages(messages), signal })
    }
  }
}

