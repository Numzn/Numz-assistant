import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAnswers as serverParse, plainText as serverPlain } from '../server/academic/answerFormat.js'
import { parseAnswers as pageParse, plainText as pagePlain } from '../src/interfaces/chat/answerSplit.js'

// The page reads an answer's layout with its own copy of the server's functions (the browser may not import from server/ beyond one file).
// The same texts go through both, and everything they give back must be identical.
const TEXTS = [
  '**B) 60 km/h**',
  '#### ANSWER\n\nOpportunity cost is the next best thing you give up.',
  '#### ANSWER (a)\nA general rise in prices.\n\n**ANSWER (b)**\n**5%**\n\n- (210 - 200) / 200 x 100\n\nANSWER (c):\nSavings lose value.',
  '#### ANSWER (a)\nOne [S1].\n\n#### ANSWER (b)\nTwo.\n\n**Sources**\n- [S1] Lecture 3',
  'Some words first.\n\n### ANSWER\n\nThe answer.',
  '#### ANSWER\nRun this:\n```\n#### ANSWER (b)\nprint(1)\n```',
  '## Answer\nAn ordinary heading is not a block.',
  '| a | b |\n|---|---|\n| 1 | 2 |\n\nSee [the notes](https://example.org/n). **bold** __also__ *em* `code`',
  '#### ANSWER\n\nThe answer.\n\n**Note**\nThe notes do not explain this.\n\n**Sources**\n- Lecture 3',
  '#### ANSWER\n\nThe answer.\n\n**Note**\nOnly a note.',
  '',
  '#### ANSWER (12)\n\nTwelve.'
]

test('the page and the server read an answer\'s layout the same way', () => {
  for (const text of TEXTS) {
    assert.deepEqual(pageParse(text), serverParse(text), JSON.stringify(text).slice(0, 60))
    assert.equal(pagePlain(text), serverPlain(text), JSON.stringify(text).slice(0, 60))
  }
})
