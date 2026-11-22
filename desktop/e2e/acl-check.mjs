// Proves the app only trusts the real site: built WITHOUT the local-test capability, the app is pointed at a copy of the page on this
// machine, and every screenshot command must be refused by Tauri's own permission check (the page is not https://lab.numz.site).
//
//   NUMZ_DESKTOP_BIN=<an app built with the default config> node desktop/e2e/acl-check.mjs
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reporter, startApp } from '../../scripts/camera-e2e/lib.mjs'
import { startFakeVision } from './fakeVision.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = process.env.NUMZ_DESKTOP_BIN || path.resolve(here, '../src-tauri/target/debug/numz-ai-desktop')
const DRIVER = path.join(os.homedir(), '.cargo/bin/tauri-driver')
const DISPLAY = ':93'
const env = { ...process.env, DISPLAY, WEBKIT_DISABLE_COMPOSITING_MODE: '1', WEBKIT_DISABLE_DMABUF_RENDERER: '1', NO_AT_BRIDGE: '1' }
const { check, finish } = reporter()
const children = []
const track = (cmd, args, opts = {}) => { const c = spawn(cmd, args, { env, stdio: 'ignore', ...opts }); children.push(c); return c }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numz-acl-'))

track('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'])
for (let i = 0; i < 50; i++) { try { execFileSync('xdpyinfo', { env, stdio: 'ignore' }); break } catch { await sleep(100) } }
const vision = await startFakeVision()
const server = await startApp({ dir, port: 18466, stubPort: vision.port })
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: server.port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${server.port}` } }, (a) => {
    const h = { ...a.headers }
    if (h['content-security-policy']) h['content-security-policy'] = String(h['content-security-policy']).replace(/;?\s*upgrade-insecure-requests/i, '')
    res.writeHead(a.statusCode, h); a.pipe(res)
  })
  up.on('error', () => res.destroy()); req.pipe(up)
})
await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${proxy.address().port}`
track(DRIVER, ['--port', '4447', '--native-port', '4448', '--native-driver', '/usr/bin/WebKitWebDriver'], { env: { ...env, NUMZ_AI_URL: `${base}/` } })
const wd = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:4447${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`)
  return json.value
}
let sid = null
try {
  for (let i = 0; i < 100 && !sid; i++) { try { sid = (await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } })).sessionId } catch { await sleep(300) } }
  if (!sid) throw new Error('no WebDriver session')
  for (let i = 0; i < 60; i++) { if (await wd('POST', `/session/${sid}/execute/sync`, { script: 'return document.readyState==="complete" && !!document.getElementById("shotButton")', args: [] })) break; await sleep(300) }
  // The refusal can surface as a rejected promise or, with this WebDriver, as the script's own error: both carry Tauri's message.
  const call = (command, args = {}) => wd('POST', `/session/${sid}/execute/async`, {
    script: 'const done = arguments[arguments.length-1]; const [cmd, args] = arguments; (window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke(cmd, args) : Promise.reject("no bridge")).then((v)=>done({ok:true}), (e)=>done({ok:false, error: typeof e === "string" ? e : JSON.stringify(e)}))',
    args: [command, args]
  }).catch((e) => ({ ok: false, error: String(e.message) }))
  check('the page is open in the app', (await wd('POST', `/session/${sid}/execute/sync`, { script: 'return location.origin', args: [] })) === base)
  for (const [command, args] of [['screenshot_status'], ['screenshot_windows'], ['screenshot_capture', { mode: 'screen', windowId: null }], ['screenshot_export', { captureId: 'x', rect: null, maxSide: 1024, quality: 80 }], ['screenshot_discard', { captureId: 'x' }], ['screenshot_watch_start', { intervalMs: 2500, excludeApps: [], excludeTitles: [] }], ['screenshot_watch_poll', {}], ['screenshot_watch_pause', {}], ['screenshot_watch_resume', {}], ['screenshot_watch_stop', {}]]) {
    const r = await call(command, args)
    check(`${command} is refused for a page that is not the real site`, r.ok === false && /not allowed|forbidden|denied|permission/i.test(r.error ?? ''), JSON.stringify(r).slice(0, 420))
  }
} catch (err) {
  check('the check ran', false, String(err.message).slice(0, 200))
} finally {
  try { if (sid) await wd('DELETE', `/session/${sid}`) } catch {}
  await new Promise((r) => proxy.close(r)); await server.stop().catch(() => {}); await vision.close().catch(() => {})
  for (const c of children.reverse()) c.kill('SIGTERM')
}
process.exit(finish() ? 0 : 1)
