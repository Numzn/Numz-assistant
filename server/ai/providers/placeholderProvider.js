export function createPlaceholderProvider() {
  return {
    name: 'placeholder',

    async generate({ messages }) {
      const latest = [...messages].reverse().find((msg) => msg.role === 'user')
      const suffix = latest?.content ? ` You said: "${latest.content}".` : ''
      return `This is a placeholder AI response.${suffix}`
    },

    async *stream({ messages }) {
      const reply = await this.generate({ messages })
      const tokens = reply.split(/(\s+)/).filter(Boolean)

      for (const token of tokens) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        yield { type: 'token', token }
      }

      yield { type: 'message', content: reply }
    }
  }
}
