// Shared fixtures for the academic tests (not imported by the application).
import { createAcademicRepository } from '../persistence/academicRepository.js'
import { createIdentityRepository } from '../persistence/identityRepository.js'
import { createDatabase } from '../persistence/sqliteDatabase.js'

export const quiet = { error() {}, warn() {}, info() {}, log() {} }

export function people(database, names = ['alice', 'bob']) {
  const repo = createIdentityRepository(database)
  const out = {}
  for (const name of names) {
    const user = repo.upsertUser({ externalId: `${name.charCodeAt(0).toString(16).padStart(2, '0')}0000000000`.slice(0, 12), email: `${name}@example.com`, name, role: 'viewer' })
    out[name] = user.id
  }
  return out
}

export function rig({ clock = { t: Date.parse('2026-11-22T10:00:00.000Z') } } = {}) {
  const database = createDatabase({ filename: ':memory:' })
  const who = people(database)
  const academic = createAcademicRepository(database, { clock: () => clock.t })
  const audits = []
  const audit = (event, detail) => audits.push({ event, ...detail })
  return { database, who, academic, audits, audit, clock }
}

/** A picture that has a real PNG header and nothing else: all the server looks at is what the bytes say they are. */
export function png(width = 1280, height = 720, filler = 0) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b.writeUInt8(filler & 255, 32) // makes two otherwise identical pictures differ
  return b
}

/** A vision stand-in whose reply a test sets. */
export function fakeVision({ configured = true } = {}) {
  const calls = []
  const state = { reply: async () => '{}' }
  return {
    configured,
    name: 'fake',
    calls,
    state,
    read: async (args) => {
      calls.push(args)
      return state.reply(args)
    }
  }
}

export const reading = (over = {}) =>
  JSON.stringify({
    contentKind: 'revision_question',
    questions: [{ text: 'Explain third normal form with an example.', options: [], marks: '5', type: 'descriptive', hasDiagram: false }],
    instructions: '',
    subject: 'databases',
    topic: 'third normal form',
    assessmentIndicators: [],
    confidence: 0.9,
    reason: '',
    ...over
  })
