/**
 * The Meeting panel: a thin view over meetingController. All the flow lives in the controller (and is
 * tested there); this file only turns its state into DOM and DOM events into controller calls.
 * Transcript text is only ever set with textContent, never as HTML.
 */

// Earlier versions kept the launch code in sessionStorage. The server's launch session replaces that, and the
// code is no longer kept anywhere in the page: this only clears what an older version left behind.
const OLD_CODE_KEY = 'numz.meeting.launch-code'
const MAX_RENDERED_LINES = 500
const NOT_CONFIGURED =
  'Meetings cannot be started from here yet: the server has no launch code set (MEETING_LAUNCH_CODE), or it cannot be reached.'

import { findingLabel, isSettledFinal, provenanceText, selectFindings, summaryCaution, timestamp } from '../commands/meetingIntelligenceReply.js'

const SOURCE_STATES = {
  active: 'sound heard',
  quiet: 'quiet',
  'no-signal': 'no sound yet',
  ended: 'ended',
  unavailable: 'NOT recorded'
}

const SOURCE_HINTS = {
  microphone: '',
  tab:
    'Your browser will ask which tab or screen to share. Tick "Share audio": a page cannot capture sound without ' +
    'your choice. Whole-system audio is only offered by some browsers (Chrome or Edge on Windows); elsewhere share a ' +
    "browser tab. This needs a click, so a voice command always uses the microphone.",
  both:
    'Your browser will ask which tab or screen to share; tick "Share audio". The microphone and the shared sound are ' +
    'mixed into one recording. With speakers, use headphones, or the same voices are recorded twice.'
}

const LINE_LABELS = {
  saved: ['✓ saved', 'The server stored this line'],
  waiting: ['… waiting', 'The line is queued and will be saved when the server is reachable'],
  notSaved: ['✕ not saved', 'The server did not store this line']
}

function chipFor(state) {
  switch (state.phase) {
    case 'launching':
      return ['Starting…', 'info']
    case 'connecting':
      return ['Connecting…', 'info']
    case 'live':
      return ['Recording', 'ok']
    case 'stopping':
      return ['Stopping…', 'info']
    case 'ending':
      return ['Saving…', 'info']
    case 'problem':
      return ['Needs attention', 'error']
    case 'unfinished':
      return ['Unfinished', 'warn']
    case 'done':
      if (state.result?.recordings === 0) return ['Ended, nothing recorded', 'info']
      if (state.result?.verified && state.result?.storedSegments === 0) return ['Ended, no speech', 'warn']
      return state.result?.verified ? ['Saved and verified', 'ok'] : ['Ended, not verified', 'warn']
    default:
      return ['Not started', 'info']
  }
}

function lineKind(persisted) {
  if (persisted === 'INSERTED' || persisted === 'ALREADY_EXISTS') return 'saved'
  return persisted === 'FAILED' ? 'waiting' : 'notSaved'
}

function forgetOldRememberedCode() {
  try {
    globalThis.sessionStorage?.removeItem(OLD_CODE_KEY)
  } catch {
    /* nothing to clear */
  }
}

