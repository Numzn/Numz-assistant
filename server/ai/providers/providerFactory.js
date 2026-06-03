import { createOpenAiCompatibleProvider } from './openAiCompatibleProvider.js'
import { createPlaceholderProvider } from './placeholderProvider.js'
import { createDeepSeekProvider } from '../../providers/deepseek/client.js'

export function createAiProvider(env = process.env) {
  const provider = (env.AI_PROVIDER ?? 'placeholder').toLowerCase()

  if (provider === 'openai') {
    return createOpenAiCompatibleProvider({
      name: 'openai',
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL ?? 'https://api.openai.com/v1',
      model: env.AI_MODEL ?? 'gpt-4o-mini'
    })
  }

  if (provider === 'deepseek') {
    return createDeepSeekProvider({
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL ?? 'https://api.deepseek.com',
      model: env.AI_MODEL ?? 'deepseek-v4-flash'
    })
  }

  if (provider === 'custom') {
    return createOpenAiCompatibleProvider({
      name: 'custom',
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL,
      model: env.AI_MODEL
    })
  }

  return createPlaceholderProvider()
}
