import assert from 'node:assert/strict'
import test from 'node:test'
import { createContentLedger } from './contentLedger.js'

const P = {
  intro: 'Relational databases store data in tables made of rows and columns, and every row is identified by a primary key that never repeats.',
  keys: 'A foreign key is a column in one table that refers to the primary key of another table, which is how related rows are linked together.',
  norm: 'Normalisation is the process of organising tables so that each fact is stored once, which removes update anomalies and wasted space.',
  joins: 'A join combines rows from two tables whenever the values in the columns being compared are equal, producing one wider row for each match.',
  index: 'An index is a separate structure that lets the database find rows by the value of a column without reading every row of the table.',
  acid: 'Transactions are atomic, consistent, isolated and durable, so a failure half way through never leaves the data in a broken state.',
  newton: 'The rate of change of velocity with time is called acceleration, and it is measured in metres per second squared in the metric system.'
}
const seg = (text, over = {}) => ({ kind: 'paragraph', title: '', text, ...over })
const q = (text, over = {}) => ({ kind: 'question', title: '', text, options: [], marks: null, type: 'descriptive', hasDiagram: false, ...over })
const ledger = () => {
  let n = 0
  return createContentLedger({ now: () => 1_000 + n, newId: () => `seg-${++n}` })
}
const statuses = (r) => r.segments.map((s) => s.status)

test('one segment: new the first time, seen when it is on the screen again', () => {
  const l = ledger()
  const first = l.integrate('c1', [seg(P.intro)])
  assert.deepEqual([first.layout, first.arrival, statuses(first), first.summary.new], ['single', 'new-screen', ['new'], 1])
  const again = l.integrate('c2', [seg(P.intro)])
  assert.deepEqual([again.arrival, statuses(again)], ['same', ['seen']], 'the same content is not new content')
  assert.equal(again.segments[0].id, first.segments[0].id)
  assert.equal(again.segments[0].seenCount, 2)
})

test('several segments on one screen are told apart, and only the one that changed is new', () => {
  const l = ledger()
  const first = l.integrate('c1', [seg(P.intro, { title: 'Tables' }), seg(P.keys, { title: 'Keys' }), seg(P.norm, { title: 'Normal forms' })])
  assert.deepEqual([first.layout, first.summary.total, first.summary.new], ['multiple', 3, 3])
  assert.equal(new Set(first.segments.map((s) => s.id)).size, 3, 'three different segments')
  const second = l.integrate('c2', [seg(P.intro, { title: 'Tables' }), seg(P.joins, { title: 'Joins' }), seg(P.norm, { title: 'Normal forms' })])
  assert.deepEqual(statuses(second), ['seen', 'new', 'seen'])
  assert.equal(second.arrival, 'overlapping')
  assert.equal(l.size(), 4)
})

test('segments that swap places on the screen are still the same segments', () => {
  const l = ledger()
  const first = l.integrate('c1', [seg(P.intro), seg(P.keys)])
  const swapped = l.integrate('c2', [seg(P.keys), seg(P.intro)])
  assert.deepEqual(statuses(swapped), ['seen', 'seen'])
  assert.deepEqual(swapped.segments.map((s) => s.id), [first.segments[1].id, first.segments[0].id])
  assert.equal(swapped.arrival, 'same')
})

test('horizontal navigation: next shows new content, previous brings back what was seen without anything new', () => {
  const l = ledger()
  const slideA = [seg(P.intro, { title: 'Slide 1' })]
  const slideB = [seg(P.keys, { title: 'Slide 2' }), seg(P.norm, { title: 'Slide 2b' })]
  const slideC = [q('Explain why a foreign key must refer to an existing primary key value in the other table.', { title: 'Slide 3' })]
  assert.equal(l.integrate('c1', slideA).arrival, 'new-screen')
  assert.equal(l.integrate('c2', slideB).arrival, 'new-screen')
  assert.equal(l.integrate('c3', slideC).arrival, 'new-screen')
  const back = l.integrate('c4', slideB)
  assert.deepEqual([back.arrival, statuses(back), back.summary.new], ['revisit', ['seen', 'seen'], 0], 'previous: nothing is processed again')
  const backAgain = l.integrate('c5', slideA)
  assert.deepEqual([backAgain.arrival, statuses(backAgain)], ['revisit', ['seen']])
  const forward = l.integrate('c6', slideB)
  assert.equal(forward.arrival, 'revisit')
  assert.equal(l.size(), 4, 'six screens, four segments')
})

