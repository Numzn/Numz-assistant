import assert from 'node:assert/strict'
import test from 'node:test'
import { CaptureError, createNativeCapture, describeCaptureError } from '../src/interfaces/screenshot/nativeCapture.js'
import { ScreenshotApiError } from '../src/interfaces/screenshot/screenshotApi.js'
import { createScreenshotController } from '../src/interfaces/screenshot/screenshotController.js'

const BYTES = new Uint8Array([1, 2, 3])
const captureError = (code) => new CaptureError(code, describeCaptureError(code)) // as the bridge makes them
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve))
}

function fakeNative({ available = true } = {}) {
  const calls = { capture: [], export: [], discard: [], windows: 0 }
  const state = { captureError: null, exportSizes: [], held: new Set(), next: 0 }
  return {
    calls,
    state,
    available,
    async status() {
      return { platform: 'linux', session: 'x11', modes: { screen: true, window: true, region: true }, permission: 'granted', note: '' }
    },
    async listWindows() {
      calls.windows++
      if (state.windowsError) throw new CaptureError('unsupported', 'no windows')
      return [{ id: 'w1', title: 'Terminal', app: 'term', width: 800, height: 600 }]
    },
    async capture(args) {
      calls.capture.push(args)
      if (state.captureError) throw state.captureError
      const captureId = `cap${++state.next}`
      state.held.add(captureId)
      return { captureId, width: 2000, height: 1000, preview: 'data:image/jpeg;base64,AAAA' }
    },
    async exportCapture(args) {
      calls.export.push(args)
      state.exportSizes.push(args.maxSide)
      return { bytes: BYTES, mimeType: 'image/jpeg', width: 100, height: 50 }
    },
    async discard(id) {
      calls.discard.push(id)
      state.held.delete(id)
    }
  }
}

function fakeApi() {
  const calls = { attach: [], get: [], cancel: [], retry: [], ask: [], remove: [] }
  const script = {
    attach: async (conv, image, opts) => ({ id: opts.id, conversationId: conv, status: 'analyzing', pictureKept: true }),
    // successive answers to get(); the last one repeats
    gets: [{ status: 'ready', analysis: 'It is a terminal.', pictureKept: true }],
    retry: async (id) => ({ id, status: 'analyzing', pictureKept: true }),
    ask: async () => ({ answer: 'Line 3.' }),
    remove: async () => true,
    cancel: async (id) => ({ id, status: 'cancelled' })
  }
  return {
    calls,
    script,
    attach: (conv, image, opts) => {
      calls.attach.push({ conv, image, opts })
      return script.attach(conv, image, opts)
    },
    get: async (id) => {
      calls.get.push(id)
      const next = script.gets.length > 1 ? script.gets.shift() : script.gets[0]
      if (next instanceof Error) throw next
      return { id, conversationId: 'conv-1', ...next }
    },
    cancel: (id) => {
      calls.cancel.push(id)
      return script.cancel(id)
    },
    retry: (id) => {
      calls.retry.push(id)
      return script.retry(id)
    },
    ask: (id, q) => {
      calls.ask.push({ id, q })
      return script.ask(id, q)
    },
    remove: (id, conv) => {
      calls.remove.push({ id, conv })
      return script.remove(id, conv)
    }
  }
}

function build({ native = fakeNative(), api = fakeApi(), conversation = { id: 'conv-1' } } = {}) {
  const exchanges = []
  const removed = []
  let n = 0
  const controller = createScreenshotController({
    native,
    api,
    getConversationId: () => conversation.id,
    onExchange: (e) => exchanges.push(e),
    onRemoved: (r) => removed.push(r),
    wait: () => Promise.resolve(),
    newId: () => `id-${++n}`
  })
  return { controller, native, api, exchanges, removed, conversation }
}

async function toPreview(t, args = { mode: 'screen' }) {
  await t.controller.capture(args)
  assert.equal(t.controller.getState().phase, 'preview')
}
async function toReady(t) {
  await toPreview(t)
  await t.controller.analyse()
  await flush()
  assert.equal(t.controller.getState().phase, 'ready')
}

