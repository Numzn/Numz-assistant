import { renderMarkdown } from '../chat/markdownView.js'
import { presentCamera } from './cameraPresenter.js'

/**
 * Draws the Smart Camera page (camera.html) from the session's state, and turns taps into calls on the session.
 * Everything that decides what is shown or allowed is in cameraPresenter.js (tested); this only builds DOM, with
 * createElement and textContent: nothing from a picture, a question or a model's reply is ever parsed as HTML.
 */

const ARM_MS = 4000
const AUTO_KEY = 'numz.camera.auto'

function safeStorage(win = globalThis) {
  try {
    return win.localStorage ?? null
  } catch {
    return null
  }
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** The structured answer as DOM: the answer line, how sure it is, the working, the explanation, what is uncertain. */
export function drawAnswer(container, answer, doc = container.ownerDocument) {
  const parts = []
  const top = el(doc, 'div', 'ans-top')
  if (answer.headline) top.append(el(doc, 'p', 'ans-headline', answer.headline))
  const badge = el(doc, 'span', 'ans-confidence', answer.confidenceLabel)
  badge.dataset.level = answer.confidence
  top.append(badge)
  parts.push(top)

  if (answer.steps.length) {
    const steps = el(doc, 'ol', 'ans-steps')
    for (const step of answer.steps) steps.append(el(doc, 'li', '', step))
    parts.push(el(doc, 'p', 'cam-sublabel', 'Working'), steps)
  }
  if (answer.explanation) {
    const explanation = el(doc, 'div', 'ans-explanation')
    renderMarkdown(explanation, answer.explanation, doc)
    parts.push(explanation)
  }
  if (answer.uncertainty) {
    const note = el(doc, 'p', 'ans-uncertain')
    note.append(el(doc, 'strong', '', 'Not sure: '), doc.createTextNode(answer.uncertainty))
    parts.push(note)
  } else if (answer.unsure) {
    parts.push(el(doc, 'p', 'ans-uncertain', 'Check this one before relying on it.'))
  }
  container.replaceChildren(...parts)
}

export function createCameraView({ doc = document, session, device, clock = () => globalThis.performance.now(), storage = safeStorage() } = {}) {
  const $ = (id) => doc.getElementById(id)
  const els = {
    stage: $('cameraStage'),
    indicator: $('cameraIndicator'),
    indicatorLabel: $('cameraIndicatorLabel'),
    placeholder: $('cameraPlaceholder'),
    status: $('cameraStatus'),
    busy: $('cameraBusy'),
    busyLabel: $('cameraBusyLabel'),
    panels: $('cameraPanels'),
    start: $('startButton'),
    retry: $('retryButton'),
    capture: $('captureButton'),
    pause: $('pauseButton'),
    resume: $('resumeButton'),
    stop: $('stopButton'),
    autoInput: $('autoInput'),
    flip: $('flipButton'),
    torch: $('torchButton'),
    questionPanel: $('questionPanel'),
    questionHeading: $('questionHeading'),
    questionTags: $('questionTags'),
    questionText: $('questionText'),
    questionOptions: $('questionOptions'),
    questionNotes: $('questionNotes'),
    questionActions: $('questionActions'),
    confirm: $('confirmButton'),
    skip: $('skipButton'),
    answerPanel: $('answerPanel'),
    answerBody: $('answerBody'),
    emptyPanel: $('emptyPanel'),
    historyPanel: $('historyPanel'),
    historyList: $('historyList'),
    clear: $('clearButton'),
    limitClear: $('limitClearButton')
  }

  let shown = { answer: undefined, history: undefined, questionKey: null, cameraOn: false }
  const expanded = new Set()
  let torchOn = false

  // The person's choice between "answer automatically" and "let me check first" is remembered on this device.
  try {
    if (storage?.getItem(AUTO_KEY) === 'review') session.setAuto(false)
  } catch {
    /* storage can be blocked: the default applies */
  }

  function fitQuestionBox() {
    els.questionText.style.height = 'auto'
    els.questionText.style.height = `${els.questionText.scrollHeight}px`
  }

  function drawQuestion(question, state) {
    els.questionPanel.hidden = !question
    if (!question) {
      shown.questionKey = null
      return
    }
    els.questionHeading.textContent = question.heading
    els.questionTags.replaceChildren(...question.tags.map((tag) => el(doc, 'li', 'tag', tag)))
    els.questionOptions.replaceChildren(...question.options.map((o) => el(doc, 'li', '', `${o.label ? `${o.label}) ` : ''}${o.text}`)))
    els.questionNotes.replaceChildren(...question.notes.map((note) => el(doc, 'li', '', note)))
    els.questionActions.hidden = !question.editable
    els.questionText.readOnly = !question.editable

    const key = `${state.current?.questionId ?? ''}:${question.editable}`
    if (key !== shown.questionKey) {
      // A new question, or the same one becoming editable or not: put its text in. While the person is typing in
      // it, nothing replaces what they are writing.
      els.questionText.value = question.text
      if (state.current?.questionId !== shown.questionKey?.split(':')[0]) els.panels.scrollTop = 0
      shown.questionKey = key
    } else if (!question.editable && els.questionText.value !== question.text) {
      els.questionText.value = question.text
    }
    fitQuestionBox()
  }

  function drawHistory(history, state) {
    els.historyPanel.hidden = history.length === 0
    els.clear.hidden = true
    if (shown.history === state.history) return
    shown.history = state.history
    const items = history.map((item) => {
      const li = el(doc, 'li', 'hist')
      const toggle = el(doc, 'button', 'hist-toggle')
      toggle.type = 'button'
      toggle.setAttribute('aria-expanded', String(expanded.has(item.questionId)))
      toggle.append(el(doc, 'span', 'hist-number', `${item.number}.`), el(doc, 'span', 'hist-title', item.title))
      if (item.headline) toggle.append(el(doc, 'span', 'hist-headline', item.headline))
      const detail = el(doc, 'div', 'hist-detail')
      detail.hidden = !expanded.has(item.questionId)
      if (item.detail) drawAnswer(detail, item.detail, doc)
      toggle.addEventListener('click', () => {
        const open = detail.hidden
        detail.hidden = !open
        toggle.setAttribute('aria-expanded', String(open))
        if (open) expanded.add(item.questionId)
        else expanded.delete(item.questionId)
      })
      li.append(toggle, detail)
      return li
    })
    els.historyList.replaceChildren(...items)
  }

  async function learnCameraAbilities() {
    try {
      const { canSwitch, canTorch } = await device.capabilities()
      els.flip.hidden = !canSwitch
      els.torch.hidden = !canTorch
    } catch {
      els.flip.hidden = true
      els.torch.hidden = true
    }
  }

  function render(state) {
    const view = presentCamera(state)

    els.indicator.dataset.kind = view.indicator.kind
    els.indicatorLabel.textContent = view.indicator.label
    els.stage.dataset.on = String(!view.showPlaceholder)
    els.placeholder.hidden = !view.showPlaceholder
    els.status.textContent = view.status.text
    els.status.dataset.tone = view.status.tone
    els.busy.hidden = !view.busy
    els.busyLabel.textContent = view.busy?.label ?? ''

    for (const name of ['start', 'retry', 'capture', 'pause', 'resume', 'stop']) els[name].hidden = !view.controls[name]
    els.autoInput.checked = view.controls.auto
    drawQuestion(view.question, state)

    els.answerPanel.hidden = !view.answer
    if (view.answer && shown.answer !== state.answer) {
      drawAnswer(els.answerBody, view.answer, doc)
      els.panels.scrollTop = 0
    }
    shown.answer = state.answer

    drawHistory(view.history, state)
    els.clear.hidden = !view.controls.clear
    els.limitClear.hidden = !view.controls.clearToContinue
    els.emptyPanel.hidden = Boolean(view.question || view.answer || view.history.length)

    if (state.cameraOn !== shown.cameraOn) {
      shown.cameraOn = state.cameraOn
      if (state.cameraOn) learnCameraAbilities()
      else {
        els.flip.hidden = true
        els.torch.hidden = true
        torchOn = false
        els.torch.setAttribute('aria-pressed', 'false')
      }
    }
  }

  // ---- taps -------------------------------------------------------------------------------------------------------

  els.start.addEventListener('click', () => session.start({ now: clock() }))
  els.retry.addEventListener('click', () => session.retry(clock()))
  els.capture.addEventListener('click', () => session.captureNow(clock()))
  els.pause.addEventListener('click', () => session.pause(clock()))
  els.resume.addEventListener('click', () => session.resume(clock()))
  els.stop.addEventListener('click', () => session.stop('Camera off.'))
  els.confirm.addEventListener('click', () => session.confirm({ text: els.questionText.value.trim() }, clock()))
  els.skip.addEventListener('click', () => session.skip())
  els.questionText.addEventListener('input', fitQuestionBox)
  els.autoInput.addEventListener('change', () => {
    session.setAuto(els.autoInput.checked)
    try {
      storage?.setItem(AUTO_KEY, els.autoInput.checked ? 'auto' : 'review')
    } catch {
      /* the choice just is not remembered */
    }
  })
  els.flip.addEventListener('click', async () => {
    try {
      await device.switchCamera()
      torchOn = false
      els.torch.setAttribute('aria-pressed', 'false')
      await learnCameraAbilities()
    } catch {
      els.flip.hidden = true
    }
  })
  els.torch.addEventListener('click', async () => {
    try {
      await device.setTorch(!torchOn)
      torchOn = !torchOn
      els.torch.setAttribute('aria-pressed', String(torchOn))
    } catch {
      els.torch.hidden = true
    }
  })

  // Clearing asks twice, like deleting a conversation: the first tap arms it for a few seconds. Both clear buttons
  // (the one in the history panel, and the one among the controls when the session limit is reached) work this way.
  function twoTapClear(button, armedText) {
    const idle = button.textContent
    let timer = null
    const disarm = () => {
      clearTimeout(timer)
      button.dataset.armed = 'false'
      button.textContent = idle
    }
    button.addEventListener('click', () => {
      if (button.dataset.armed !== 'true') {
        button.dataset.armed = 'true'
        button.textContent = armedText
        timer = setTimeout(disarm, ARM_MS)
        return
      }
      disarm()
      session.clearHistory()
    })
  }
  twoTapClear(els.clear, 'Click again to clear')
  twoTapClear(els.limitClear, 'Tap again to clear')

  const unsubscribe = session.subscribe(render)
  return { render, dispose: unsubscribe }
}
