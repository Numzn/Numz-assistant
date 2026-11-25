/**
 * The one place the assistant's context service is kept, so that the conversation's transports (server-sent events, the WebSocket) and the other
 * functions (study, screenshots, camera) reach the same one without each being handed it. `use` is called once, at start-up.
 */
let service = null

export const assistantContext = {
  use(next) {
    service = next
  },
  get: () => service
}
