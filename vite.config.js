import { defineConfig, loadEnv } from 'vite'

const tailscaleHost = 'numzlab.tail2839ee.ts.net'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.PORT || '3002'
  const apiProxyTarget = process.env.API_PROXY_TARGET || env.API_PROXY_TARGET || `http://127.0.0.1:${apiPort}`

  return {
    root: '.',
    publicDir: 'public',
    server: {
      host: '0.0.0.0',
      port: 5173,
      allowedHosts: ['.numzlab', tailscaleHost, '100.121.79.2', 'localhost'],
      hmr: {
        protocol: 'wss',
        host: tailscaleHost,
        clientPort: 443
      },
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          ws: true
        }
      }
    }
  }
})
