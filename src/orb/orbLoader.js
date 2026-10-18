/**
 * Loads the Three.js orb on demand. This file imports nothing from Three.js, so it is cheap to ship in the first
 * page load; the orb itself (src/orb/createOrb.js) arrives as a separate file.
 *
 *   prefetch()  downloads the orb code and runs nothing: no WebGL context, no GPU memory.
 *   load()      downloads (if needed) and creates the orb, once. Concurrent calls share the work; a failure is
 *               reported and forgotten so the next call tries again.
 *   frame()     draws one frame; does nothing until the orb exists, so callers need not check.
 *
 * The orb is decoration. Whoever calls load() must carry on if it rejects (a missing file, a browser without
 * WebGL): voice mode works without it.
 */
export function createOrbLoader({ options, importOrb = () => import('./createOrb.js') }) {
  /** @type {Promise<{ createOrb: Function }> | null} */
  let modulePromise = null
  /** @type {Promise<any> | null} */
  let orbPromise = null
  let orb = null

  function fetchModule() {
    if (!modulePromise) {
      modulePromise = Promise.resolve()
        .then(() => importOrb())
        .catch((err) => {
          modulePromise = null
          throw err
        })
    }
    return modulePromise
  }

  return {
    prefetch() {
      return fetchModule().then(
        () => true,
        () => false // a failed prefetch is not an error; load() will try again when the orb is really needed
      )
    },

    load() {
      if (orb) return Promise.resolve(orb)
      if (!orbPromise) {
        orbPromise = fetchModule()
          .then(({ createOrb }) => {
            orb = createOrb(typeof options === 'function' ? options() : options)
            return orb
          })
          .catch((err) => {
            orbPromise = null
            throw err
          })
      }
      return orbPromise
    },

    isLoaded: () => orb !== null,

    frame(elapsedSeconds, deltaSeconds) {
      if (orb) orb.frame(elapsedSeconds, deltaSeconds)
    }
  }
}

/**
 * Starts `prefetch` once the page has settled, so the orb code is already there when voice mode is first used,
 * without competing with the page's own first load. Skipped on a data-saver or 2G connection, where a
 * background download of this size would be unwelcome; load() still works then, on demand.
 */
export function prefetchWhenIdle(prefetch, { connection = globalThis.navigator?.connection, schedule = defaultSchedule, delayMs = 2000 } = {}) {
  if (connection?.saveData === true) return false
  if (/(^|-)2g$/.test(String(connection?.effectiveType ?? ''))) return false
  schedule(() => {
    prefetch()
  }, delayMs)
  return true
}

function defaultSchedule(callback, delayMs) {
  const idle = globalThis.requestIdleCallback
  const start = () => (typeof idle === 'function' ? idle(callback, { timeout: 5000 }) : callback())
  setTimeout(start, delayMs)
}
