import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { errorHandler } from '../http/errorHandler.js'
import { MeetingDomainError } from '../meetings/meetingDomain.js'

const quiet = { error() {}, warn() {}, info() {}, log() {} }

async function respond(error) {
  const app = express()
  app.get('/boom', (req, _res, next) => {
    req.id = 'req-1'
    next(error)
  })
  app.use(errorHandler({ logger: quiet }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/boom`)
    return { status: res.status, body: await res.json() }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('an unexpected failure is a generic 500 that leaks nothing', async () => {
  const { status, body } = await respond(new Error('SELECT * FROM secrets failed at /srv/app'))
  assert.equal(status, 500)
  assert.deepEqual(body, { error: 'Internal Server Error', code: 'internal-error', requestId: 'req-1' })
})

test('a 5xx that is not one of our own domain errors stays hidden, whatever status it carries', async () => {
  const error = Object.assign(new Error('upstream said: api key sk-123 rejected'), { statusCode: 503 })
  const { status, body } = await respond(error)
  assert.equal(status, 500)
  assert.equal(body.code, 'internal-error')
  assert.doesNotMatch(JSON.stringify(body), /sk-123/)
})

test('a domain error that declares a 5xx keeps its status, message and stable code', async () => {
  const error = new MeetingDomainError('The notes provider failed: timeout', { statusCode: 502, code: 'notes-provider-failed' })
  const { status, body } = await respond(error)
  assert.equal(status, 502)
  assert.equal(body.code, 'notes-provider-failed')
  assert.match(body.error, /notes provider failed/)
})

test('4xx behaviour is unchanged', async () => {
  const { status, body } = await respond(new MeetingDomainError('nope', { statusCode: 409, code: 'transcript-not-final', details: { state: 'open' } }))
  assert.equal(status, 409)
  assert.equal(body.code, 'transcript-not-final')
  assert.deepEqual(body.details, { state: 'open' })
})
