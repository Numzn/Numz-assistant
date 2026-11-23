/**
 * The dock: the one place for the panels that sit beside the conversation (Study, Meeting).
 *
 * Before this there were two panels with two different ideas of where to be: Meeting took a column of its own, Study
 * lay over the right edge. Open together, Study hid Meeting; open alone, Study covered the conversation, the composer
 * and the header buttons that could have closed it. Now there is one container (#dock) that the stylesheet places, and
 * this module keeps it honest: at most one panel is shown in it, and the page's body says which (data-dock) and whether
 * any (data-dock-open) so that the CSS can make room for it, or replace the conversation with it on a narrow window.
 *
 * The panels themselves are untouched: they still open and close by their own `hidden` attribute (their own buttons,
 * the voice command that opens Meeting, an unfinished meeting reopening itself). The dock only watches that attribute.
 *
 * resolveDock is the whole decision and is DOM-free (and tested); createDock only reads and writes the page.
 */

/**
 * Which panel stays when the shown ones change.
 * @param {string[]} visible names of the panels that are shown now (in the order the page lists them)
 * @param {string|null} previous the panel that was the open one before this change
 * @returns {{ open: string|null, close: string[] }} the panel to keep, and the ones to hide
 */
export function resolveDock({ visible = [], previous = null } = {}) {
  if (visible.length === 0) return { open: null, close: [] }
  if (visible.length === 1) return { open: visible[0], close: [] }
  // Several are shown: the one that was just opened (not the one that was already open) wins; with no earlier one, the last listed.
  const fresh = visible.filter((name) => name !== previous)
  const open = fresh[fresh.length - 1]
  return { open, close: visible.filter((name) => name !== open) }
}

/**
 * @param {object} options
 * @param {Document} [options.doc]
 * @param {{ name: string, panel: string, button: string }[]} options.panels ids (not selectors) of each panel and the button that opens it
 * @returns {{ current: () => string|null, close: () => void, destroy: () => void }|null} null when the page has no dock
 */
export function createDock({ doc = globalThis.document, panels = [] } = {}) {
  const dock = doc?.getElementById?.('dock')
  if (!dock) return null
  const entries = panels
    .map(({ name, panel, button }) => ({ name, panel: doc.getElementById(panel), button: doc.getElementById(button) }))
    .filter((entry) => entry.panel)
  if (!entries.length) return null

  let open = null

  function hide(entry) {
    entry.panel.hidden = true
    entry.button?.setAttribute('aria-expanded', 'false')
  }

  function sync() {
    const visible = entries.filter((entry) => !entry.panel.hidden).map((entry) => entry.name)
    const decision = resolveDock({ visible, previous: open })
    for (const name of decision.close) hide(entries.find((entry) => entry.name === name))
    open = decision.open
    dock.hidden = open === null
    doc.body.dataset.dock = open ?? 'none'
    doc.body.dataset.dockOpen = String(open !== null)
  }

  // A change to `hidden` on any panel, from whatever opened or closed it, lands here after the change is made.
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver
  const observer = Observer ? new Observer(sync) : null
  for (const entry of entries) observer?.observe(entry.panel, { attributes: true, attributeFilter: ['hidden'] })
  sync()

  return {
    current: () => open,
    /** Closes whatever is open (the panel keeps its own state: a meeting goes on recording, a study session goes on). */
    close() {
      for (const entry of entries) if (!entry.panel.hidden) hide(entry)
      sync()
    },
    destroy: () => observer?.disconnect()
  }
}
