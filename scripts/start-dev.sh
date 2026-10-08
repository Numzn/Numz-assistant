                                                    #!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/home/numz14/.local/node22/node-v22.15.0-linux-x64/bin:/home/numz14/.local/bin:$PATH"
export PORT="${PORT:-3002}"

cd "$ROOT"

mkdir -p "$ROOT/logs"

if ! curl -sf "http://127.0.0.1:8765/health" >/dev/null 2>&1; then
  echo "Starting audio sidecar on :8765"
  nohup npm run dev:audio >>"$ROOT/logs/audio.log" 2>&1 &
fi

if ! curl -sf "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
  echo "Starting API on :${PORT}"
  nohup npm run dev:api >>"$ROOT/logs/api.log" 2>&1 &
fi

sleep 2

if ! curl -sf "http://127.0.0.1:5173" >/dev/null 2>&1; then
  echo "Starting Vite on :5173"
  nohup npm run dev >>"$ROOT/logs/web.log" 2>&1 &
fi

if ! docker ps --format '{{.Names}}' | grep -qx numz-assistant-https; then
  echo "Starting HTTPS reverse proxy on :443"
  docker compose -f "$ROOT/docker-compose.https.yml" up -d
fi

echo "Numz-assistant dev stack starting. Logs in $ROOT/logs/"
TAILSCALE_HOST="$(grep -E '^TAILSCALE_HOST=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [[ -n "$TAILSCALE_HOST" ]]; then
  echo "HTTPS: https://$TAILSCALE_HOST"
fi
