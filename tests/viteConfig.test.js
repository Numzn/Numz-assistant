import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import viteConfig from '../vite.config.js'

/** Builds the dev server config with exactly these Tailscale settings, whatever the developer's .env says. */
async function configWith({ host, ip }) {
  const saved = { TAILSCALE_HOST: process.env.TAILSCALE_HOST, TAILSCALE_IP: process.env.TAILSCALE_IP }
  process.env.TAILSCALE_HOST = host
  process.env.TAILSCALE_IP = ip
  try {
    return await viteConfig({ mode: 'development', command: 'serve' })
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('with the machine settings in the environment, the dev server answers to them and hot reload uses the name', async () => {
  const { server } = await configWith({ host: 'box.example.ts.net', ip: '100.64.0.9' })
  assert.deepEqual(server.allowedHosts, ['.numzlab', 'localhost', 'box.example.ts.net', '100.64.0.9'])
  assert.deepEqual(server.hmr, { protocol: 'wss', host: 'box.example.ts.net', clientPort: 443 })
})

test('with no settings it allows only local names and leaves hot reload at Vite defaults', async () => {
  const { server } = await configWith({ host: '', ip: '' })
  assert.deepEqual(server.allowedHosts, ['.numzlab', 'localhost'])
  assert.equal('hmr' in server, false)
})

test('a name without an address (or the reverse) is honoured on its own', async () => {
  const onlyName = (await configWith({ host: 'box.example.ts.net', ip: '' })).server
  assert.deepEqual(onlyName.allowedHosts, ['.numzlab', 'localhost', 'box.example.ts.net'])
  const onlyIp = (await configWith({ host: '', ip: '100.64.0.9' })).server
  assert.deepEqual(onlyIp.allowedHosts, ['.numzlab', 'localhost', '100.64.0.9'])
  assert.equal('hmr' in onlyIp, false)
})

test('the files that should be portable do not hard-code a tailnet name or address', () => {
  // docker/Caddyfile is deliberately not listed: it is the live HTTPS router for this machine.
  for (const file of ['vite.config.js', 'scripts/start-dev.sh', 'scripts/docker-up.sh', 'scripts/verify-deployment.sh']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /\.ts\.net\b/, `${file} names a tailnet`)
    assert.doesNotMatch(text, /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, `${file} contains a Tailscale address`)
  }
})
