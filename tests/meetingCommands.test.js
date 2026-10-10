import assert from 'node:assert/strict'
import test from 'node:test'
import { createCommandRouter, normalize, parseCommand } from '../src/interfaces/commands/meetingCommands.js'

/**
 * Meeting commands: strict matching, confirmation before stopping, and no claim about the outcome that the
 * meeting controller (the backend's answer) did not make.
 */

const type = (text) => parseCommand(text)?.type ?? null

test('start-meeting phrasings are recognised, whatever the politeness, case or punctuation', () => {
  for (const text of [
    'start a meeting',
    'Start meeting',
    'start the meeting',
    'begin a meeting',
    'open a new meeting',
    'launch meeting',
    'record a meeting',
    'record this meeting',
    'create a meeting',
    "let's start a meeting",
    'Can you please start a meeting now?',
    'hey numz, start a meeting',
    'I want to start a meeting',
    "I'd like to start a new meeting",
    'start a meeting please',
    'Start a meeting.',
    'START A MEETING!!!',
    'start meeting recording'
  ]) {
    assert.equal(type(text), 'start', text)
  }
})

test('a title is taken from "called", "named" or "titled", with its own capitals and without quotes', () => {
  assert.deepEqual(parseCommand('start a meeting called Weekly sync'), { type: 'start', title: 'Weekly sync' })
  assert.deepEqual(parseCommand('Start a meeting named "Sprint review".'), { type: 'start', title: 'Sprint review' })
  assert.equal(parseCommand('start a meeting titled ' + 'x'.repeat(300)), null, 'overlong input is not a command')
})

test('stop-meeting phrasings are recognised', () => {
  for (const text of [
    'stop the meeting',
    'stop meeting',
    'end the meeting',
    'End meeting',
    'finish the meeting',
    'save the meeting',
    'stop the meeting and save',
    'wrap up the meeting',
    'please stop the meeting now',
    'close this meeting'
  ]) {
    assert.equal(type(text), 'stop', text)
  }
})

test('"stop recording" is a loose stop: it does not say which recording', () => {
  assert.deepEqual(parseCommand('stop recording'), { type: 'stop', loose: true })
  assert.deepEqual(parseCommand('stop the recording'), { type: 'stop', loose: true })
})

test('questions and ordinary sentences are NOT commands and go to the assistant', () => {
  for (const text of [
    'how do I start a meeting with a customer',
    'start a meeting with Bob about the budget',
    'start a meeting with the team',
    'what is a meeting',
    'tell me about meetings',
    'I have a meeting at 3',
    'summarise the meeting I just had',
    'stop',
    'start',
    'meeting',
    'can you start the car',
    'start recording audio for my podcast',
    'stop talking',
    'end the call',
    'cancel the meeting with Bob',
    'stop the meeting called standup',
    '',
    '   '
  ]) {
    assert.equal(parseCommand(text), null, JSON.stringify(text))
  }
})

test('yes and no are only answers; the router decides whether they mean anything', () => {
  assert.equal(type('yes'), 'yes')
  assert.equal(type('Yes, do it'), null, 'extra words are not a bare answer')
  assert.equal(type('confirm'), 'yes')
  assert.equal(type('no'), 'no')
  assert.equal(type('keep recording'), 'no')
})

test('normalize strips politeness and punctuation only', () => {
  assert.equal(normalize("Hey Numz, could you PLEASE start a meeting now?!"), 'start a meeting')
})

// ---- the router ----------------------------------------------------------------------------------------

function rig(initial = {}) {
  let state = { phase: 'idle', open: false, message: '', tone: 'info', ...initial }
  const calls = { stop: 0, panels: [], starts: [] }
  const meeting = {
    getState: () => state,
    async stop() {
      calls.stop += 1
      await meeting.onStop?.()
    },
    async start(options) {
      calls.starts.push(options)
      await meeting.onStart?.()
    }
  }
  let clock = 1_000
  const router = createCommandRouter({
    meeting,
    openPanel: (options) => calls.panels.push(options),
    now: () => clock
  })
  return {
    router,
    meeting,
    calls,
    set: (patch) => (state = { ...state, ...patch }),
    advance: (ms) => (clock += ms)
  }
}

test('start opens the meeting panel and tells the user to enter the launch code; it does not start anything', async () => {
  const r = rig()
  const result = await r.router.handle('start a meeting')
  assert.deepEqual(r.calls.panels, [{ title: undefined }])
  assert.match(result.reply, /launch code/i)
  assert.equal(r.calls.stop, 0)
  assert.doesNotMatch(result.reply, /started|recording now|saved/i)
})

test('a title is passed to the panel and mentioned back', async () => {
  const r = rig()
  const result = await r.router.handle('start a meeting called Weekly sync')
  assert.deepEqual(r.calls.panels, [{ title: 'Weekly sync' }])
  assert.match(result.reply, /Weekly sync/)
})