test('in a plain browser there is no native capture: the controller says so and nothing is attempted', async () => {
  const native = createNativeCapture({ invoke: null })
  assert.equal(native.available, false)
  const t = build({ native })
  await t.controller.init()
  assert.equal(t.controller.getState().phase, 'unavailable')
  assert.match(t.controller.getState().message, /desktop app/)
  await t.controller.capture({ mode: 'screen' })
  assert.equal(t.controller.getState().phase, 'unavailable')
  await assert.rejects(native.capture({ mode: 'screen' }), (err) => err.code === 'unavailable')
})

test('the bridge turns what the Rust layer says into plain errors, and decodes what it exports', async () => {
  const sent = []
  const native = createNativeCapture({
    invoke: async (command, args) => {
      sent.push([command, args])
      if (command === 'screenshot_capture') throw { code: 'permission-denied', message: 'raw words' }
      if (command === 'screenshot_export') return { data: btoa('\u0001\u0002\u0003'), mimeType: 'image/jpeg', width: 3, height: 1 }
      if (command === 'screenshot_windows') return [{ id: 7, title: 'A', app: 'B', width: 1, height: 2 }]
      throw 'a string, not an error object'
    }
  })
  await assert.rejects(native.capture({ mode: 'screen' }), (err) => err instanceof CaptureError && err.code === 'permission-denied' && /privacy settings/.test(err.message) && !/raw words/.test(err.message))
  assert.deepEqual([...(await native.exportCapture({ captureId: 'c', rect: null })).bytes], [1, 2, 3])
  assert.deepEqual(await native.listWindows(), [{ id: '7', title: 'A', app: 'B', width: 1, height: 2 }])
  await assert.rejects(native.status(), (err) => err.code === 'capture-failed')
  await assert.rejects(native.capture({ mode: 'bogus' }), (err) => err.code === 'capture-failed')
  assert.equal(sent.some(([command]) => /key|mouse|click|input/i.test(command)), false, 'no command that sends input exists')
})

test('capture -> preview -> analyse: the picture is sent with the question and an id of the page\'s own, analysed in the background, and added to the conversation', async () => {
  const t = build()
  await t.controller.init()
  await toPreview(t)
  t.controller.setQuestion('What is this?')
  const pending = t.controller.analyse()
  await pending
  assert.equal(t.controller.getState().phase, 'analyzing', 'analyse returns as soon as the server has it')
  assert.deepEqual(t.native.calls.export[0], { captureId: 'cap1', rect: null, maxSide: 2048 })
  assert.deepEqual(t.api.calls.attach[0].conv, 'conv-1')
  assert.equal(t.api.calls.attach[0].opts.question, 'What is this?')
  assert.equal(t.api.calls.attach[0].opts.id, 'id-1')
  assert.equal(t.api.calls.attach[0].image.mimeType, 'image/jpeg')
  assert.deepEqual(t.native.calls.discard, ['cap1'], 'the native copy was let go as soon as it was exported')
  await flush()
  const s = t.controller.getState()
  assert.equal(s.phase, 'ready')
  assert.equal(s.analysis, 'It is a terminal.')
  assert.deepEqual(t.exchanges, [{ kind: 'analysis', shotId: 'id-1', question: 'What is this?', analysis: 'It is a terminal.' }])
})

test('a region is a crop of the capture, chosen on its preview: clamped to the picture, and a speck is no selection', async () => {
  const t = build()
  await toPreview(t, { mode: 'region' })
  assert.deepEqual(t.native.calls.capture[0], { mode: 'screen', windowId: null }, 'the native layer captures the display; the crop is made after')
  t.controller.setSelection({ x: 1900, y: 900, width: 500, height: 500 })
  assert.deepEqual(t.controller.getState().selection, { x: 1900, y: 900, width: 100, height: 100 })
  t.controller.setSelection({ x: 10, y: 10, width: 3, height: 3 })
  assert.equal(t.controller.getState().selection, null)
  t.controller.setSelection({ x: -20, y: 40, width: 600, height: 300 })
  await t.controller.analyse()
  assert.deepEqual(t.native.calls.export[0].rect, { x: 0, y: 40, width: 600, height: 300 })
})

