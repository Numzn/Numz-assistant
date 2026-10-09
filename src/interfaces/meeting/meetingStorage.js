/**
 * Remembers ONE unfinished meeting (its id and ticket) so a refreshed or closed tab can still finish it.
 * The ticket only lets its holder write to and end that one meeting, and expires on its own.
 *
 * Browser storage can be missing or throw (private windows, blocked site data), so every access is
 * guarded and a failure just means "nothing remembered".
 */

const KEY = 'numz.meeting.unfinished.v1'

export function createMeetingStorage(webStorage = globalThis.localStorage) {
  return {
    read() {
      try {
        const parsed = JSON.parse(webStorage.getItem(KEY) ?? 'null')
        if (parsed && typeof parsed.meetingId === 'string' && typeof parsed.ticketToken === 'string') return parsed
      } catch {
        /* nothing usable stored */
      }
      return null
    },
    write(entry) {
      try {
        webStorage.setItem(KEY, JSON.stringify(entry))
      } catch {
        /* the meeting still works; it just cannot be resumed after a reload */
      }
    },
    clear() {
      try {
        webStorage.removeItem(KEY)
      } catch {
        /* ignore */
      }
    }
  }
}

/** An in-memory stand-in with the same shape, for tests and for browsers with no storage. */
export function createMemoryMeetingStorage() {
  let entry = null
  return {
    read: () => entry,
    write: (value) => {
      entry = value
    },
    clear: () => {
      entry = null
    }
  }
}