test('start while a meeting is recording does not open another', async () => {
  const r = rig({ phase: 'live', open: true })
  const result = await r.router.handle('start a meeting')
  assert.deepEqual(r.calls.panels, [])
  assert.match(result.reply, /already recording/i)
})

test('start while an earlier meeting was never finished says so and opens the panel to finish it', async () => {
  const r = rig({ phase: 'unfinished', open: true })
  const result = await r.router.handle('start a meeting')
  assert.equal(r.calls.panels.length, 1)
  assert.match(result.reply, /not finished/i)
})

test('stop asks first and changes nothing until the user confirms', async () => {
  const r = rig({ phase: 'live', open: true })
  const result = await r.router.handle('stop the meeting')
  assert.match(result.reply, /Stop and save the meeting\?/)
  assert.equal(r.calls.stop, 0)
})

test('after confirmation the meeting is stopped and the reply is exactly what the backend confirmed (verified)', async () => {
  const r = rig({ phase: 'live', open: true })
  r.meeting.onStop = () => r.set({ phase: 'done', open: false, tone: 'ok', message: 'Saved 3 lines. The transcript is complete and verified.' })
  await r.router.handle('stop the meeting')
  const result = await r.router.handle('yes')
  assert.equal(r.calls.stop, 1)
  assert.deepEqual(result, { reply: 'Saved 3 lines. The transcript is complete and verified.', tone: 'ok' })
})

test('an ending the backend could not verify is reported as not verified, never as saved', async () => {
  const r = rig({ phase: 'live', open: true })
  const message = 'Ended with 3 lines saved, but NOT verified: 1 recording never confirmed how many lines it produced.'
  r.meeting.onStop = () => r.set({ phase: 'done', open: false, tone: 'warn', message })
  await r.router.handle('stop the meeting')
  const result = await r.router.handle('yes')
  assert.equal(result.reply, message)
  assert.equal(result.tone, 'warn')
})

test('if the backend refuses to end the meeting the reply is its refusal, not a success', async () => {
  const r = rig({ phase: 'live', open: true })
  const message = 'The transcript is incomplete: 2 lines are not saved yet. Press Try again in a moment.'
  r.meeting.onStop = () => r.set({ phase: 'problem', open: true, tone: 'error', message })
  await r.router.handle('stop the meeting')
  const result = await r.router.handle('yes')
  assert.deepEqual(result, { reply: message, tone: 'error' })
  assert.doesNotMatch(result.reply, /^Saved/)
})

test('if stopping did not take effect, the reply says it is not confirmed and never claims a save', async () => {
  const r = rig({ phase: 'live', open: true })
  await r.router.handle('stop the meeting')
  const result = await r.router.handle('yes') // stop() does nothing; the meeting is still live
  assert.match(result.reply, /not confirmed/i)
  assert.doesNotMatch(result.reply, /saved|verified|complete/i)
  assert.equal(result.tone, 'warn')
})

test('"no" keeps the meeting recording', async () => {
  const r = rig({ phase: 'live', open: true })
  await r.router.handle('stop the meeting')
  const result = await r.router.handle('no')
  assert.match(result.reply, /keeps recording/i)
  assert.equal(r.calls.stop, 0)
})

test('anything else cancels the question, and a later "yes" is just a normal message', async () => {
  const r = rig({ phase: 'live', open: true })
  await r.router.handle('stop the meeting')
  assert.equal(await r.router.handle('what time is it'), null)
  assert.equal(await r.router.handle('yes'), null)
  assert.equal(r.calls.stop, 0)
})

test('the confirmation expires', async () => {
  const r = rig({ phase: 'live', open: true })
  await r.router.handle('stop the meeting')
  r.advance(61_000)
  assert.equal(await r.router.handle('yes'), null)
  assert.equal(r.calls.stop, 0)
})

test('a lone "yes" with nothing pending is an ordinary message', async () => {
  const r = rig({ phase: 'live', open: true })
  assert.equal(await r.router.handle('yes'), null)
  assert.equal(await r.router.handle('no'), null)
})

test('if the meeting stopped on its own before the answer, "yes" does not stop anything', async () => {
  const r = rig({ phase: 'live', open: true })
  await r.router.handle('stop the meeting')
  r.set({ phase: 'done', open: false })
  const result = await r.router.handle('yes')
  assert.match(result.reply, /no longer recording/i)
  assert.equal(r.calls.stop, 0)
})

test('stop with no meeting open says so and does nothing', async () => {
  const r = rig()
  const result = await r.router.handle('stop the meeting')
  assert.match(result.reply, /No meeting is recording/)
  assert.equal(r.calls.stop, 0)
  assert.deepEqual(r.calls.panels, [])
})

test('stop for a meeting that is open but not recording opens the panel so it can be finished', async () => {
  const r = rig({ phase: 'problem', open: true })
  const result = await r.router.handle('stop the meeting')
  assert.equal(r.calls.panels.length, 1)
  assert.match(result.reply, /not recording/i)
})

