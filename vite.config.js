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
    // Served under /ai/ on the shared site: the production build is made with VITE_PUBLIC_BASE=/ai/ (Dockerfile.production), which puts the
    // prefix on every script, style and asset address and on import.meta.env.BASE_URL (src/core/apiPaths.js uses it for the API). The
    // server takes the prefix off again, so the same build also answers at the root. Without it (dev server, tests) the base is '/'.
    base: process.env.VITE_PUBLIC_BASE || env.VITE_PUBLIC_BASE || '/',
    // Three pages: the Home screen, the conversation history screen and the Smart Camera.
    build: {
      rollupOptions: {
        input: { main: 'index.html', history: 'history.html', camera: 'camera.html' }
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
