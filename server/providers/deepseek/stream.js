/**
 * Thin wrapper in case we later need DeepSeek-specific stream handling.
 * Today, DeepSeek is OpenAI-compatible for chat completions streaming.
 */
export async function* streamChatCompletion(provider, { messages, signal }) {
  yield* provider.stream({ messages, signal })
}