test('a window is captured by the id the person picked from the list', async () => {
  const t = build()
  await t.controller.loadWindows()
  assert.equal(t.controller.getState().windows[0].title, 'Terminal')
  await toPreview(t, { mode: 'window', windowId: 'w1' })
  assert.deepEqual(t.native.calls.capture[0], { mode: 'window', windowId: 'w1' })
  const broken = build()
  broken.native.state.windowsError = true
  await broken.controller.loadWindows()
  assert.equal(broken.controller.getState().windows.length, 0)
  assert.equal(broken.controller.getState().windowsError, 'no windows')
})

test('permission denied, an unsupported session and a dismissed prompt are each handled, and leave the page ready to try again', async () => {
  const t = build()
  t.native.state.captureError = captureError('permission-denied')
  await t.controller.capture({ mode: 'screen' })
  let s = t.controller.getState()
  assert.equal(s.phase, 'idle')
  assert.equal(s.tone, 'error')
  assert.match(s.message, /not allowed to capture the screen.*privacy settings/)
  assert.equal(s.capture, null)

  t.native.state.captureError = captureError('unsupported')
  await t.controller.capture({ mode: 'screen' })
  assert.match(t.controller.getState().message, /cannot be captured/)

  t.native.state.captureError = captureError('cancelled')
  await t.controller.capture({ mode: 'screen' })
  s = t.controller.getState()
  assert.equal(s.message, '', 'a prompt the person dismissed is not an error')
  assert.equal(s.tone, 'info')

  t.native.state.captureError = null
  await t.controller.capture({ mode: 'screen' })
  assert.equal(t.controller.getState().phase, 'preview', 'and once permission is given, it works')
})

test('a new capture while one is being analysed is refused; a preview is replaced and its native copy freed', async () => {
  const api = fakeApi()
  api.script.gets = [{ status: 'analyzing' }]
  const t = build({ api })
  await toPreview(t)
  await t.controller.analyse()
  await t.controller.capture({ mode: 'screen' })
  assert.match(t.controller.getState().message, /still being analysed/)
  assert.equal(t.native.calls.capture.length, 1)
  await t.controller.cancel()

  const u = build()
  await toPreview(u)
  await u.controller.capture({ mode: 'screen' })
  assert.deepEqual(u.native.calls.discard, ['cap1'], 'the first preview was thrown away')
  assert.deepEqual([...u.native.state.held], ['cap2'])
})

test('cancel: while capturing, while sending, and while the model works - and nothing is added to the conversation', async () => {
  // while the model is working
  const api = fakeApi()
  api.script.gets = [{ status: 'analyzing' }]
  const t = build({ api })
  await toPreview(t)
  await t.controller.analyse()
  await t.controller.cancel()
  assert.equal(t.controller.getState().phase, 'cancelled')
  assert.deepEqual(api.calls.cancel, ['id-1'])
  await flush()
  assert.equal(t.exchanges.length, 0)
  assert.equal(t.controller.getState().phase, 'cancelled', 'a late poll does not bring it back')

  // while it is being sent: the request is aborted and the id the page chose is undone on the server
  const slow = fakeApi()
  let aborted = false
  slow.script.attach = (_c, _i, opts) =>
    new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        aborted = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })
  const u = build({ api: slow })
  await toPreview(u)
  const running = u.controller.analyse()
  await flush(2)
  assert.equal(u.controller.getState().phase, 'uploading')
  await u.controller.cancel()
  await running
  assert.equal(aborted, true)
  assert.equal(u.controller.getState().phase, 'cancelled')
  assert.deepEqual(slow.calls.remove, [{ id: 'id-1', conv: 'conv-1' }])

  // while capturing
  const native = fakeNative()
  let release
  native.capture = () => new Promise((resolve) => (release = () => resolve({ captureId: 'late', width: 1, height: 1, preview: 'data:,' })))
  const v = build({ native })
  const pending = v.controller.capture({ mode: 'screen' })
  await flush(2)
  assert.equal(v.controller.getState().phase, 'capturing')
  await v.controller.cancel()
  release()
  await pending
  assert.equal(v.controller.getState().phase, 'idle')
  assert.deepEqual(native.calls.discard, ['late'], 'a picture that arrives after Cancel is thrown away')
})

