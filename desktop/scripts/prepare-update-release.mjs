// Turns the Windows installer built by CI into what a release needs for the app's update line: the installer under a fixed name, its signature,
// and the list of versions (latest.json) that the installed apps ask.
//
//   node desktop/scripts/prepare-update-release.mjs <installer.exe> <version> [notes-file] [out-dir]
//
// The signature is made here, on the machine that holds the private key (~/.numz-updater/updater.key and its password file), not in CI: the key
// is never given to GitHub. The result is checked against the PUBLIC key that is in tauri.conf.json (the key every installed app trusts) before
// anything is written, so a manifest that an app would refuse is never produced.
//
// Nothing is published by this script. It prints the commands that would, for a person to run.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(path.resolve(here, '../src-tauri/tauri.conf.json'), 'utf8'))
const REPO = 'Numzn/Numz-assistant'
const ASSET = 'NUMZ-AI-setup-windows-x64.exe'
const CLI = '@tauri-apps/cli@2.12.4'

/** minisign's own format: base64 of [2-byte algorithm, 8-byte key id, then the key (32) or the signature (64)]. */
function minisign(text, kind) {
  const lines = String(text).trim().split('\n')
  const body = Buffer.from(lines.find((l) => l && !l.startsWith('untrusted comment:') && !l.startsWith('trusted comment:')) ?? '', 'base64')
  if (body.length < 10) throw new Error(`not a minisign ${kind}`)
  return { algorithm: body.subarray(0, 2).toString('latin1'), keyId: body.subarray(2, 10).toString('hex'), data: body.subarray(10) }
}

/** Does `signature` (the text of a .sig file) verify for `file` under the public key text of tauri.conf.json? */
export function verifies(file, signatureText, publicKeyBase64) {
  const key = minisign(Buffer.from(publicKeyBase64, 'base64').toString('utf8'), 'public key')
  const sig = minisign(Buffer.from(signatureText.trim(), 'base64').toString('utf8'), 'signature')
  if (key.keyId !== sig.keyId || key.data.length !== 32 || sig.data.length !== 64) return false
  const bytes = readFileSync(file)
  // "ED" signs the Blake2b-512 hash of the file (what the updater uses); "Ed" signs the file itself.
  const message = sig.algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.data])
  return verify(null, message, createPublicKey({ key: der, format: 'der', type: 'spki' }), sig.data)
}

function main() {
  const [installer, version, notesFile, outArg] = process.argv.slice(2)
  if (!installer || !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('usage: node desktop/scripts/prepare-update-release.mjs <installer.exe> <version, like 0.2.1> [notes-file] [out-dir]')
    process.exit(2)
  }
  if (!existsSync(installer)) throw new Error(`no such installer: ${installer}`)
  if (version !== config.version) throw new Error(`the app in this checkout is ${config.version}, not ${version}: build the installer from the checkout that has that version`)
  const keyFile = process.env.NUMZ_UPDATER_KEY || path.join(os.homedir(), '.numz-updater/updater.key')
  const passwordFile = process.env.NUMZ_UPDATER_PASSWORD_FILE || path.join(os.homedir(), '.numz-updater/updater.password')
  const out = path.resolve(outArg || `release-${version}`)
  mkdirSync(out, { recursive: true })
  const asset = path.join(out, ASSET)
  copyFileSync(installer, asset)

  // The signature is made by the Tauri CLI with the private key; the key and its password are read from files and never printed.
  execFileSync('npx', ['--yes', CLI, 'signer', 'sign', '-f', keyFile, asset], {
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: existsSync(passwordFile) ? readFileSync(passwordFile, 'utf8').trim() : '' },
    stdio: ['ignore', 'ignore', 'inherit']
  })
  const signature = readFileSync(`${asset}.sig`, 'utf8').trim()
  if (!verifies(asset, signature, config.plugins.updater.pubkey)) throw new Error('the signature does not verify under the public key in tauri.conf.json: nothing was written')

  const notes = notesFile && notesFile !== '-' ? readFileSync(notesFile, 'utf8').trim() : ''
  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: { 'windows-x86_64': { signature, url: `https://github.com/${REPO}/releases/download/desktop-windows-v${version}/${ASSET}` } }
  }
  writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const sha = createHash('sha256').update(readFileSync(asset)).digest('hex')
  console.log(`ready in ${out}: ${ASSET} (sha256 ${sha}), ${ASSET}.sig, latest.json — the signature verifies under the app's public key`)
  console.log(`\nto publish (this makes it public, and installed apps will offer it):\n  gh release create desktop-windows-v${version} --repo ${REPO} --title "NUMZ AI desktop for Windows ${version}" --notes-file <notes> ${out}/${ASSET} ${out}/${ASSET}.sig ${out}/latest.json`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
