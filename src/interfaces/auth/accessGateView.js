/**
 * The sign-in card (#accessGate) and the sign-out button. All behaviour is in access.js; this only shows it. The card is one of two:
 * "Continue with Google" (each person signs in with their own account) or the access-code box (the shared-code fallback).
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
  const lockLabel = lock?.textContent ?? ''
  const google = doc.getElementById('accessGoogle')
  const googleButton = doc.getElementById('accessGoogleButton')
  const googleNotice = doc.getElementById('accessGoogleNotice')

  function signInAddress(state) {
    if (!state.loginUrl) return '#'
    const here = `${doc.defaultView?.location?.pathname ?? '/'}${doc.defaultView?.location?.search ?? ''}`
    return `${state.loginUrl}?next=${encodeURIComponent(here)}`
  }

  function render(state) {
    const open = state.phase === 'needed' || state.phase === 'unlocking' || state.phase === 'misconfigured'
    const broker = state.mode === 'broker'
    gate.hidden = !open
    if (app) app.inert = open
    form.hidden = broker
    if (google) google.hidden = !broker
    gate.setAttribute('aria-labelledby', broker && google ? 'accessGoogleTitle' : 'accessTitle')
    if (broker && google) {
      if (googleNotice) {
        googleNotice.textContent = state.notice
        googleNotice.hidden = !state.notice
      }
      if (googleButton) googleButton.href = signInAddress(state)
      if (open && googleButton) googleButton.focus?.({ preventScroll: true })
    }
    submit.disabled = state.phase === 'unlocking' || state.phase === 'misconfigured'
    input.disabled = state.phase === 'misconfigured'
    error.textContent = state.error
    error.hidden = !state.error
    if (hint) hint.textContent = state.phase === 'misconfigured' ? 'The assistant is locked until the server is fixed.' : original
    if (lock) {
      lock.hidden = !state.canLock
      lock.textContent = broker ? 'Sign out' : lockLabel
      lock.title = broker && state.user ? `Signed in as ${state.user.name || state.user.email}` : ''
    }
    if (open && state.phase === 'needed' && !state.error && !broker) input.focus({ preventScroll: true })
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
