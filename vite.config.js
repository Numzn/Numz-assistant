import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.PORT || '3002'
  const apiProxyTarget = process.env.API_PROXY_TARGET || env.API_PROXY_TARGET || `http://127.0.0.1:${apiPort}`
  // This machine's Tailscale name and address come from the private .env (TAILSCALE_HOST, TAILSCALE_IP),
  // not from the repository. Without them the dev server answers only to localhost and the .numzlab names.
  const tailscaleHost = (env.TAILSCALE_HOST || '').trim()
  const tailscaleIp = (env.TAILSCALE_IP || '').trim()

  return {
    root: '.',
    publicDir: 'public',
    // Two pages: the Home screen and the conversation history screen.
    build: {
      rollupOptions: {
        input: { main: 'index.html', history: 'history.html' }
      }
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      allowedHosts: ['.numzlab', 'localhost', ...[tailscaleHost, tailscaleIp].filter(Boolean)],
      // Hot reload goes through the HTTPS router on the tailnet name. With no name, Vite's default applies.
      ...(tailscaleHost ? { hmr: { protocol: 'wss', host: tailscaleHost, clientPort: 443 } } : {}),
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
