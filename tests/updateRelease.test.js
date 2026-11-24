import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { verifies } from '../desktop/scripts/prepare-update-release.mjs'

// minisign's formats, made here with Node's own Ed25519, so the check that guards a release is itself checked without the Tauri CLI.
function keyPair(keyId = Buffer.from('0102030405060708', 'hex')) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const pubFile = `untrusted comment: minisign public key: TEST\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`
  return { privateKey, keyId, publicKeyBase64: Buffer.from(pubFile).toString('base64') }
}
function signature({ privateKey, keyId }, bytes, algorithm = 'ED') {
  const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes
  const body = Buffer.concat([Buffer.from(algorithm), keyId, sign(null, message, privateKey)])
  const file = `untrusted comment: signature from tauri secret key\n${body.toString('base64')}\ntrusted comment: timestamp:1\nAAAA\n`
  return Buffer.from(file).toString('base64')
}
const installer = (bytes) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'numz-rel-')), 'setup.exe')
  writeFileSync(file, bytes)
  return file
}

test('a signature made with the matching key verifies, in both of minisign\'s forms', () => {
  const keys = keyPair()
  const bytes = Buffer.from('an installer')
  const file = installer(bytes)
  assert.equal(verifies(file, signature(keys, bytes, 'ED'), keys.publicKeyBase64), true)
  assert.equal(verifies(file, signature(keys, bytes, 'Ed'), keys.publicKeyBase64), true)
})

test('a changed installer, another key, or a signature that is not one, does not verify', () => {
  const keys = keyPair()
  const other = keyPair(Buffer.from('a1a2a3a4a5a6a7a8', 'hex'))
  const bytes = Buffer.from('an installer')
  const sig = signature(keys, bytes)
  assert.equal(verifies(installer(Buffer.from('an installer, changed')), sig, keys.publicKeyBase64), false, 'tampered')
  assert.equal(verifies(installer(bytes), sig, other.publicKeyBase64), false, 'a different key')
  assert.equal(verifies(installer(bytes), signature(other, bytes), keys.publicKeyBase64), false, 'signed by someone else')
  assert.throws(() => verifies(installer(bytes), Buffer.from('nonsense').toString('base64'), keys.publicKeyBase64), /not a minisign signature/)
})

test('the public key in tauri.conf.json is a minisign key, and the update list is asked at https', () => {
  const config = JSON.parse(readFileSync(new URL('../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const updater = config.plugins.updater
  assert.match(Buffer.from(updater.pubkey, 'base64').toString('utf8'), /^untrusted comment: minisign public key: [0-9A-F]+\n[A-Za-z0-9+/=]{56}\n?$/)
  assert.ok(updater.endpoints.length >= 1 && updater.endpoints.every((e) => e.startsWith('https://')), 'an update list is never fetched over plain http')
  assert.equal(updater.windows.installMode, 'passive')
  assert.match(config.version, /^\d+\.\d+\.\d+$/)
})
