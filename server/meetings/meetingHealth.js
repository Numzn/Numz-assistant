import { SCHEMA_VERSION } from '../persistence/sqliteDatabase.js'

const PROBLEM = 'MEETING_API_TOKEN and MEETING_TICKET_SECRET (each at least 32 characters) must both be set'
const LAUNCH_NOTE = 'MEETING_LAUNCH_CODE (at least 12 characters) is not set: the browser cannot start meetings'

/**
 * What an operator needs to know to tell whether meeting persistence can work, without revealing
 * any secret: only whether each credential type is usable. `ready` is false when either is missing,
 * because then the speech transport cannot attach to a meeting.
 */
export function meetingsHealth({ auth, schemaVersion = SCHEMA_VERSION }) {
  const { admin, tickets } = auth.enabled
  const ready = admin && tickets
  return {
    ready,
    schemaVersion,
    auth: { admin, tickets },
    // Whether the browser's Start meeting button can work (a launch code is set and tickets are usable).
    launch: { enabled: auth.launchEnabled === true },
    ...(ready ? {} : { problem: PROBLEM })
  }
}

/** One startup line per fact, with a warning when persistence cannot work. */
export function logMeetingsConfig({ auth, logger = console }) {
  const { admin, tickets } = auth.enabled
  logger.log(
    `[meetings] auth: admin ${admin ? 'enabled' : 'DISABLED'}, tickets ${tickets ? 'enabled' : 'DISABLED'}`
  )
  if (!(admin && tickets)) {
    logger.warn(`[meetings] persistence is NOT usable: ${PROBLEM}. Meeting routes answer 503 until they are set.`)
  }
  logger.log(`[meetings] browser launch: ${auth.launchEnabled === true ? 'enabled' : 'DISABLED'}`)
  if (auth.launchEnabled !== true) logger.warn(`[meetings] ${LAUNCH_NOTE}.`)
}
