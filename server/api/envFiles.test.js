import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadEnvFiles } from '../loadEnv.js'

function withConfigDir(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'env-files-'))
  try {
    writeFileSync(path.join(dir, '.env'), 'ONLY_IN_ENV=from-env\nBOTH=from-env\n')
    writeFileSync(path.join(dir, '.env.secrets'), 'BOTH=from-secrets\nONLY_IN_SECRETS=from-secrets\n')
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('.env.secrets is read after .env and wins over it', () => {
  withConfigDir((rootDir) => {
    const env = {}
    assert.deepEqual(loadEnvFiles({ rootDir, env }), ['.env', '.env.secrets'])
    assert.deepEqual(env, { ONLY_IN_ENV: 'from-env', BOTH: 'from-secrets', ONLY_IN_SECRETS: 'from-secrets' })
  })
})

test('NUMZ_SKIP_ENV_FILES=1 loads neither file, so a test keeps the configuration it passed in', () => {
  withConfigDir((rootDir) => {
    const env = { NUMZ_SKIP_ENV_FILES: '1', MEETING_API_TOKEN: 'the-test-token', BOTH: 'from-the-test' }
    assert.deepEqual(loadEnvFiles({ rootDir, env }), [])
    assert.deepEqual(env, { NUMZ_SKIP_ENV_FILES: '1', MEETING_API_TOKEN: 'the-test-token', BOTH: 'from-the-test' })
  })
})

test('missing files are not an error', () => {
  const env = {}
  assert.doesNotThrow(() => loadEnvFiles({ rootDir: path.join(os.tmpdir(), 'no-such-directory-for-env'), env }))
  assert.deepEqual(env, {})
})
