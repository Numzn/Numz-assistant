import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * The AudioWorklet that turns the browser's 128-sample audio blocks into 100 ms frames for the speech service
 * (public/worklets/pcm-capture-processor.js). It is loaded here with a stand-in for the worklet scope, so the
 * real file's frame cutting and level measuring run.
 *
 * Two promises:
 *   - the audio it posts is exactly what it always was, whether or not levels are asked for;
 *   - with levels asked for, each frame carries how loud the microphone input and the tab input were over
 *     exactly the samples of that frame (frames and 128-sample blocks do not line up: 1600 = 12.5 blocks).
 */

const SOURCE = readFileSync(new URL('../public/worklets/pcm-capture-processor.js', import.meta.url), 'utf8')
const BLOCK = 128
const FRAME = 1600

function load() {
  let registered = null
  class AudioWorkletProcessor {
    constructor() {
      this.port = { posted: [], postMessage: (message) => this.port.posted.push(message) }
    }
  }
  vm.runInNewContext(SOURCE, {
    AudioWorkletProcessor,
    registerProcessor: (name, processor) => (registered = { name, processor }),
    Float32Array
  })
  return registered
}

function makeProcessor(processorOptions) {
  const { processor } = load()
  return new processor({ processorOptions })
}

const block = (fill) => Float32Array.from({ length: BLOCK }, (_, i) => (typeof fill === 'function' ? fill(i) : fill))

/** The audio of the mixed input: a ramp that never repeats, so any mis-cut shows. */
function ramp(blockIndex) {
  return block((i) => (blockIndex * BLOCK + i) / 100000)
}

test('it registers as pcm-capture-processor', () => {
  assert.equal(load().name, 'pcm-capture-processor')
})

test('without levels it posts the bare audio of each 1600-sample frame, as it always did', () => {
  const processor = makeProcessor({ frameSamples: FRAME })
  for (let b = 0; b < 26; b++) assert.equal(processor.process([[ramp(b)]]), true)
  const posted = processor.port.posted
  assert.equal(posted.length, 2, '26 blocks of 128 = 3328 samples = two whole frames, the rest still buffered')
  for (const [index, frame] of posted.entries()) {
    assert.ok(frame instanceof ArrayBuffer, 'a bare ArrayBuffer, not an object')
    const samples = new Float32Array(frame)
    assert.equal(samples.length, FRAME)
    for (let i = 0; i < FRAME; i++) assert.equal(samples[i], Math.fround((index * FRAME + i) / 100000))
  }
})

test('with levels asked for, the posted audio is byte-for-byte what it is without', () => {
  const plain = makeProcessor({ frameSamples: FRAME })
  const measuring = makeProcessor({ frameSamples: FRAME, reportLevels: true })
  for (let b = 0; b < 40; b++) {
    plain.process([[ramp(b)]])
    measuring.process([[ramp(b)], [block(0.3)], [block(0.05)]])
  }
  assert.equal(measuring.port.posted.length, plain.port.posted.length)
  for (const [index, message] of measuring.port.posted.entries()) {
    assert.deepEqual(Object.keys(message).sort(), ['frame', 'mic', 'tab'])
    assert.deepEqual(Buffer.from(message.frame), Buffer.from(plain.port.posted[index]))
  }
})

test('each frame carries the RMS of the microphone input and of the tab input over its own samples', () => {
  const processor = makeProcessor({ frameSamples: FRAME, reportLevels: true })
  for (let b = 0; b < 26; b++) processor.process([[ramp(b)], [block(0.3)], [block(-0.05)]])
  const [first, second] = processor.port.posted
  for (const message of [first, second]) {
    assert.ok(Math.abs(message.mic - 0.3) < 1e-6, `mic ${message.mic}`)
    assert.ok(Math.abs(message.tab - 0.05) < 1e-6, `tab ${message.tab}`)
  }
})

