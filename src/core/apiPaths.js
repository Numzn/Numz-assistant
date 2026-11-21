/**
 * Where the app lives. Under the shared site the app is served at /ai/ (Vite's `base`), so every address the page asks the server for
 * (the API, the sockets, the wake-word model, the audio worklet) has to carry that prefix, while the same code at the root (a local run,
 * the unit tests) has none. One place decides it: BASE is '' or '/ai', never ends in a slash.
 */
const configured = import.meta.env?.BASE_URL
export const BASE = (typeof configured === 'string' ? configured : '/').replace(/\/+$/, '')

/** '/api/v1/x' -> '/ai/api/v1/x' (or unchanged at the root). */
export const withBase = (path) => `${BASE}${path}`
