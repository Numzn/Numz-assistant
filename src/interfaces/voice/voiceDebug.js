/**
 * Lightweight pipeline timing and phase tracking for voice stabilization.
 */
export function createVoiceDebug({ enabled = false } = {}) {
  let phase = 'idle'
  const marks = new Map()
  const measures = []
  const maxMeasures = 20

  function log(...args) {
    if (!enabled) return
    console.debug('[voice:debug]', ...args)
  }

  return {
    get enabled() {
      return enabled
    },

    getPhase() {
      return phase
    },

    setPhase(next) {
      phase = String(next ?? 'idle')
      log('phase', phase)
    },

    mark(name) {
      if (!enabled) return
      const n = String(name)
      marks.set(n, performance.now?.() ?? Date.now())
      try {
        performance.mark?.(`voice:${n}`)
      } catch {
        /* ignore */
      }
    },

    measure(name, startMark, endMark = null) {
      if (!enabled) return null
      const label = String(name)
      const t0 = marks.get(startMark) ?? performance.now?.() ?? Date.now()
      const t1 = endMark ? marks.get(endMark) ?? performance.now?.() ?? Date.now() : performance.now?.() ?? Date.now()
      const durationMs = Math.max(0, Math.round(t1 - t0))

      try {
        performance.measure?.(`voice:${label}`, `voice:${startMark}`, endMark ? `voice:${endMark}` : undefined)
      } catch {
        /* ignore */
      }

      const entry = { name: label, durationMs, at: Date.now() }
      measures.unshift(entry)
      if (measures.length > maxMeasures) measures.length = maxMeasures
      log('measure', label, `${durationMs}ms`)
      return entry
    },

    getLastMeasures(limit = 5) {
      return measures.slice(0, limit)
    },

    clear() {
      marks.clear()
      measures.length = 0
      phase = 'idle'
    }
  }
}