test('a level change in the middle of a block lands in the right frame', () => {
  // Sample 1600 is the 64th sample of block 12 (12 * 128 = 1536): the first half of that block belongs to frame
  // one and the second half to frame two. The microphone is silent until sample 1600, then 0.4.
  const processor = makeProcessor({ frameSamples: FRAME, reportLevels: true })
  for (let b = 0; b < 26; b++) {
    const mic = block((i) => (b * BLOCK + i < FRAME ? 0 : 0.4))
    processor.process([[ramp(b)], [mic], [block(0)]])
  }
  const [first, second] = processor.port.posted
  assert.equal(first.mic, 0)
  assert.ok(Math.abs(second.mic - 0.4) < 1e-6)
  assert.equal(first.tab, 0)
  assert.equal(second.tab, 0)
})

test('the RMS is a root mean square, not an average', () => {
  const processor = makeProcessor({ frameSamples: FRAME, reportLevels: true })
  for (let b = 0; b < 13; b++) {
    processor.process([[ramp(b)], [block((i) => (i % 2 === 0 ? 0.6 : 0))], [block(0)]]) // half the samples 0.6, half 0
  }
  assert.ok(Math.abs(processor.port.posted[0].mic - Math.sqrt(0.6 * 0.6 * 0.5)) < 1e-6)
})

test('an input with nothing connected is null, not zero', () => {
  const processor = makeProcessor({ frameSamples: FRAME, reportLevels: true })
  for (let b = 0; b < 13; b++) processor.process([[ramp(b)], [], [block(0.1)]])
  const [message] = processor.port.posted
  assert.equal(message.mic, null)
  assert.ok(Math.abs(message.tab - 0.1) < 1e-6)

  const none = makeProcessor({ frameSamples: FRAME, reportLevels: true })
  for (let b = 0; b < 13; b++) none.process([[ramp(b)]])
  assert.deepEqual([none.port.posted[0].mic, none.port.posted[0].tab], [null, null])
})

test('levels do not leak from one frame into the next', () => {
  // 256-sample frames are exactly two blocks, so a frame boundary is a block boundary.
  const processor = makeProcessor({ frameSamples: 2 * BLOCK, reportLevels: true })
  for (let b = 0; b < 2; b++) processor.process([[ramp(b)], [block(0.5)], [block(0.5)]])
  for (let b = 2; b < 4; b++) processor.process([[ramp(b)], [], [block(0.1)]]) // the microphone disappears
  const [first, second] = processor.port.posted
  assert.ok(Math.abs(first.mic - 0.5) < 1e-6)
  assert.ok(Math.abs(first.tab - 0.5) < 1e-6)
  assert.equal(second.mic, null, 'frame two saw no microphone samples at all')
  assert.ok(Math.abs(second.tab - 0.1) < 1e-6, 'and none of frame one\'s 0.5 is left in its tab level')
})

test('a frame that starts in the middle of a block averages only the samples that belong to it', () => {
  const processor = makeProcessor({ frameSamples: FRAME, reportLevels: true })
  for (let b = 0; b < 13; b++) processor.process([[ramp(b)], [block(0.5)], [block(0)]])
  for (let b = 13; b < 25; b++) processor.process([[ramp(b)], [], [block(0.1)]])
  const second = processor.port.posted[1]
  assert.ok(Math.abs(second.mic - 0.5) < 1e-6, 'its microphone level is the 64 samples it had, not diluted by the 1536 it had none for')
  assert.ok(Math.abs(second.tab - Math.sqrt((64 * 0 + 1536 * 0.01) / 1600)) < 1e-6)
})

test('with no audio on the mixed input it posts nothing and keeps running', () => {
  const processor = makeProcessor({ frameSamples: FRAME, reportLevels: true })
  assert.equal(processor.process([[], [block(0.3)], [block(0.3)]]), true)
  assert.equal(processor.process([]), true)
  assert.equal(processor.port.posted.length, 0)
})

test('frameSamples is respected and defaults to 100 ms at 16 kHz', () => {
  const defaults = makeProcessor(undefined)
  for (let b = 0; b < 13; b++) defaults.process([[ramp(b)]])
  assert.equal(new Float32Array(defaults.port.posted[0]).length, 1600)

  const small = makeProcessor({ frameSamples: 256, reportLevels: true })
  for (let b = 0; b < 4; b++) small.process([[ramp(b)], [block(0.2)], [block(0.2)]])
  assert.equal(small.port.posted.length, 2)
  assert.equal(new Float32Array(small.port.posted[0].frame).length, 256)
})
