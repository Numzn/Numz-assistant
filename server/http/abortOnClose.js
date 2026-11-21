/**
 * An AbortSignal that fires when the browser goes away before the response is finished, so a model call nobody is waiting for stops
 * (and stops costing money). Pass it to the usage meter as its `signal`.
 */
export function abortOnClose(res) {
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort(Object.assign(new Error('The connection was closed'), { name: 'AbortError' }))
  })
  return controller.signal
}
