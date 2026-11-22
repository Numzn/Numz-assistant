/**
 * The screenshot panel above the composer, and the capture button's menu. It draws the controller's state and turns clicks into controller
 * calls; it holds no logic of its own beyond how a drag on the preview becomes a rectangle in the capture's own pixels.
 *
 * Nothing here captures anything by itself and nothing is shown on the desktop: the picture is taken by the desktop app's native layer when
 * a menu item is pressed, and everything else (the preview, the area, the question) happens inside this panel.
 */

const CHIP = {
  unavailable: ['Desktop app', 'info'],
  capturing: ['Capturing…', 'info'],
  preview: ['Preview', 'info'],
  uploading: ['Sending…', 'info'],
  analyzing: ['Analysing…', 'info'],
  ready: ['Added', 'ok'],
  failed: ['Failed', 'error'],
  cancelled: ['Cancelled', 'warn']
}

export function createScreenshotView({ controller, doc = document } = {}) {
  const $ = (id) => doc.getElementById(id)
  const button = $('shotButton')
  const menu = $('shotMenu')
  const panel = $('shotPanel')
  if (!button || !menu || !panel) return null
  const chip = $('shotChip')
  const message = $('shotMessage')
  const actions = $('shotActions')
  const windows = $('shotWindows')
  const windowList = $('shotWindowList')
  const windowsHint = $('shotWindowsHint')
  const stage = $('shotStage')
  const preview = $('shotPreview')
  const selectionBox = $('shotSelection')
  const questionLabel = $('shotQuestionLabel')
  const question = $('shotQuestion')
  const askForm = $('shotAsk')
  const askInput = $('shotAskInput')
  const askButton = $('shotAskButton')

  let pickingWindow = false
  let signature = ''
  let drag = null

  function openMenu() {
    const support = controller.getState().support
    for (const item of menu.querySelectorAll('[data-shot-mode]')) {
      const mode = item.dataset.shotMode
      item.disabled = Boolean(support) && support.modes?.[mode] === false
      item.title = item.disabled ? 'Not available in this desktop session' : ''
    }
    menu.hidden = false
    button.setAttribute('aria-expanded', 'true')
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  }

  function closeMenu({ restoreFocus = false } = {}) {
    menu.hidden = true
    button.setAttribute('aria-expanded', 'false')
    if (restoreFocus) button.focus({ preventScroll: true })
  }

  function showPanel() {
    panel.hidden = false
  }

  async function hidePanel() {
    pickingWindow = false
    panel.hidden = true
    await controller.dismiss()
    render(controller.getState())
  }

  // ---- the preview and the area chosen on it ---------------------------------------------------------------------

  /** Where the picture really is inside the preview element (it is letterboxed), and its scale to the capture's own pixels. */
  function fit(state) {
    const box = stage.getBoundingClientRect()
    const { width: W, height: H } = state.capture ?? { width: 0, height: 0 }
    if (!W || !H || !box.width || !box.height) return null
    const scale = Math.min(box.width / W, box.height / H)
    return { box, scale, offsetX: (box.width - W * scale) / 2, offsetY: (box.height - H * scale) / 2, W, H }
  }

  function toImage(event, f) {
    return { x: (event.clientX - f.box.left - f.offsetX) / f.scale, y: (event.clientY - f.box.top - f.offsetY) / f.scale }
  }

  function drawSelection(state) {
    const sel = state.selection
    const f = fit(state)
    if (!sel || !f) {
      selectionBox.hidden = true
      return
    }
    selectionBox.hidden = false
    selectionBox.style.left = `${f.offsetX + sel.x * f.scale}px`
    selectionBox.style.top = `${f.offsetY + sel.y * f.scale}px`
    selectionBox.style.width = `${sel.width * f.scale}px`
    selectionBox.style.height = `${sel.height * f.scale}px`
  }

  stage.addEventListener('pointerdown', (event) => {
    const state = controller.getState()
    if (state.phase !== 'preview' || state.mode !== 'region') return
    const f = fit(state)
    if (!f) return
    event.preventDefault()
    stage.setPointerCapture?.(event.pointerId)
    drag = { f, start: toImage(event, f) }
  })
  stage.addEventListener('pointermove', (event) => {
    if (!drag) return
    const here = toImage(event, drag.f)
    controller.setSelection({ x: Math.min(drag.start.x, here.x), y: Math.min(drag.start.y, here.y), width: Math.abs(here.x - drag.start.x), height: Math.abs(here.y - drag.start.y) })
  })
  const endDrag = (event) => {
    if (!drag) return
    stage.releasePointerCapture?.(event.pointerId)
    drag = null
  }
  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', endDrag)

  // ---- drawing ---------------------------------------------------------------------------------------------------

  function actionList(state) {
    const items = []
    const again = { id: 'again', label: 'New screenshot', run: () => openMenu() }
    switch (state.phase) {
      case 'preview':
        items.push({ id: 'analyse', label: 'Analyse', primary: true, run: () => controller.analyse() })
        if (state.mode === 'region' && state.selection) items.push({ id: 'clear', label: 'Use the whole picture', run: () => controller.setSelection(null) })
        items.push({ id: 'discard', label: 'Discard', run: () => controller.remove() })
        break
      case 'uploading':
      case 'analyzing':
      case 'capturing':
        items.push({ id: 'cancel', label: 'Cancel', run: () => controller.cancel() })
        break
      case 'ready':
        items.push(again, { id: 'delete', label: 'Delete screenshot', danger: true, run: () => controller.remove() })
        break
      case 'failed':
        if (state.error?.retryable) items.push({ id: 'retry', label: 'Retry', primary: true, run: () => controller.retry() })
        items.push(again, { id: 'delete', label: state.shot ? 'Delete screenshot' : 'Dismiss', danger: Boolean(state.shot), run: () => controller.remove() })
        break
      case 'cancelled':
        items.push({ id: 'retry', label: 'Retry', primary: true, run: () => controller.retry() }, again, { id: 'delete', label: 'Dismiss', run: () => controller.remove() })
        break
      default:
        break
    }
    return items
  }

  function renderActions(state) {
    const items = actionList(state)
    const sig = items.map((item) => item.id).join('|')
    if (sig === signature) return
    signature = sig
    actions.replaceChildren(
      ...items.map((item) => {
        const element = doc.createElement('button')
        element.type = 'button'
        element.textContent = item.label
        if (item.primary) element.dataset.primary = 'true'
        if (item.danger) element.dataset.danger = 'true'
        element.addEventListener('click', () => item.run())
        return element
      })
    )
  }

  function renderWindows(state) {
    windows.hidden = !pickingWindow
    if (!pickingWindow) return
    windowsHint.textContent = state.windowsError || (state.windows.length ? 'Pick the window to capture:' : 'Looking for windows…')
    windowList.replaceChildren(
      ...state.windows.map((w) => {
        const li = doc.createElement('li')
        const pick = doc.createElement('button')
        pick.type = 'button'
        const title = doc.createElement('span')
        title.textContent = w.title || w.app || 'Untitled window'
        pick.append(title)
        if (w.app && w.title) {
          const app = doc.createElement('span')
          app.className = 'app'
          app.textContent = ` — ${w.app}`
          pick.append(app)
        }
        pick.addEventListener('click', () => {
          pickingWindow = false
          controller.capture({ mode: 'window', windowId: w.id })
        })
        li.append(pick)
        return li
      })
    )
  }

  function render(state) {
    const [chipText, tone] = CHIP[state.phase] ?? ['', 'info']
    chip.textContent = chipText
    chip.dataset.tone = tone
    message.textContent = state.message
    message.dataset.tone = state.tone

    const showPicture = Boolean(state.capture?.preview) && !['idle', 'unavailable', 'capturing'].includes(state.phase)
    stage.hidden = !showPicture
    if (showPicture && preview.getAttribute('src') !== state.capture.preview) preview.setAttribute('src', state.capture.preview)
    stage.dataset.selectable = String(state.phase === 'preview' && state.mode === 'region')
    if (showPicture) drawSelection(state)
    else selectionBox.hidden = true

    const asking = state.phase === 'preview'
    question.hidden = !asking
    questionLabel.hidden = !asking
    if (asking && doc.activeElement !== question && question.value !== state.question) question.value = state.question
    if (!asking) question.value = ''

    renderWindows(state)
    renderActions(state)

    const canAsk = state.phase === 'ready' && state.shot?.pictureKept === true
    askForm.hidden = !canAsk
    askInput.disabled = askButton.disabled = state.asking
  }

  // ---- wiring ----------------------------------------------------------------------------------------------------

  button.addEventListener('click', async () => {
    if (!menu.hidden) return closeMenu()
    const state = controller.getState()
    if (state.phase === 'unavailable') {
      showPanel()
      render(state)
      return
    }
    openMenu()
  })

  menu.addEventListener('click', (event) => {
    const item = event.target.closest?.('[data-shot-mode]')
    if (!item || item.disabled) return
    const mode = item.dataset.shotMode
    closeMenu()
    showPanel()
    if (mode === 'window') {
      pickingWindow = true
      render(controller.getState())
      controller.loadWindows()
      return
    }
    pickingWindow = false
    controller.capture({ mode })
  })

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeMenu({ restoreFocus: true })
    }
  })
  doc.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) closeMenu()
  })

  $('shotClose').addEventListener('click', () => hidePanel())
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hidePanel()
  })
  question.addEventListener('input', () => controller.setQuestion(question.value))
  askForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = askInput.value
    if (!text.trim()) return
    const reply = await controller.ask(text)
    if (reply) askInput.value = ''
  })
  globalThis.addEventListener?.('pagehide', () => controller.destroy())

  controller.subscribe((state) => {
    // A new capture, a result or an error brings the panel up; the person never has to go looking for it.
    if (state.phase !== 'idle' && (state.phase !== 'unavailable' || !panel.hidden)) panel.hidden = false
    if (state.phase === 'idle' && state.message) panel.hidden = false
    render(state)
  })
  render(controller.getState())

  return { open: openMenu, close: hidePanel }
}
