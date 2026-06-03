/**
 * Registry for future LLM tool / function calling.
 * Wire names + schemas into aiService when integrating DeepSeek.
 */
export const tools = {
  getHealth: () => 'System is healthy',
  getTime: () => new Date().toISOString()
}
