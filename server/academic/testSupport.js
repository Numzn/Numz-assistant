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