test('"stop recording" only counts while a meeting is recording', async () => {
  const idle = rig()
  assert.equal(await idle.router.handle('stop recording'), null, 'sent to the assistant instead')
  const live = rig({ phase: 'live', open: true })
  const result = await live.router.handle('stop recording')
  assert.match(result.reply, /Stop and save the meeting\?/)
})

test('text that is not a command is left alone', async () => {
  const r = rig({ phase: 'live', open: true })
  assert.equal(await r.router.handle('how do I start a meeting with a customer'), null)
  assert.deepEqual(r.calls.panels, [])
})

test('a failure while stopping is not swallowed (the caller reports it)', async () => {
  const r = rig({ phase: 'live', open: true })
  r.meeting.onStop = () => {
    throw new Error('boom')
  }
  await r.router.handle('stop the meeting')
  await assert.rejects(() => r.router.handle('yes'), /boom/)
})

// ---- starting by voice or text when this browser is already unlocked ------------------------------------------

test('when this browser is unlocked, "start a meeting" starts it, with no code and no promise it is recording', async () => {
  const r = rig({ launchReady: true })
  r.meeting.onStart = () => r.set({ phase: 'connecting', open: true, message: 'Connecting. Allow the microphone if the browser asks.' })
  const result = await r.router.handle('start a meeting')
  assert.deepEqual(r.calls.starts, [{ title: undefined }])
  assert.equal(r.calls.panels.length, 1, 'the panel opens so the status is visible')
  assert.match(result.reply, /Starting the meeting/)
  assert.doesNotMatch(result.reply, /launch code/i)
  assert.doesNotMatch(result.reply, /is recording|recording now|started|saved|verified/i)
})

test('the title said with the command reaches the meeting', async () => {
  const r = rig({ launchReady: true })
  r.meeting.onStart = () => r.set({ phase: 'connecting', open: true })
  await r.router.handle('start a meeting called Weekly sync')
  assert.deepEqual(r.calls.starts, [{ title: 'Weekly sync' }])
})

test('when starting failed the reply is the controller\'s own explanation, as an error', async () => {
  const r = rig({ launchReady: true })
  r.meeting.onStart = () =>
    r.set({ phase: 'idle', open: false, tone: 'error', message: 'Could not reach the server. Check the connection and try again.' })
  const result = await r.router.handle('start the meeting')
  assert.deepEqual(result, { reply: 'Could not reach the server. Check the connection and try again.', tone: 'error' })
})

test('a microphone problem after launch is reported as the problem it is', async () => {
  const r = rig({ launchReady: true })
  r.meeting.onStart = () =>
    r.set({ phase: 'problem', open: true, tone: 'error', message: 'The microphone is blocked. Allow it in the browser, then press Reconnect.' })
  const result = await r.router.handle('start the meeting')
  assert.equal(result.tone, 'error')
  assert.match(result.reply, /microphone is blocked/)
})

test('a lapsed launch session sends the user to the code field instead of pretending', async () => {
  const r = rig({ launchReady: true })
  r.meeting.onStart = () =>
    r.set({ phase: 'idle', open: false, launchReady: false, tone: 'warn', message: 'The launch session has ended. Enter the launch code to start the meeting.' })
  const result = await r.router.handle('start the meeting')
  assert.match(result.reply, /launch session has ended/)
  assert.equal(result.tone, 'warn')
  assert.equal(r.calls.panels.length, 1)
})

test('saying it twice does not start two meetings', async () => {
  const r = rig({ launchReady: true })
  r.meeting.onStart = () => r.set({ phase: 'launching', open: false })
  await r.router.handle('start a meeting')
  const second = await r.router.handle('start a meeting')
  assert.equal(r.calls.starts.length, 1, 'the second phrase found the first still starting')
  assert.match(second.reply, /already starting/i)
})

test('an unfinished meeting is never replaced by a new start, even when unlocked', async () => {
  const r = rig({ launchReady: true, phase: 'unfinished', open: true })
  const result = await r.router.handle('start a meeting')
  assert.deepEqual(r.calls.starts, [])
  assert.match(result.reply, /not finished/i)
})

test('a recording meeting is not started again, even when unlocked', async () => {
  const r = rig({ launchReady: true, phase: 'live', open: true })
  await r.router.handle('start a meeting')
  assert.deepEqual(r.calls.starts, [])
})

test('a controller that throws from start is reported, not swallowed into a success', async () => {
  const r = rig({ launchReady: true })
  r.meeting.onStart = () => {
    throw new Error('boom')
  }
  const result = await r.router.handle('start a meeting')
  assert.equal(result.tone, 'error')
  assert.doesNotMatch(result.reply, /Starting the meeting/)
})

test('without a launch session the command still only opens the panel and asks for the code', async () => {
  const r = rig({ launchReady: false })
  const result = await r.router.handle('start a meeting')
  assert.deepEqual(r.calls.starts, [])
  assert.match(result.reply, /launch code/i)
})
