import assert from 'node:assert/strict'
import test from 'node:test'
import { createDock, resolveDock } from '../src/interfaces/layout/dock.js'

test('nothing shown means no dock', () => {
  assert.deepEqual(resolveDock({ visible: [], previous: null }), { open: null, close: [] })
  assert.deepEqual(resolveDock(), { open: null, close: [] })
})

test('one panel shown stays', () => {
  assert.deepEqual(resolveDock({ visible: ['study'], previous: null }), { open: 'study', close: [] })
  assert.deepEqual(resolveDock({ visible: ['meeting'], previous: 'meeting' }), { open: 'meeting', close: [] })
})

test('opening a second panel closes the one that was already open, whichever order they are listed in', () => {
  assert.deepEqual(resolveDock({ visible: ['study', 'meeting'], previous: 'study' }), { open: 'meeting', close: ['study'] })
  assert.deepEqual(resolveDock({ visible: ['study', 'meeting'], previous: 'meeting' }), { open: 'study', close: ['meeting'] })
})

test('two panels shown with no earlier one (both opened at load) keep the last listed', () => {
  assert.deepEqual(resolveDock({ visible: ['study', 'meeting'], previous: null }), { open: 'meeting', close: ['study'] })
})

// ---- the DOM glue, against a hand-made document (the real browser check is scripts/ui-layout-e2e) ----

function fakeDoc({ withDock = true } = {}) {
  const make = (id) => {
    const attrs = {}
    return { id, hidden: true, attrs, setAttribute: (k, v) => (attrs[k] = v) }
  }
  const els = Object.fromEntries(['dock', 'studyPanel', 'studyButton', 'meetingPanel', 'meetingButton'].map((id) => [id, make(id)]))
  const observers = []
  class FakeObserver {
    constructor(cb) {
      this.cb = cb
      observers.push(this)
    }
    observe() {}
    disconnect() {
      this.gone = true
    }
  }
  const doc = { body: { dataset: {} }, getElementById: (id) => (id === 'dock' && !withDock ? null : els[id] ?? null), defaultView: { MutationObserver: FakeObserver } }
  return { doc, els, tick: () => observers.forEach((o) => !o.gone && o.cb()) }
}
const PANELS = [
  { name: 'study', panel: 'studyPanel', button: 'studyButton' },
  { name: 'meeting', panel: 'meetingPanel', button: 'meetingButton' }
]

test('a page without a dock gets none (and nothing throws)', () => {
  assert.equal(createDock({ doc: fakeDoc({ withDock: false }).doc, panels: PANELS }), null)
})

test('the dock follows the panels: shown when one is, said on the body, hidden when none is', () => {
  const { doc, els, tick } = fakeDoc()
  const dock = createDock({ doc, panels: PANELS })
  assert.equal(els.dock.hidden, true)
  assert.equal(doc.body.dataset.dock, 'none')
  assert.equal(doc.body.dataset.dockOpen, 'false')

  els.studyPanel.hidden = false
  tick()
  assert.equal(els.dock.hidden, false)
  assert.equal(dock.current(), 'study')
  assert.equal(doc.body.dataset.dock, 'study')
  assert.equal(doc.body.dataset.dockOpen, 'true')

  els.studyPanel.hidden = true
  tick()
  assert.equal(els.dock.hidden, true)
  assert.equal(doc.body.dataset.dockOpen, 'false')
})

test('opening Meeting while Study is open closes Study and tells its button', () => {
  const { doc, els, tick } = fakeDoc()
  createDock({ doc, panels: PANELS })
  els.studyPanel.hidden = false
  tick()
  els.meetingPanel.hidden = false
  tick()
  assert.equal(els.studyPanel.hidden, true)
  assert.equal(els.studyButton.attrs['aria-expanded'], 'false')
  assert.equal(els.meetingPanel.hidden, false)
  assert.equal(doc.body.dataset.dock, 'meeting')
  // and back again
  els.studyPanel.hidden = false
  tick()
  assert.equal(els.meetingPanel.hidden, true)
  assert.equal(els.meetingButton.attrs['aria-expanded'], 'false')
  assert.equal(doc.body.dataset.dock, 'study')
})

test('close() hides whatever is open and the dock with it', () => {
  const { doc, els, tick } = fakeDoc()
  const dock = createDock({ doc, panels: PANELS })
  els.meetingPanel.hidden = false
  tick()
  dock.close()
  assert.equal(els.meetingPanel.hidden, true)
  assert.equal(els.meetingButton.attrs['aria-expanded'], 'false')
  assert.equal(els.dock.hidden, true)
  assert.equal(dock.current(), null)
})

test('a panel that is already open when the dock starts is shown in it', () => {
  const { doc, els } = fakeDoc()
  els.meetingPanel.hidden = false
  createDock({ doc, panels: PANELS })
  assert.equal(els.dock.hidden, false)
  assert.equal(doc.body.dataset.dock, 'meeting')
})
