/**
 * True when the browser says the person is saving data or is on a 2G connection, where a download nobody asked for
 * (the orb's code, the web fonts) is unwelcome. Unknown (no Network Information API) counts as fine.
 */
export function isLowBandwidth(connection = globalThis.navigator?.connection) {
  if (connection?.saveData === true) return true
  return /(^|-)2g$/.test(String(connection?.effectiveType ?? ''))
}
