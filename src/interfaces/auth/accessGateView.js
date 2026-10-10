/**
 * The unlock card (#accessGate) and the Lock button. All behaviour is in access.js; this only shows it.
 * While the card is open the page behind it is inert, so keyboard focus cannot get to it.
 */

export function createAccessGateView({ controller, doc = document, appId = 'app' }) {
  const gate = doc.getElementById('accessGate')
  if (!gate) return { destroy() {} }
  const form = doc.getElementById('accessForm')
  const input = doc.getElementById('accessCode')
  const error = doc.getElementById('accessError')
  const submit = doc.getElementById('accessSubmit')
  const hint = doc.getElementById('accessHint')
  const app = doc.getElementById(appId)
  const lock = doc.getElementById('lockButton')
  const original = hint?.textContent ?? ''

  function render(state) {
    const open = state.phase === 'needed' || state.phase === 'unlocking' || state.phase === 'misconfigured'
    gate.hidden = !open
    if (app) app.inert = open
    submit.disabled = state.phase === 'unlocking' || state.phase === 'misconfigured'
    input.disabled = state.phase === 'misconfigured'
    error.textContent = state.error
    error.hidden = !state.error
    if (hint) hint.textContent = state.phase === 'misconfigured' ? 'The assistant is locked until the server is fixed.' : original
    if (lock) lock.hidden = !state.canLock
    if (open && state.phase === 'needed' && !state.error) input.focus({ preventScroll: true })
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const ok = await controller.submit(input.value)
    if (!ok) {
      input.select?.()
      input.focus({ preventScroll: true })
    }
    input.value = ok ? '' : input.value
  })
  lock?.addEventListener('click', () => controller.lock())

  const off = controller.subscribe(render)
  render(controller.getState())
  return { destroy: off }
}
