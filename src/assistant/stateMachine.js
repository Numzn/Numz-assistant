export const STATES = Object.freeze({
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

export const STATE_GROUPS = Object.freeze({
  READY: 'READY',
  INPUT: 'INPUT',
  RESPONSE: 'RESPONSE',
  INTERRUPTED: 'INTERRUPTED',
  ERROR: 'ERROR'
})

const VALID_STATES = Object.freeze(new Set(Object.values(STATES)))

const STATE_META = Object.freeze({
  [STATES.IDLE]: { group: STATE_GROUPS.READY },
  [STATES.LISTENING]: { group: STATE_GROUPS.INPUT },
  [STATES.TRANSCRIBING]: { group: STATE_GROUPS.INPUT },
  [STATES.PROCESSING]: { group: STATE_GROUPS.RESPONSE },
  [STATES.THINKING]: { group: STATE_GROUPS.RESPONSE },
  [STATES.RETRIEVING_MEMORY]: { group: STATE_GROUPS.RESPONSE },
  [STATES.TOOL_EXECUTION]: { group: STATE_GROUPS.RESPONSE },
  [STATES.GENERATING]: { group: STATE_GROUPS.RESPONSE },
  [STATES.SPEAKING]: { group: STATE_GROUPS.RESPONSE },
  [STATES.INTERRUPTED]: { group: STATE_GROUPS.INTERRUPTED },
  [STATES.ERROR_RECOVERY]: { group: STATE_GROUPS.ERROR },
  [STATES.ERROR]: { group: STATE_GROUPS.ERROR }
})

const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.IDLE]: new Set([STATES.LISTENING, STATES.PROCESSING, STATES.THINKING, STATES.ERROR]),
  [STATES.LISTENING]: new Set([STATES.TRANSCRIBING, STATES.PROCESSING, STATES.THINKING, STATES.IDLE, STATES.INTERRUPTED, STATES.ERROR]),
  [STATES.TRANSCRIBING]: new Set([STATES.THINKING, STATES.PROCESSING, STATES.IDLE, STATES.ERROR]),
  [STATES.PROCESSING]: new Set([STATES.THINKING, STATES.RETRIEVING_MEMORY, STATES.TOOL_EXECUTION, STATES.GENERATING, STATES.SPEAKING, STATES.INTERRUPTED, STATES.ERROR]),
  [STATES.THINKING]: new Set([STATES.RETRIEVING_MEMORY, STATES.TOOL_EXECUTION, STATES.GENERATING, STATES.SPEAKING, STATES.INTERRUPTED, STATES.ERROR]),
  [STATES.RETRIEVING_MEMORY]: new Set([STATES.THINKING, STATES.TOOL_EXECUTION, STATES.GENERATING, STATES.INTERRUPTED, STATES.ERROR]),
  [STATES.TOOL_EXECUTION]: new Set([STATES.THINKING, STATES.GENERATING, STATES.INTERRUPTED, STATES.ERROR]),
  [STATES.GENERATING]: new Set([STATES.SPEAKING, STATES.INTERRUPTED, STATES.ERROR]),
  [STATES.SPEAKING]: new Set([STATES.IDLE, STATES.INTERRUPTED, STATES.ERROR]),
  [STATES.INTERRUPTED]: new Set([STATES.IDLE, STATES.LISTENING, STATES.ERROR_RECOVERY]),
  [STATES.ERROR]: new Set([STATES.ERROR_RECOVERY, STATES.IDLE]),
  [STATES.ERROR_RECOVERY]: new Set([STATES.IDLE])
})

export function createStateMachine(initialState = STATES.IDLE, { eventBus } = {}) {
  let current = initialState
  const subscribers = new Set()

  function assertValid(next) {
    if (!VALID_STATES.has(next)) {
      throw new Error(`Invalid assistant state: ${next}`)
    }
  }

  return {
    getState() {
      return current
    },

    getMeta(state = current) {
      return STATE_META[state] ?? null
    },

    canTransition(next) {
      assertValid(next)
      if (next === current) return true
      return ALLOWED_TRANSITIONS[current]?.has(next) ?? false
    },

    setState(next, details = {}) {
      assertValid(next)
      if (!this.canTransition(next) && !details.force) {
        throw new Error(`Invalid assistant transition: ${current} -> ${next}`)
      }
      if (next === current) return
      const previous = current
      current = next
      const eventPayload = {
        state: current,
        previous,
        group: STATE_META[current]?.group,
        previousGroup: STATE_META[previous]?.group,
        ...details
      }
      subscribers.forEach((fn) => {
        fn(current, previous, eventPayload)
      })
      eventBus?.emit?.('state:change', eventPayload)
    },

    subscribe(callback) {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    }
  }
}