export function createMeetingPanel({ controller, api, doc = document, onActiveChange = () => {} }) {
  const $ = (id) => {
    const element = doc.getElementById(id)
    if (!element) throw new Error(`Meeting panel: missing #${id}`)
    return element
  }
  const panel = $('meetingPanel')
  const button = $('meetingButton')
  const closeButton = $('meetingClose')
  const heading = $('meetingHeading')
  const chip = $('meetingChip')
  const form = $('meetingForm')
  const codeInput = $('meetingCode')
  const codeLabel = form.querySelector('label[for="meetingCode"]')
  const titleInput = $('meetingTitleInput')
  const sourceSelect = $('meetingSource')
  const sourceHint = $('meetingSourceHint')
  const sourcesList = $('meetingSources')
  const startButton = $('meetingStart')
  const live = $('meetingLive')
  const partial = $('meetingPartial')
  const list = $('meetingLines')
  const counts = $('meetingCounts')
  const stopButton = $('meetingStop')
  const message = $('meetingMessage')
  const actions = $('meetingActions')
  const intel = $('meetingIntel')
  const intelStatus = $('meetingIntelStatus')
  const intelSummaryBox = $('meetingIntelSummaryBox')
  const intelSummary = $('meetingIntelSummary')
  const intelCaution = $('meetingIntelCaution')
  const intelRefresh = $('meetingIntelRefresh')
  const intelLists = {
    decisions: $('meetingIntelDecisions'),
    actions: $('meetingIntelActions'),
    questions: $('meetingIntelQuestions'),
    notes: $('meetingIntelNotes')
  }
  panel.tabIndex = -1

  let launchAvailable = null // null until the server has been asked
  let renderedLastKey = null
  let actionsSignature = ''
  let sourcesSignature = ''
  let intelSignature = ''
  let previousPhase = 'idle'
  let lastActive = false

  forgetOldRememberedCode()

  async function refreshLaunchAvailability() {
    // Whether this browser is already unlocked is asked every time the panel opens: the cookie can lapse.
    controller.refreshLaunchSession?.().catch(() => {})
    if (launchAvailable === true) return
    launchAvailable = await api.launchAvailable()
    render(controller.getState())
  }

  function openPanel() {
    panel.hidden = false
    button.setAttribute('aria-expanded', 'true')
    refreshLaunchAvailability()
    const unlocked = controller.getState().launchReady === true
    const target = form.hidden ? panel : unlocked || codeInput.value ? titleInput : codeInput
    target.focus({ preventScroll: true })
  }

  function closePanel() {
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
    button.focus({ preventScroll: true })
  }

  function actionList(state) {
    const items = []
    if (state.canReconnect) items.push({ id: 'reconnect', label: 'Reconnect', primary: true, run: () => controller.reconnect() })
    if (state.phase === 'unfinished') items.push({ id: 'finish', label: 'Finish meeting', primary: true, run: () => controller.finish() })
    else if (state.canEnd && state.canReconnect) items.push({ id: 'end', label: 'End meeting', run: () => controller.finish() })
    else if (state.canEnd) items.push({ id: 'retry', label: 'Try again', primary: true, run: () => controller.finish() })
    if (state.canDiscard) items.push({ id: 'discard', label: 'Forget this meeting', run: () => controller.discard() })
    if (state.phase === 'idle' && state.launchReady) {
      items.push({ id: 'lock', label: 'Lock this browser', run: () => controller.lock() })
    }
    if (state.phase === 'done') items.push({ id: 'new', label: 'New meeting', primary: true, run: () => controller.reset() })
    return items
  }

  function renderActions(state) {
    const items = actionList(state)
    const signature = items.map((item) => item.id).join('|')
    if (signature === actionsSignature) return
    actionsSignature = signature
    actions.replaceChildren(
      ...items.map((item) => {
        const element = doc.createElement('button')
        element.type = 'button'
        element.textContent = item.label
        if (item.primary) element.dataset.primary = 'true'
        element.addEventListener('click', item.run)
        return element
      })
    )
  }

  function renderSources(state) {
    const signature = JSON.stringify(state.sources.map((s) => [s.id, s.state]))
    if (signature === sourcesSignature) return
    sourcesSignature = signature
    sourcesList.replaceChildren(
      ...state.sources.map((entry) => {
        const item = doc.createElement('li')
        item.dataset.state = entry.state
        item.textContent = `${entry.label}: ${SOURCE_STATES[entry.state] ?? entry.state}`
        if (entry.detail) item.title = entry.detail
        return item
      })
    )
  }

  // The same state, the same wording and the same selection rule as NUMZ AI chat (commands/meetingIntelligenceReply.js).
  function intelItem(item, { owner = false, settled = false } = {}) {
    const li = doc.createElement('li')
    li.dataset.status = item.status
    const text = doc.createElement('span')
    text.textContent = item.text
    const meta = doc.createElement('span')
    meta.className = 'meta'
    const bits = []
    if (owner && item.kind === 'actionItem') {
      bits.push(item.owner?.name ? `owner: ${item.owner.name}` : 'owner not stated')
      bits.push(item.due ? `due: ${item.due}` : 'no deadline stated')
    }
    bits.push(findingLabel(item, settled))
    bits.push(`at ${timestamp(item.source?.start)}`)
    meta.textContent = bits.join(' · ')
    li.title = (item.evidence ?? []).map((e) => `"${e.text}"`).join(' ')
    li.append(text, meta)
    return li
  }

  function fillList(list, items, empty, options) {
    if (!items || items.length === 0) {
      const none = doc.createElement('li')
      none.className = 'none'
      none.textContent = empty
      list.replaceChildren(none)
      return
    }
    list.replaceChildren(...items.map((item) => intelItem(item, options)))
  }

  function renderIntelligence(state) {
    const data = state.intelligence
    intel.hidden = !data
    if (!data) {
      intelSignature = ''
      return
    }
    const signature = JSON.stringify([data.revision, state.intelligenceError?.code ?? null, data.final?.status])
    if (signature === intelSignature) return
    intelSignature = signature
    const settled = isSettledFinal(data)
    const f = selectFindings(data)
    let status = provenanceText(data)
    if (state.intelligenceError) status += ` — ${state.intelligenceError.message}`
    intelStatus.textContent = status
    intelStatus.dataset.tone = settled && !state.intelligenceError ? 'ok' : data.analysis?.status === 'current' && !state.intelligenceError ? 'info' : 'warn'

    const summary = data.final?.status === 'ready' ? data.final.summary : null
    intelSummaryBox.hidden = !summary
    intelSummary.textContent = summary?.text ?? ''
    const caution = summaryCaution(summary)
    intelCaution.hidden = !caution
    intelCaution.textContent = caution ?? ''

    fillList(intelLists.decisions, f.decisions, 'None stated yet.', { settled })
    fillList(intelLists.actions, f.actionItems, 'None stated yet.', { owner: true, settled })
    const open = f.openQuestions ?? []
    fillList(intelLists.questions, open.length ? open : f.questionsAsked, open.length ? 'None found.' : 'None asked yet.', { settled })
    fillList(intelLists.notes, [...(f.topics ?? []), ...(f.notes ?? [])], 'Nothing yet.', { settled })

    const failedFinal = data.final?.status === 'failed'
    intelRefresh.textContent = failedFinal ? 'Retry the final summary' : 'Update now'
    intelRefresh.hidden = settled || data.final?.status === 'withheld' || data.final?.status === 'empty'
  }

  function renderSourceHint() {
    const text = SOURCE_HINTS[sourceSelect.value] ?? ''
    sourceHint.textContent = text
    sourceHint.hidden = !text
  }

  function lineElement(line) {
    const kind = lineKind(line.persisted)
    const item = doc.createElement('li')
    item.dataset.state = kind
    const text = doc.createElement('span')
    text.textContent = line.text
    const label = doc.createElement('span')
    label.className = 'line-state'
    label.textContent = LINE_LABELS[kind][0]
    label.title = `${LINE_LABELS[kind][1]} (${line.persisted})`
    item.append(text, label)
    return item
  }

  // Lines only ever append (or the oldest fall off), so add what is new instead of rebuilding the list.
  function renderLines(lines) {
    if (lines.length === 0) {
      list.replaceChildren()
      renderedLastKey = null
      return
    }
    let from = 0
    if (renderedLastKey !== null) {
      const index = lines.findLastIndex((line) => line.key === renderedLastKey)
      if (index === -1) list.replaceChildren()
      else from = index + 1
    }
    if (from >= lines.length) return
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    list.append(...lines.slice(from).map(lineElement))
    while (list.children.length > MAX_RENDERED_LINES) list.firstElementChild.remove()
    renderedLastKey = lines.at(-1).key
    if (nearBottom) list.scrollTop = list.scrollHeight
  }

  function render(state) {
    const [chipText, chipTone] = chipFor(state)
    chip.textContent = chipText
    chip.dataset.tone = chipTone
    heading.textContent = state.title || 'Meeting'

    const busy = ['launching', 'connecting', 'stopping', 'ending'].includes(state.phase)
    const showForm = state.phase === 'idle' || state.phase === 'launching'
    form.hidden = !showForm
    live.hidden = showForm || state.phase === 'unfinished'
    // Unlocked: the server already accepted the code on this browser, so there is nothing to type.
    codeInput.hidden = state.launchReady === true
    if (codeLabel) codeLabel.hidden = state.launchReady === true
    codeInput.disabled = state.phase === 'launching'
    titleInput.disabled = state.phase === 'launching'
    sourceSelect.disabled = state.phase === 'launching'
    startButton.disabled = state.phase === 'launching' || launchAvailable === false

    stopButton.hidden = !(state.phase === 'connecting' || state.phase === 'live')
    stopButton.disabled = state.phase !== 'live' && state.phase !== 'connecting'
    partial.textContent = state.partial
    counts.textContent = state.lines.length || state.droppedSeconds
      ? [
          `${state.counts.saved} saved`,
          state.counts.waiting ? `${state.counts.waiting} waiting` : null,
          state.counts.notSaved ? `${state.counts.notSaved} not saved` : null,
          state.droppedSeconds ? `about ${state.droppedSeconds} s of audio dropped` : null
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
    renderLines(state.lines)
    renderSources(state)
    renderIntelligence(state)

    const notConfigured = state.phase === 'idle' && !state.message && launchAvailable === false
    message.textContent = notConfigured ? NOT_CONFIGURED : state.message
    message.dataset.tone = notConfigured ? 'warn' : state.tone
    renderActions(state)

    button.dataset.recording = state.phase === 'connecting' || state.phase === 'live' ? 'true' : 'false'
    panel.setAttribute('aria-busy', busy ? 'true' : 'false')

    // The form disappears when a meeting starts; keep keyboard focus inside the panel.
    if (previousPhase === 'idle' && state.phase !== 'idle' && !panel.hidden) {
      ;(stopButton.hidden ? panel : stopButton).focus({ preventScroll: true })
    }
    previousPhase = state.phase

    const active = state.open || state.phase === 'launching'
    if (active !== lastActive) {
      lastActive = active
      onActiveChange(active)
    }
  }

  button.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()))
  closeButton.addEventListener('click', closePanel)
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel()
  })
  stopButton.addEventListener('click', () => controller.stop())
  intelRefresh.addEventListener('click', async () => {
    intelRefresh.disabled = true
    try {
      await controller.refreshIntelligence({ final: controller.getIntelligence()?.final?.status === 'failed' })
    } finally {
      intelRefresh.disabled = false
    }
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    await controller.start({ code: codeInput.value, title: titleInput.value, capture: sourceSelect.value })
    if (controller.getState().open) {
      // The server holds the launch session now; the code is not kept in the page.
      codeInput.value = ''
      titleInput.value = ''
    }
  })

  // Leaving the page while recording would cut the meeting off.
  globalThis.addEventListener?.('beforeunload', (event) => {
    const { phase } = controller.getState()
    if (phase === 'connecting' || phase === 'live' || phase === 'stopping') {
      event.preventDefault()
      event.returnValue = ''
    }
  })

  sourceSelect.addEventListener('change', renderSourceHint)
  renderSourceHint()
  controller.subscribe(render)
  render(controller.getState())

  return {
    open: openPanel,
    close: closePanel,
    /** An unfinished meeting from an earlier visit is worth showing straight away. */
    openIfUnfinished() {
      if (controller.getState().phase === 'unfinished') openPanel()
    }
  }
}
