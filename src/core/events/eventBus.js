export function createEventBus() {
  const listeners = new Map()

  function getListeners(type) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    return listeners.get(type)
  }

  return {
    emit(type, payload = {}) {
      const event = Object.freeze({
        type,
        payload,
        timestamp: Date.now()
      })

      for (const listener of getListeners(type)) {
        listener(event)
      }

      for (const listener of getListeners('*')) {
        listener(event)
      }

      return event
    },

    on(type, listener) {
      if (typeof listener !== 'function') {
        throw new Error('Event listener must be a function')
      }

      const bucket = getListeners(type)
      bucket.add(listener)
      return () => bucket.delete(listener)
    }
  }
}
