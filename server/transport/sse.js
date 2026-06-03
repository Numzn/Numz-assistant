export function createSseStream(req, res) {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let closed = false

  req.on('aborted', () => {
    closed = true
  })

  res.on('close', () => {
    closed = true
  })

  function send(event, data = {}) {
    if (closed || res.destroyed) return false
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    return true
  }

  function end() {
    if (closed || res.destroyed) return
    closed = true
    res.end()
  }

  return {
    send,
    end,
    get closed() {
      return closed || res.destroyed
    }
  }
}