test('tabs are no different: the content of each is held once however often the person switches', () => {
  const l = ledger()
  const tabs = { overview: [seg(P.intro), seg(P.keys)], exercises: [q('Define a primary key and say why it cannot be null in a relational table.')], notes: [seg(P.acid)] }
  const order = ['overview', 'exercises', 'notes', 'overview', 'notes', 'exercises', 'overview']
  const results = order.map((tab, i) => l.integrate(`c${i}`, tabs[tab]))
  assert.deepEqual(results.map((r) => r.summary.new), [2, 1, 1, 0, 0, 0, 0])
  assert.equal(l.size(), 4)
})

test('vertical scrolling: screens overlap, the overlap is not new, and what appears is', () => {
  const l = ledger()
  const first = l.integrate('c1', [seg(P.intro), seg(P.keys), seg(P.norm)])
  const scrolled = l.integrate('c2', [seg(P.keys), seg(P.norm), seg(P.joins), seg(P.index)])
  assert.deepEqual(statuses(scrolled), ['seen', 'seen', 'new', 'new'])
  assert.equal(scrolled.arrival, 'overlapping')
  assert.deepEqual(scrolled.segments.slice(0, 2).map((s) => s.id), first.segments.slice(1, 3).map((s) => s.id))
  const further = l.integrate('c3', [seg(P.joins), seg(P.index), seg(P.acid)])
  assert.deepEqual(statuses(further), ['seen', 'seen', 'new'])
  const up = l.integrate('c4', [seg(P.intro), seg(P.keys)])
  assert.deepEqual(statuses(up), ['seen', 'seen'], 'scrolling back up shows only what was seen')
  assert.equal(up.arrival, 'revisit')
})

test('a segment cut off at the bottom and whole on the next screen is one segment that grew, not two', () => {
  const l = ledger()
  const words = P.norm.split(' ')
  const cut = words.slice(0, 12).join(' ')
  const first = l.integrate('c1', [seg(P.intro), seg(cut, { cutOff: 'bottom' })])
  assert.equal(first.segments[1].partial.bottom, true)
  const second = l.integrate('c2', [seg(P.norm), seg(P.joins)])
  const whole = second.segments[0]
  assert.equal(whole.status, 'grew')
  assert.equal(whole.id, first.segments[1].id, 'the same segment')
  assert.equal(whole.completed, true, 'it was cut off and now it is whole')
  assert.equal(whole.partial, null)
  assert.equal(whole.text, P.norm)
  assert.equal(whole.added.words, words.length - 12)
  assert.equal(second.segments[1].status, 'new')
  assert.equal(l.size(), 3)
})

test('content continuing across screens: the cut end of one is the beginning of the next and they become one segment without repeats', () => {
  const l = ledger()
  const words = P.newton.split(' ')
  const topPart = words.slice(0, 16).join(' ') // the first screen ends here
  const nextPart = words.slice(11).join(' ') // the next screen begins five words earlier and shows the rest
  const first = l.integrate('c1', [seg(topPart, { cutOff: 'bottom', title: 'Acceleration' })])
  const second = l.integrate('c2', [seg(nextPart, { cutOff: 'top' })])
  const joined = second.segments[0]
  assert.deepEqual([joined.status, joined.id], ['continued', first.segments[0].id])
  assert.equal(joined.text, P.newton, 'joined once, the shared words not repeated')
  assert.equal(joined.partial, null, 'and whole')
  assert.equal(l.size(), 1)
  assert.equal(joined.completed, true)
})

test('scrolling up reaches the start of a segment that was only seen from its middle', () => {
  const l = ledger()
  const words = P.acid.split(' ')
  const lower = l.integrate('c1', [seg(words.slice(8).join(' '), { cutOff: 'top' })])
  const upper = l.integrate('c2', [seg(words.slice(0, 14).join(' '), { cutOff: 'bottom' })])
  assert.equal(upper.segments[0].status, 'continued')
  assert.equal(upper.segments[0].id, lower.segments[0].id)
  assert.equal(upper.segments[0].text, P.acid)
  assert.equal(upper.segments[0].partial, null)
})

test('a continuation with no words in common is linked to what it continues, not merged and not lost', () => {
  const l = ledger()
  const first = l.integrate('c1', [seg(P.intro), seg('The next step in the procedure is to measure the temperature of the solution and write the reading down', { cutOff: 'bottom', group: 'Procedure' })])
  const second = l.integrate('c2', [seg('Heat the sample slowly until it reaches the boiling point and then record the time that this took', { cutOff: 'top', group: 'Procedure' })])
  const next = second.segments[0]
  assert.equal(next.status, 'new', 'it is new content')
  assert.equal(next.continuesFrom, first.segments[1].id)
  assert.deepEqual(next.related.includes(first.segments[1].id), true)
})

