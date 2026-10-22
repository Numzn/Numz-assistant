/**
 * The assistant's twelve states: the one definition. The server (sessionService.js, the state routes, the
 * orchestrator) and the browser (src/assistant/stateMachine.js) both import it, so the two cannot disagree about
 * which states exist.
 *
 * What the browser adds on top stays in the browser: which interface group a state belongs to and which moves
 * are allowed. Those are about the interface, not about what the server will record.
 *
 * Two rules keep it shareable without touching the deployment:
 *   - It lives under server/ because the production image copies server/ into the runtime stage. The browser
 *     gets it at build time (Vite bundles it from the build stage, which holds the whole repository), so the
 *     running server never needs anything from src/ and the browser never fetches anything from server/.
 *   - It imports nothing, not even node:*, so it is as valid in the browser bundle as under Node.
 *     tests/assistantStates.test.js fails if either rule is broken.
 *
 * Adding a state means adding it here AND giving it a group and its moves in src/assistant/stateMachine.js;
 * the same test fails until it has both.
 */

export const ASSISTANT_STATES = Object.freeze({
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  TRANSCRIBING: 'TRANSCRIBING',
  PROCESSING: 'PROCESSING',
  THINKING: 'THINKING',
  RETRIEVING_MEMORY: 'RETRIEVING_MEMORY',
  TOOL_EXECUTION: 'TOOL_EXECUTION',
  GENERATING: 'GENERATING',
  SPEAKING: 'SPEAKING',
  INTERRUPTED: 'INTERRUPTED',
  ERROR_RECOVERY: 'ERROR_RECOVERY',
  ERROR: 'ERROR'
})

const VALID_STATES = new Set(Object.values(ASSISTANT_STATES))

/** True only for one of the twelve state names, exactly as written. */
export function isValidAssistantState(state) {
  return VALID_STATES.has(state)
}
