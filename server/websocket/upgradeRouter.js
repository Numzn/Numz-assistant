/**
 * One dispatcher for every WebSocket upgrade on the HTTP server.
 *
 * `ws` servers created with `{ server, path }` each answer 400 to an upgrade for a path that is not
 * theirs, so two of them on one server destroy each other's connections. Instead each endpoint creates
 * its own `WebSocketServer({ noServer: true })` and registers a handler here by exact path. Anything
 * not registered is refused with 404 rather than left hanging.
 */

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  500: 'Internal Server Error',
  503: 'Service Unavailable'
}

/** Refuses an upgrade with a small JSON body and closes the socket. */
export function rejectUpgrade(socket, status, code) {
  if (socket.destroyed) return
  const body = JSON.stringify({ error: code, code })
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  )
  socket.destroy()
}

export function createUpgradeRouter(httpServer, { logger = console } = {}) {
  const routes = new Map()

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = ''
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return rejectUpgrade(socket, 400, 'bad-request')
    }
    const handler = routes.get(pathname)
    if (!handler) return rejectUpgrade(socket, 404, 'not-found')
    try {
      handler(req, socket, head)
    } catch (err) {
      logger.error(`[ws] upgrade handler for ${pathname} failed:`, err)
      rejectUpgrade(socket, 500, 'internal-error')
    }
  })

  return {
    add(path, handler) {
      if (routes.has(path)) throw new Error(`An upgrade handler is already registered for ${path}`)
      routes.set(path, handler)
    }
  }
}