test('a failed analysis says why and can be retried on the picture the server still holds', async () => {
  const api = fakeApi()
  api.script.gets = [{ status: 'failed', error: { code: 'timeout', message: 'The vision service took too long. Try again.' }, retryable: true }]
  const t = build({ api })
  await toPreview(t)
  await t.controller.analyse()
  await flush()
  let s = t.controller.getState()
  assert.equal(s.phase, 'failed')
  assert.equal(s.error.code, 'timeout')
  assert.equal(s.error.retryable, true)
  assert.match(s.message, /took too long/)

  api.script.gets = [{ status: 'ready', analysis: 'ok now', pictureKept: true }]
  await t.controller.retry()
  await flush()
  s = t.controller.getState()
  assert.equal(s.phase, 'ready')
  assert.deepEqual(api.calls.retry, ['id-1'])
  assert.equal(api.calls.attach.length, 1, 'the picture was not sent again')
})

test('when the server\'s copy is gone, retry sends the picture the page still holds, under a new id; with nothing held it says to capture again', async () => {
  const api = fakeApi()
  api.script.gets = [{ status: 'failed', error: { code: 'vision-unavailable', message: 'down' }, retryable: true }]
  api.script.retry = async () => {
    throw new ScreenshotApiError('gone', { status: 410, code: 'picture-expired' })
  }
  const t = build({ api })
  await toPreview(t)
  await t.controller.analyse()
  await flush()
  api.script.gets = [{ status: 'ready', analysis: 'sent again' }]
  await t.controller.retry()
  await flush()
  assert.equal(api.calls.attach.length, 2)
  assert.equal(api.calls.attach[1].opts.id, 'id-2')
  assert.deepEqual(api.calls.remove[0], { id: 'id-1', conv: 'conv-1' }, 'the stale record is cleared')
  assert.equal(t.controller.getState().phase, 'ready')
})

test('an upload that fails (network, busy, vision not set up) is reported with what to do, and a lost answer is recovered by the id', async () => {
  const api = fakeApi()
  api.script.attach = async () => {
    throw new ScreenshotApiError('offline', { status: 0, code: 'network' })
  }
  const t = build({ api })
  await toPreview(t)
  await t.controller.analyse()
  let s = t.controller.getState()
  assert.equal(s.phase, 'failed')
  assert.equal(s.error.retryable, true)
  assert.match(s.message, /could not be reached/)

  // the first try did reach the server (only its answer was lost): the second says "duplicate-id" and the page carries on with that one
  api.script.attach = async () => {
    throw new ScreenshotApiError('dup', { status: 409, code: 'duplicate-id' })
  }
  api.script.gets = [{ status: 'ready', analysis: 'recovered' }]
  await t.controller.retry()
  await flush()
  assert.equal(t.controller.getState().phase, 'ready')
  assert.equal(t.controller.getState().analysis, 'recovered')

  const off = fakeApi()
  off.script.attach = async () => {
    throw new ScreenshotApiError('Reading pictures is not set up on this server yet.', { status: 503, code: 'vision-not-configured' })
  }
  const u = build({ api: off })
  await toPreview(u)
  await u.controller.analyse()
  s = u.controller.getState()
  assert.equal(s.phase, 'failed')
  assert.match(s.message, /not set up on this server/)
})

test('a picture the server finds too large is sent again smaller, without the person doing anything', async () => {
  const api = fakeApi()
  let tries = 0
  api.script.attach = async (conv, _i, opts) => {
    if (++tries < 3) throw new ScreenshotApiError('too large', { status: 413, code: 'image-too-large' })
    return { id: opts.id, conversationId: conv, status: 'analyzing' }
  }
  const t = build({ api })
  await toPreview(t)
  await t.controller.analyse()
  assert.deepEqual(t.native.state.exportSizes, [2048, 1400, 900])
  assert.equal(t.controller.getState().phase, 'analyzing')

  const hopeless = fakeApi()
  hopeless.script.attach = async () => {
    throw new ScreenshotApiError('too large', { status: 413, code: 'image-too-large' })
  }
  const u = build({ api: hopeless })
  await toPreview(u)
  await u.controller.analyse()
  assert.equal(u.controller.getState().phase, 'failed')
  assert.equal(u.native.state.exportSizes.length, 3, 'it stopped trying at the smallest size')
})