test('a part of a known segment (only a piece of it visible now) is seen, not new', () => {
  const l = ledger()
  l.integrate('c1', [seg(P.keys)])
  const piece = P.keys.split(' ').slice(4, 20).join(' ')
  const view = l.integrate('c2', [seg(piece, { cutOff: 'both' })])
  assert.deepEqual([statuses(view), l.size()], [['seen'], 1])
})

test('genuinely new content is never dropped because it resembles or overlaps earlier content', () => {
  const l = ledger()
  l.integrate('c1', [seg(P.keys), q('Calculate the total cost of 12 items at 4 pounds each.')])
  // another paragraph that shares many words, a question with different numbers, a short phrase that happens to occur earlier
  const result = l.integrate('c2', [
    seg('A foreign key is a column in a table that stores the name of the customer who placed the order, which is how the table is linked.'),
    q('Calculate the total cost of 13 items at 4 pounds each.'),
    seg('a column in one table')
  ])
  assert.deepEqual(statuses(result), ['new', 'new', 'new'], 'resemblance is not identity')
  assert.equal(l.size(), 5)
})

test('the same question with a misread letter is the same question; with a different number it is another', () => {
  const l = ledger()
  const first = l.integrate('c1', [q('Calculate the average speed of a car that travels 150 km in 2.5 hours.', { options: [{ label: 'A', text: '40 km/h' }, { label: 'B', text: '60 km/h' }] })])
  const misread = l.integrate('c2', [q('Calcuiate the average speed of a car that travels 150 km in 2.5 hours.', { options: [{ label: 'A', text: '40 km/h' }, { label: 'B', text: '60 km/h' }] })])
  assert.deepEqual([statuses(misread), misread.segments[0].id], [['seen'], first.segments[0].id])
  const other = l.integrate('c3', [q('Calculate the average speed of a car that travels 160 km in 2.5 hours.', { options: [{ label: 'A', text: '40 km/h' }, { label: 'B', text: '60 km/h' }] })])
  assert.deepEqual(statuses(other), ['new'])
})

test('a question cut off by the screen is held, and is whole when the rest appears', () => {
  const l = ledger()
  const full = 'Explain why the primary key of a table must be unique and cannot be empty, and give an example of a suitable key for a table of students.'
  const part = full.split(' ').slice(0, 14).join(' ')
  const first = l.integrate('c1', [q(part, { cutOff: 'bottom' })])
  assert.equal(first.segments[0].partial.bottom, true)
  const second = l.integrate('c2', [q(full)])
  assert.deepEqual([second.segments[0].status, second.segments[0].completed, second.segments[0].id], ['grew', true, first.segments[0].id])
  assert.equal(second.segments[0].partial, null)
})

test('related content: segments of one group, and a segment that names another, are linked for the answer to read', () => {
  const l = ledger()
  const result = l.integrate('c1', [
    seg(P.acid, { title: 'Case study', group: 'Case study 1', kind: 'paragraph' }),
    q('Which property of a transaction is broken when a failure leaves the data half changed?', { group: 'Case study 1', dependsOn: 'Case study' }),
    q('Explain how durability is achieved when the power fails during a write operation.', { group: 'Case study 1' })
  ])
  const [passage, first, second] = result.segments
  assert.deepEqual(first.related.sort(), [passage.id, second.id].sort())
  const context = l.relatedTo(first.id)
  assert.deepEqual(context.map((c) => [c.title, c.kind]), [['Case study', 'paragraph']], 'the passage, not the other question')
  assert.match(context[0].text, /atomic, consistent, isolated and durable/)
})

test('a repeated screen is reported as the same, and one that returns later as a revisit', () => {
  const l = ledger()
  const a = [seg(P.intro)]
  const b = [seg(P.keys)]
  l.integrate('c1', a)
  assert.equal(l.integrate('c2', a).arrival, 'same')
  l.integrate('c3', b)
  assert.equal(l.integrate('c4', a).arrival, 'revisit')
})

test('nothing readable is an empty screen, and the ledger never grows without bound', () => {
  const l = createContentLedger({ limits: { maxSegments: 5 } })
  assert.deepEqual([l.integrate('c0', []).arrival, l.integrate('c0b', [seg('   ')]).segments.length], ['empty', 0])
  for (let i = 0; i < 12; i++) l.integrate(`c${i}`, [seg(`Paragraph number ${i} talks about completely different subject matter number ${i * 7 + 3} in its own words alpha${i} beta${i} gamma${i}`)])
  assert.equal(l.size(), 5)
})
