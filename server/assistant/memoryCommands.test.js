import assert from 'node:assert/strict'
import test from 'node:test'
import { kindOf, parseMemoryCommand as parse } from './memoryCommands.js'

test('"remember ..." in the person\'s own words is a request to remember; the thing is kept as they said it', () => {
  assert.deepEqual(parse('Remember that I study economics at UNZA'), { type: 'remember', text: 'I study economics at UNZA' })
  assert.deepEqual(parse('please remember my exam is on Friday.'), { type: 'remember', text: 'my exam is on Friday' })
  assert.deepEqual(parse("Numz, don't forget that I prefer short answers"), { type: 'remember', text: 'I prefer short answers' })
  assert.deepEqual(parse('Can you remember that my sister is called Ana'), { type: 'remember', text: 'my sister is called Ana' })
  assert.deepEqual(parse('Keep in mind that I am vegetarian please'), { type: 'remember', text: 'I am vegetarian' })
  assert.deepEqual(parse('make a note that the lab is moved to room 4'), { type: 'remember', text: 'the lab is moved to room 4' })
})

test('forgetting, and asking what is remembered', () => {
  assert.deepEqual(parse('forget that I study economics'), { type: 'forget', text: 'I study economics' })
  assert.deepEqual(parse('Forget about my exam'), { type: 'forget', text: 'my exam' })
  assert.deepEqual(parse('Numz please delete the memory about my sister'), { type: 'forget', text: 'my sister' })
  assert.deepEqual(parse('forget everything'), { type: 'forget-all' })
  assert.deepEqual(parse('erase everything you know about me'), { type: 'forget-all' })
  assert.deepEqual(parse('what do you remember about me?'), { type: 'list' })
  assert.deepEqual(parse('What do you know about me'), { type: 'list' })
  assert.deepEqual(parse('tell me what you have noted about me'), { type: 'list' })
})

test('a question, or a sentence that only mentions remembering, is not a command', () => {
  for (const said of ['do you remember the meeting?', 'Did you remember to save it', 'I remember nothing about that lecture', 'remember', 'what is the capital of Zambia', 'I forget my keys all the time', 'how do I remember formulas?', '', 'x'.repeat(700)]) {
    assert.equal(parse(said), null, said.slice(0, 40))
  }
})

test('the kind of a memory follows how it is worded', () => {
  assert.equal(kindOf('I prefer short answers'), 'preference')
  assert.equal(kindOf('call me Sam'), 'preference')
  assert.equal(kindOf('I want to finish my degree in 2027'), 'goal')
  assert.equal(kindOf('my sister is called Ana'), 'person')
  assert.equal(kindOf('I study economics at UNZA'), 'fact')
  assert.equal(kindOf('the lab is moved to room 4'), 'note')
})
