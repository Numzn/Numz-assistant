import assert from 'node:assert/strict'
import test from 'node:test'

// The launcher imports the env loader; keep real .env files out of the test.
process.env.NUMZ_SKIP_ENV_FILES = '1'
const { absolutizeArgs } = await import('../scripts/run-replay.js')

const CWD = '/work/repo'

test('the recording and the files named by --reference and --json become absolute, against where npm run was typed', () => {
  assert.deepEqual(
    absolutizeArgs(['audio/recordings/a.wav', '--reference', 'refs/a.txt', '--json', 'out/a.json'], CWD),
    ['/work/repo/audio/recordings/a.wav', '--reference', '/work/repo/refs/a.txt', '--json', '/work/repo/out/a.json']
  )
})

test('options that are not files are passed through untouched', () => {
  assert.deepEqual(absolutizeArgs(['a.wav', '--pace', '1', '--language', 'en', '--force'], CWD), [
    '/work/repo/a.wav',
    '--pace',
    '1',
    '--language',
    'en',
    '--force'
  ])
})

test('an absolute path stays as it is, and a flag before the recording does not hide it', () => {
  assert.deepEqual(absolutizeArgs(['--force', '/data/x.wav'], CWD), ['--force', '/data/x.wav'])
})

test('a trailing flag without a value is left for the tool to reject', () => {
  assert.deepEqual(absolutizeArgs(['a.wav', '--json'], CWD), ['/work/repo/a.wav', '--json'])
})
