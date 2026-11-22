import assert from 'node:assert/strict'
import test from 'node:test'
import { createEventBus } from '../src/core/events/eventBus.js'
import { splitMessage } from '../src/interfaces/chat/attachments.js'
import { createChatController } from '../src/interfaces/chat/chatController.js'

const ID = '0f3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const ID2 = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function chat() {
  return createChatController({ assistantController: { async submitText() {}, async interrupt() {} }, assistantClient: { useSession() {} }, eventBus: createEventBus() })
}

test('a stored screenshot message is a chip, not text: the marker is taken out and the typed question stays', () => {
  assert.deepEqual(splitMessage(`Why does this fail?\n[Screenshot id=${ID}]`), {
    text: 'Why does this fail?',
    attachments: [{ name: 'Screenshot', kind: 'screenshot', shotId: ID, followUp: false, size: 0 }]
  })
  assert.deepEqual(splitMessage(`[Screenshot id=${ID}]`).text, '')
  assert.equal(splitMessage(`And line 4?\n[Screenshot id=${ID} follow-up]`).attachments[0].followUp, true)
  assert.deepEqual(splitMessage('An ordinary message with [brackets]'), { text: 'An ordinary message with [brackets]', attachments: [] })
})

test('a screenshot joins the thread as an exchange and leaves it when deleted, without touching the rest', () => {
  const c = chat()
  c.addScreenshotExchange({ shotId: ID, question: 'What is this?', analysis: '**A terminal**' })
  c.addScreenshotExchange({ shotId: ID, question: 'Line 3?', analysis: 'The import.', followUp: true })
  c.addScreenshotExchange({ shotId: ID2, analysis: 'A document.' })
  let messages = c.getState().messages
  assert.equal(messages.length, 6)
  assert.equal(messages[0].attachments[0].kind, 'screenshot')
  assert.equal(messages[0].text, 'What is this?')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].text, '**A terminal**')
  assert.equal(messages[2].attachments[0].followUp, true)

  assert.equal(c.removeScreenshot(ID), true)
  messages = c.getState().messages
  assert.equal(messages.length, 2, 'the screenshot, its follow-up and both answers went')
  assert.equal(messages[1].text, 'A document.')
  assert.equal(c.removeScreenshot(ID), false, 'deleting again changes nothing')
})

test('reopening a saved conversation shows its screenshots as chips and keeps each answer paired with its screenshot', async () => {
  const c = chat()
  await c.open({
    id: 'c1',
    messages: [
      { role: 'user', content: 'A normal question' },
      { role: 'assistant', content: 'A normal answer' },
      { role: 'user', content: `Explain\n[Screenshot id=${ID}]` },
      { role: 'assistant', content: 'It is a terminal.' }
    ]
  })
  const messages = c.getState().messages
  assert.equal(messages[2].attachments[0].kind, 'screenshot')
  assert.equal(messages[2].shotId, ID)
  assert.equal(messages[3].shotId, ID, 'the answer is paired with the screenshot')
  assert.equal(messages[0].shotId, undefined)
  assert.equal(c.removeScreenshot(ID), true)
  assert.deepEqual(c.getState().messages.map((m) => m.text), ['A normal question', 'A normal answer'])
})