test('losing the server while waiting fails after a few tries; a screenshot the server forgot is not retried', async () => {
  const api = fakeApi()
  api.script.gets = [new ScreenshotApiError('x', { status: 0, code: 'network' })]
  const t = build({ api })
  await toPreview(t)
  await t.controller.analyse()
  await flush(20)
  assert.equal(t.controller.getState().phase, 'failed')
  assert.equal(t.controller.getState().error.retryable, true)

  const gone = fakeApi()
  gone.script.gets = [new ScreenshotApiError('nope', { status: 404, code: 'screenshot-not-found' })]
  const u = build({ api: gone })
  await toPreview(u)
  await u.controller.analyse()
  await flush()
  assert.equal(u.controller.getState().phase, 'failed')
  assert.equal(u.controller.getState().error.retryable, false)
  await u.controller.retry()
  assert.equal(gone.calls.retry.length, 0, 'not retryable: nothing was asked')
})

test('delete: from the preview it only discards; after analysis it removes the picture and its messages; a failed delete keeps the controls', async () => {
  const t = build()
  await toPreview(t)
  await t.controller.remove()
  assert.equal(t.controller.getState().phase, 'idle')
  assert.deepEqual(t.native.calls.discard, ['cap1'])
  assert.equal(t.api.calls.remove.length, 0, 'nothing had been sent, so nothing to delete on the server')

  const u = build()
  await toReady(u)
  await u.controller.remove()
  assert.deepEqual(u.api.calls.remove, [{ id: 'id-1', conv: 'conv-1' }])
  assert.deepEqual(u.removed, [{ shotId: 'id-1', conversationId: 'conv-1' }])
  assert.equal(u.controller.getState().phase, 'idle')

  const api = fakeApi()
  api.script.remove = async () => {
    throw new ScreenshotApiError('x', { status: 500, code: 'delete-failed' })
  }
  const v = build({ api })
  await toReady(v)
  await v.controller.remove()
  assert.equal(v.controller.getState().phase, 'ready', 'it is still there, and says so')
  assert.match(v.controller.getState().message, /could not be deleted/)
  assert.equal(v.removed.length, 0)
})

test('a screenshot analysed after the person moved to another conversation is not dropped into that one', async () => {
  const api = fakeApi()
  api.script.gets = [{ status: 'analyzing' }, { status: 'ready', analysis: 'late' }]
  const t = build({ api })
  await toPreview(t)
  await t.controller.analyse()
  t.conversation.id = 'conv-2'
  await flush()
  const s = t.controller.getState()
  assert.equal(s.phase, 'ready')
  assert.match(s.message, /conversation you had open/)
  assert.equal(t.exchanges.length, 0)
})

test('a follow-up looks at the picture again; once it is no longer kept the page says to ask in the chat', async () => {
  const t = build()
  await toReady(t)
  const reply = await t.controller.ask('What is on line 3?')
  assert.equal(reply.answer, 'Line 3.')
  assert.deepEqual(t.exchanges.at(-1), { kind: 'follow-up', shotId: 'id-1', question: 'What is on line 3?', analysis: 'Line 3.' })
  assert.equal(await t.controller.ask('   '), null)

  t.api.script.ask = async () => {
    throw new ScreenshotApiError('no picture', { status: 410, code: 'picture-expired' })
  }
  assert.equal(await t.controller.ask('And line 4?'), null)
  const s = t.controller.getState()
  assert.equal(s.shot.pictureKept, false)
  assert.match(s.message, /ask in the chat below/)
})

test('dismissing the panel frees the native capture, cancels work in flight and keeps what is already in the conversation', async () => {
  const t = build()
  await toPreview(t)
  await t.controller.dismiss()
  assert.deepEqual(t.native.calls.discard, ['cap1'])
  assert.equal(t.controller.getState().phase, 'idle')

  const api = fakeApi()
  api.script.gets = [{ status: 'analyzing' }]
  const u = build({ api })
  await toPreview(u)
  await u.controller.analyse()
  await u.controller.dismiss()
  assert.deepEqual(api.calls.cancel, ['id-1'])
  assert.equal(u.controller.getState().phase, 'idle')
  assert.equal(u.removed.length, 0)
})
