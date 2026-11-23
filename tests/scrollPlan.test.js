import assert from 'node:assert/strict'
import test from 'node:test'
import { FIT_TIERS, pickFit, planCenter } from '../src/interfaces/chat/scrollPlan.js'

test('a message that fits goes to the middle of the view', () => {
  // content 2000 tall, view 600, the message is 200 tall and starts at 900: its middle (1000) goes to the view's middle (300 down)
  assert.deepEqual(planCenter({ itemTop: 900, itemHeight: 200, view: 600, scrollHeight: 2000 }), { scrollTop: 700, extra: 0, tall: false })
})

test('the newest message has nothing below it, so room is made to bring it to the middle', () => {
  // the message ends the content (starts at 1700 of 2000): it can only reach 1400 (2000 - 600) unless 300px of room is added
  const plan = planCenter({ itemTop: 1700, itemHeight: 300, view: 600, scrollHeight: 2000 })
  assert.equal(plan.scrollTop, 1550) // 1700 - (600 - 300) / 2
  assert.equal(plan.extra, 150) // 1550 - (2000 - 600) = 150
  assert.equal(plan.tall, false)
})

test('a message taller than the view is put at the top, with a margin, to be read from its first line', () => {
  const plan = planCenter({ itemTop: 1000, itemHeight: 900, view: 600, scrollHeight: 2000 })
  assert.deepEqual(plan, { scrollTop: 984, extra: 0, tall: true })
  assert.equal(planCenter({ itemTop: 1000, itemHeight: 900, view: 600, scrollHeight: 2000, margin: 40 }).scrollTop, 960)
})

test('a tall newest message that ends the content still needs no room: its top can be reached', () => {
  // starts at 1100, 900 tall, content 2000, view 600: max scroll is 1400 and the top (1100 - 16) is below that
  assert.deepEqual(planCenter({ itemTop: 1100, itemHeight: 900, view: 600, scrollHeight: 2000 }), { scrollTop: 1084, extra: 0, tall: true })
})

test('near the top of the thread it cannot go above the start', () => {
  assert.deepEqual(planCenter({ itemTop: 40, itemHeight: 100, view: 600, scrollHeight: 2000 }), { scrollTop: 0, extra: 0, tall: false })
})

test('a message exactly as tall as the view minus its margins counts as fitting', () => {
  assert.equal(planCenter({ itemTop: 500, itemHeight: 568, view: 600, scrollHeight: 3000 }).tall, false)
  assert.equal(planCenter({ itemTop: 500, itemHeight: 569, view: 600, scrollHeight: 3000 }).tall, true)
})

test('a long answer is made wider first, then smaller, and no more than it needs', () => {
  const heights = { '': 900, wide: 700, compact: 560, dense: 480 }
  const tried = []
  const measure = (tier) => (tried.push(tier), heights[tier])
  assert.equal(pickFit(measure, 600), 'compact')
  assert.deepEqual(tried, ['', 'wide', 'compact'], 'it stops at the first that fits; it never goes smaller than it must')
  assert.equal(pickFit((tier) => heights[tier], 950), '', 'an answer that already fits is left as it is')
  assert.equal(pickFit((tier) => heights[tier], 700), 'wide', 'widening alone can be enough')
})

test('an answer that fits in no tier ends in the smallest, to be read from its top', () => {
  assert.equal(pickFit(() => 5000, 600), FIT_TIERS.at(-1))
  assert.deepEqual(FIT_TIERS, ['', 'wide', 'compact', 'dense'])
})
