/**
 * Operator CLI for the meeting API (create, start, ticket, show, end, cancel, fail).
 * Loads .env and .env.secrets like the server does; MEETING_API_TOKEN is never printed.
 */
import '../server/loadEnv.js'
import { runMeetingAdmin } from './lib/meetingAdmin.js'

process.exitCode = await runMeetingAdmin({ argv: process.argv.slice(2), env: process.env })
