import assert from 'node:assert/strict'
import test from 'node:test'
import { formatSegmentLine, formatTimestamp, notesResult, parseModelJson, stripCodeFences } from '../server/utils/prompt.js'

/** The helpers the note generators share (server/utils/prompt.js). The generators' own behaviour is in notesGeneration.test.js. */

test('formatTimestamp counts minutes past 59 and treats anything unreadable as zero', () => {
  assert.deepEqual(
    [0, 1, 59, 60, 61.9, 3599, 5400, '75', -5, NaN, undefined, null, 'x'].map(formatTimestamp),
    ['00:00', '00:01', '00:59', '01:00', '01:01', '59:59', '90:00', '01:15', '00:00', '00:00', '00:00', '00:00', '00:00']
  )
})

test('formatSegmentLine is [id | start-end | speaker] text, with "unknown" when no one is labelled', () => {
  assert.equal(
    formatSegmentLine({ id: 'seg_0041', start: 2521.4, end: 2594, speaker: 'speaker_00', text: 'Hello.' }),
    '[seg_0041 | 42:01-43:14 | speaker_00] Hello.'
  )
  for (const speaker of [null, undefined]) {
    assert.equal(formatSegmentLine({ id: 's', start: 0, end: 1, speaker, text: 't' }), '[s | 00:00-00:01 | unknown] t')
  }
  assert.equal(formatSegmentLine({ id: 's', start: 0, end: 1, text: 'two\nlines' }), '[s | 00:00-00:01 | unknown] two\nlines', 'the text is not touched')
})

test('stripCodeFences unwraps one fenced block, with or without a json tag, in any case, and otherwise only trims', () => {
  for (const [input, expected] of [
    ['```json\n{"a":1}\n```', '{"a":1}'],
    ['```JSON\n{"a":1}\n```', '{"a":1}'],
    ['```\n{"a":1}\n```', '{"a":1}'],
    ['```{"a":1}```', '{"a":1}'],
    ['  \n```json\r\n{"a":1}\r\n```\n  ', '{"a":1}'],
    ['```json\n\n\n{"a":1}\n\n```', '{"a":1}'],
    ['{"a":1}', '{"a":1}'],
    ['  {"a":1}  ', '{"a":1}'],
    ['', ''],
    ['   ', '']
  ]) {
    assert.equal(stripCodeFences(input), expected, JSON.stringify(input))
  }
})

test('stripCodeFences leaves anything that is not one block from start to end alone', () => {
  const prose = 'Here you go:\n```json\n{"a":1}\n```'
  assert.equal(stripCodeFences(prose), prose, 'text before the fence')
  const after = '```json\n{"a":1}\n```\nHope that helps.'
  assert.equal(stripCodeFences(after), after, 'text after the fence')
  assert.equal(stripCodeFences('```json\n{"a":1}'), '```json\n{"a":1}', 'no closing fence')
  assert.equal(stripCodeFences('```json\n{"a":1}\n```\n```json\n{"b":2}\n```'), '{"a":1}\n```\n```json\n{"b":2}', 'two blocks are not unwrapped one by one')
})

test('parseModelJson returns the value for any JSON document, fenced or not', () => {
  for (const [input, value] of [
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['[1,2]', [1, 2]],
    ['"text"', 'text'],
    ['42', 42],
    ['0', 0],
    ['false', false],
    ['null', null]
  ]) {
    assert.deepEqual(parseModelJson(input), { ok: true, value }, input)
  }
})

test('parseModelJson reports bad JSON with the parser\'s own message instead of throwing', () => {
  for (const input of ['', '   ', 'sorry', '{"a":', '{"a":1} extra', '```json\nnot json\n```', "{'a':1}"]) {
    let expected
    try {
      JSON.parse(stripCodeFences(input))
    } catch (err) {
      expected = err.message
    }
    assert.deepEqual(parseModelJson(input), { ok: false, error: expected }, JSON.stringify(input))
    assert.equal(typeof expected, 'string')
  }
})

test('parseModelJson wants text: anything else is a TypeError for the caller to decide about, not a parse failure', () => {
  for (const notText of [undefined, null, 42, {}, ['{}']]) assert.throws(() => parseModelJson(notText), TypeError, String(notText))
})

test('parseModelJson with coerce reads a missing or non-text reply as text and cannot throw', () => {
  const emptyReading = parseModelJson('')
  for (const reply of [undefined, null]) assert.deepEqual(parseModelJson(reply, { coerce: true }), emptyReading, String(reply))
  assert.deepEqual(parseModelJson(42, { coerce: true }), { ok: true, value: 42 }, 'the text "42" is JSON')
  assert.deepEqual(parseModelJson({ toString: () => '{"a":1}' }, { coerce: true }), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseModelJson({}, { coerce: true }), { ok: false, error: parseModelJson('[object Object]').error })
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```', { coerce: true }), { ok: true, value: { a: 1 } })
  // Even a reply that cannot be turned into text is a result, not an exception.
  assert.deepEqual(parseModelJson({ toString() { throw new Error('boom') } }, { coerce: true }), { ok: false, error: 'boom' })
  assert.throws(() => parseModelJson({ toString() { throw new Error('boom') } }), TypeError, 'without coerce the reply is not touched')
})

test('notesResult is { schemaVersion, notes } for a read reply, and carries the raw reply and the error for one that failed', () => {
  assert.deepEqual(notesResult('1.0', '{"a":1}', { ok: true, value: { a: 1 } }), { schemaVersion: '1.0', notes: { a: 1 } })
  assert.deepEqual(Object.keys(notesResult('1.0', 'x', { ok: true, value: null })), ['schemaVersion', 'notes'], 'JSON null is "no notes", not a failure')
  assert.deepEqual(
    notesResult('1.0', '```json\nbad\n```', { ok: false, error: 'Unexpected token' }),
    { schemaVersion: '1.0', notes: null, raw: '```json\nbad\n```', parseError: 'Unexpected token' }
  )
  assert.deepEqual(Object.keys(notesResult('2.1', undefined, { ok: false, error: 'e' })), ['schemaVersion', 'notes', 'raw', 'parseError'])
  assert.equal(notesResult('2.1', undefined, { ok: false, error: 'e' }).schemaVersion, '2.1')
})
