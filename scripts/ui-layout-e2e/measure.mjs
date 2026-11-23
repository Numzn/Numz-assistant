// What the layout checks measure, as ONE self-contained function: it runs inside the page (Playwright's page.evaluate in run.mjs, a WebDriver
// execute/sync in the desktop app's own WebKit in desktop/e2e/layout.mjs), so both engines are asked exactly the same thing and it must not
// close over anything outside itself.
export const measureLayout = () => {
  const el = (sel) => document.querySelector(sel)
  const shown = (e) => e && !e.hidden && getComputedStyle(e).display !== 'none'
  const rect = (sel) => {
    const e = el(sel)
    if (!shown(e)) return null
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }
  }
  // Can a person click it? The top element at the centre of the part of it that is on screen must be the element (or inside it).
  const reachable = (sel, clipTo = null) => {
    const e = el(sel)
    if (!shown(e) || getComputedStyle(e).visibility === 'hidden') return false
    const r = e.getBoundingClientRect()
    // The part of it that is on screen (and, for a message in the thread, inside the scrolling conversation): its middle.
    const c = clipTo ? el(clipTo).getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    const left = Math.max(r.left, c.left, 0)
    const right = Math.min(r.right, c.right, innerWidth)
    const top = Math.max(r.top, c.top, 0)
    const bottom = Math.min(r.bottom, c.bottom, innerHeight)
    if (right - left < 4 || bottom - top < 4) return false
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
    return Boolean(hit && (hit === e || e.contains(hit)))
  }
  const visible = [...document.querySelectorAll('#dock > section')].filter((s) => !s.hidden && getComputedStyle(s).display !== 'none').map((s) => s.id)
  return {
    w: innerWidth,
    h: innerHeight,
    hScroll: document.documentElement.scrollWidth > innerWidth,
    dockAttr: document.body.dataset.dock,
    visiblePanels: visible,
    dock: rect('#dock'),
    chatMain: rect('#chatMain'),
    composer: rect('#composer'),
    composerInput: rect('#composerInput'),
    header: rect('#appHeader'),
    sidebar: rect('#sidebar'),
    sidebarVisible: shown(el('#sidebar')) && getComputedStyle(el('#sidebar')).visibility !== 'hidden',
    chatVisibility: getComputedStyle(el('#chatMain')).visibility,
    chatScrollTop: el('#chatMain').scrollTop,
    reach: Object.fromEntries(['#composerInput', '#sendButton', '#meetingButton', '#studyButton', '#studyAskInput', '#studyClose', '#meetingStart', '#meetingClose', '#sidebarToggle', '#thread > li:last-child'].map((s) => [s, reachable(s, s.startsWith('#thread') ? '#chatMain' : null)]))
  }
}
