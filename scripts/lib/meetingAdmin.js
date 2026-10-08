/**
 * Operator commands for the meeting API. Pure functions over an injected fetch, so they are tested without
 * a server. The admin token is read from the environment and is never printed.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const USAGE = `Usage: npm run meeting -- <command>

  create [title]            new meeting; prints its id and a ticket for the live client
  start <meeting-id>        make it LIVE (each client connection then attaches its own session)
  ticket <meeting-id>       mint another ticket for the live client
  show <meeting-id>         meeting, speech sessions and the transcript integrity report
  transcript <meeting-id>   the stored transcript with its integrity report
  end <meeting-id>          complete the meeting (refused while its transcript is incomplete)
  cancel <meeting-id> [reason...]
  fail <meeting-id> [reason...]

Reads MEETING_API_TOKEN (required) and MEETING_API_URL (server origin, default http://127.0.0.1:3103).`

class UsageError extends Error {}

function meetingIdFrom(args) {
  const id = args[0]
  if (!id || !UUID_RE.test(id)) throw new UsageError('a meeting id (UUID) is required')
  return id
}

/** command name -> { requests(args) } where each request is [method, path, body?]. */
const COMMANDS = {
  create: (args) => [['POST', '/', { metadata: args.length ? { title: args.join(' ') } : {} }]],
  start: (args) => [['POST', `/${meetingIdFrom(args)}/start`]],
  ticket: (args) => [['POST', `/${meetingIdFrom(args)}/ticket`]],
  end: (args) => [['POST', `/${meetingIdFrom(args)}/end`]],
  cancel: (args) => [['POST', `/${meetingIdFrom(args)}/cancel`, args.length > 1 ? { reason: args.slice(1).join(' ') } : {}]],
  fail: (args) => [['POST', `/${meetingIdFrom(args)}/fail`, args.length > 1 ? { reason: args.slice(1).join(' ') } : {}]],
  transcript: (args) => [['GET', `/${meetingIdFrom(args)}/transcript`]],
  show: (args) => {
    const id = meetingIdFrom(args)
    return [['GET', `/${id}`], ['GET', `/${id}/sessions`], ['GET', `/${id}/transcript`]]
  }
}

function shape(command, results) {
  if (command !== 'show') return results[0]
  const [meeting, sessions, transcript] = results
  return {
    meeting,
    speechSessions: sessions.speechSessions,
    segmentCount: transcript.segments.length,
    integrity: transcript.integrity
  }
}

/**
 * @returns {Promise<number>} exit code: 0 ok, 1 the API refused, 2 usage or configuration error
 */
export async function runMeetingAdmin({ argv, env, fetchImpl = fetch, out = console.log, err = console.error }) {
  const [command, ...args] = argv
  const token = env.MEETING_API_TOKEN ?? ''
  const base = `${(env.MEETING_API_URL || 'http://127.0.0.1:3103').replace(/\/+$/, '')}/api/v1/meetings`

  try {
    if (!command || !COMMANDS[command]) throw new UsageError(command ? `unknown command "${command}"` : 'a command is required')
    if (!token) throw new UsageError('MEETING_API_TOKEN is not set (put it in .env.secrets)')
    const requests = COMMANDS[command](args)

    const results = []
    for (const [method, path, body] of requests) {
      const response = await fetchImpl(`${base}${path === '/' ? '' : path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      })
      const text = await response.text()
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      if (!response.ok) {
        err(`${command} refused: ${response.status} ${json?.code ?? ''} ${json?.error ?? text.slice(0, 200)}`.trim())
        if (json?.details) err(JSON.stringify(json.details, null, 2))
        return 1
      }
      results.push(json)
    }
    out(JSON.stringify(shape(command, results), null, 2))
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      err(`error: ${error.message}\n\n${USAGE}`)
      return 2
    }
    err(`${command} failed: could not reach ${base} (${error?.cause?.code ?? error?.message ?? error})`)
    return 1
  }
}
