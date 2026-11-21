import { createOpenAiCompatibleProvider } from '../../ai/providers/openAiCompatibleProvider.js'
import { formatChatMessages } from './formatter.js'

export function createDeepSeekProvider({ apiKey, baseUrl, model, streamUsage = true }) {
  const provider = createOpenAiCompatibleProvider({
    name: 'deepseek',
    apiKey,
    baseUrl,
    model,
    streamUsage
  })

  return {
    name: provider.name,

    async generate({ messages, signal, onUsage }) {
      return provider.generate({ messages: formatChatMessages(messages), signal, onUsage })
    },

    async *stream({ messages, signal, onUsage }) {
      yield* provider.stream({ messages: formatChatMessages(messages), signal, onUsage })
    }
  }
}

