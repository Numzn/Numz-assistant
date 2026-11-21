import assert from 'node:assert/strict'
import test from 'node:test'
import { lineElement, speakerTag } from '../src/interfaces/meeting/meetingPanel.js'

/**
 * One transcript line in the meeting panel: when it was said, who said it (when that is known), the words, and
 * whether the server saved it. The words are only ever put in as a text node, never as HTML.
 */

class FakeNode {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.dataset = {}
    this.className = ''
    this.title = ''
    this._text = ''
  }
  set textContent(value) {
    this._text = String(value)
    this.children = []
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('')
  }
  append(...nodes) {
    for (const node of nodes) this.children.push(typeof node === 'string' ? new FakeText(node) : node)
  }
}
class FakeText {
  constructor(value) {
    this.nodeValue = String(value)
  }
  get textContent() {
    return this.nodeValue
  }
}
const doc = { createElement: (tag) => new FakeNode(tag), createTextNode: (value) => new FakeText(value) }

const line = (extra = {}) => ({ key: 'seg_1', text: 'We agreed to ship on Friday.', start: 65, end: 70, persisted: 'INSERTED', speaker: null, uncertain: false, ...extra })

test('"you" and "others" are shown as You and Others, with what the label rests on', () => {
  assert.deepEqual(speakerTag(line({ speaker: 'you' })), {
    label: 'You',
    uncertain: false,
    title: 'Your microphone was sounding and the shared audio was not'
  })
  assert.deepEqual(speakerTag(line({ speaker: 'others' })), {
    label: 'Others',
    uncertain: false,
    title: 'The shared tab or system audio was sounding and your microphone was not'
  })
})

test('an uncertain label is shown with a question mark and says why', () => {
  const tag = speakerTag(line({ speaker: 'you', uncertain: true }))
  assert.equal(tag.label, 'You?')
  assert.equal(tag.uncertain, true)
  assert.match(tag.title, /probably.*both.*sounding/i)
  assert.equal(speakerTag(line({ speaker: 'others', uncertain: true })).label, 'Others?')
})

test('a placeholder tag, no tag, or anything else is not shown: it says nothing the reader can use', () => {
  for (const speaker of [null, undefined, '', 'speaker_00', 'speaker_01', 'overlap', 'unknown', 'You', 'OTHERS', 42, {}]) {
    assert.equal(speakerTag(line({ speaker })), null, JSON.stringify(speaker))
  }
})

test('a line is its time, then its words (with the label before them), then whether it was saved', () => {
  const element = lineElement(doc, line({ speaker: 'others' }))
  assert.equal(element.tag, 'li')
  assert.equal(element.dataset.state, 'saved')
  const [time, text, state] = element.children
  assert.equal(time.className, 'time')
  assert.equal(time.textContent, '1:05')
  assert.equal(state.className, 'line-state')
  assert.equal(text.textContent, 'Others We agreed to ship on Friday.')
  const [who] = text.children
  assert.equal(who.className, 'who')
  assert.equal(who.dataset.speaker, 'others')
  assert.equal(who.dataset.uncertain, 'false')
  assert.equal(who.textContent, 'Others')
  assert.match(who.title, /shared tab/)
})

test('a line with no known speaker is just its words, as it always was', () => {
  const element = lineElement(doc, line({ speaker: 'speaker_00' }))
  const [, text] = element.children
  assert.equal(text.children.length, 1)
  assert.ok(text.children[0] instanceof FakeText)
  assert.equal(text.textContent, 'We agreed to ship on Friday.')
})

test('the words are a text node, never markup', () => {
  const hostile = '<img src=x onerror=alert(1)> **bold**'
  const element = lineElement(doc, line({ speaker: 'you', text: hostile }))
  const [, text] = element.children
  const words = text.children.at(-1)
  assert.ok(words instanceof FakeText)
  assert.equal(words.nodeValue, hostile)
})

test('an unsaved or waiting line says so, and a line with no time shows none', () => {
  assert.equal(lineElement(doc, line({ persisted: 'FAILED' })).dataset.state, 'waiting')
  assert.equal(lineElement(doc, line({ persisted: 'REJECTED' })).dataset.state, 'notSaved')
  assert.equal(lineElement(doc, line({ start: null })).children[0].textContent, '')
})
