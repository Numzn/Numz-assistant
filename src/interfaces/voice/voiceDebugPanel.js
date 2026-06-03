/**
 * Lightweight debug overlay for voice pipeline stabilization (?debug=1).
 */
export function createVoiceDebugPanel({
  panelEl,
  stateMachine,
  voiceDebug,
  pollAudioHealthMs = 30000
} = {}) {
  if (!panelEl) return { destroy: () => {} }

  let sidecarOk = null
  let pollTimer = null

  async function pollHealth() {
    try {
      const res = await fetch('/api/v1/assistant/audio-health')
      const data = await res.json().catch(() => ({}))
      sidecarOk = Boolean(data?.ok)
    } catch {
      sidecarOk = false
    }
    render()
  }

  function render() {
    const state = stateMachine?.getState?.() ?? '—'
    const phase = voiceDebug?.getPhase?.() ?? '—'
    const measures = voiceDebug?.getLastMeasures?.(5) ?? []
    const measureLines = measures
      .map((m) => `${m.name}: ${m.durationMs}ms`)
      .join('\n')
    const sidecar =
      sidecarOk === null ? '…' : sidecarOk ? 'ok' : 'offline'

    panelEl.textContent = [
      `state: ${state}`,
      `phase: ${phase}`,
      `sidecar: ${sidecar}`,
      measures.length ? '—' : '',
      measureLines
    ]
      .filter(Boolean)
      .join('\n')
  }

  panelEl.hidden = false
  pollHealth()
  pollTimer = setInterval(pollHealth, pollAudioHealthMs)

  const unsubscribe = stateMachine?.subscribe?.(() => render()) ?? (() => {})

  return {
    render,
    destroy() {
      clearInterval(pollTimer)
      unsubscribe()
      panelEl.hidden = true
    }
  }
}
