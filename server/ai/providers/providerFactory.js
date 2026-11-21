import { createOpenAiCompatibleProvider } from './openAiCompatibleProvider.js'
import { createPlaceholderProvider } from './placeholderProvider.js'
import { createDeepSeekProvider } from '../../providers/deepseek/client.js'

export function createAiProvider(env = process.env) {
  const provider = (env.AI_PROVIDER ?? 'placeholder').toLowerCase()
  // Token counts for the usage records: asked for in the last streamed chunk. AI_STREAM_USAGE=off if a provider rejects `stream_options`.
  const streamUsage = String(env.AI_STREAM_USAGE ?? 'on').toLowerCase() !== 'off'

  if (provider === 'openai') {
    return createOpenAiCompatibleProvider({
      name: 'openai',
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL ?? 'https://api.openai.com/v1',
      model: env.AI_MODEL ?? 'gpt-4o-mini',
      streamUsage
    })
  }

  if (provider === 'deepseek') {
    return createDeepSeekProvider({
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL ?? 'https://api.deepseek.com',
      model: env.AI_MODEL ?? 'deepseek-v4-flash',
      streamUsage
    })
  }

  if (provider === 'custom') {
    return createOpenAiCompatibleProvider({
      name: 'custom',
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL,
      model: env.AI_MODEL,
      streamUsage
    })
  }

  return createPlaceholderProvider()
}
