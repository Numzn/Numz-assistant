#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Numz-Assistant Docker startup ==="

if [[ ! -f "$ROOT/.env" ]]; then
  echo "ERROR: missing .env — copy from .env.example"
  exit 1
fi

if [[ ! -f "$ROOT/.env.secrets" ]]; then
  echo "WARNING: missing .env.secrets — AI chat will fail without AI_API_KEY"
fi

if [[ ! -f "$ROOT/docker/certs/cert.pem" ]]; then
  echo "WARNING: missing docker/certs/cert.pem — HTTPS will not start until certs exist"
fi

echo "Stopping host/systemd services (free ports 5173, 3002, 8765, 443)..."
for unit in numz-assistant-audio numz-assistant-api numz-assistant-vite numz-assistant-https; do
  systemctl --user stop "$unit.service" 2>/dev/null || true
done

pkill -f "$ROOT/node_modules/.bin/vite" 2>/dev/null || true
pkill -f "$ROOT/server/server.js" 2>/dev/null || true
pkill -f "$ROOT/scripts/run-audio-server.js" 2>/dev/null || true
pkill -f "$ROOT/audio/server.py" 2>/dev/null || true

docker rm -f numz-assistant-https 2>/dev/null || true

sleep 1

echo "Building and starting Docker stack..."
docker compose up -d --build

echo ""
echo "Waiting for services..."
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3002/api/v1/health >/dev/null 2>&1 \
    && curl -sf http://127.0.0.1:5173/ >/dev/null 2>&1; then
    echo "Stack is up."
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "WARNING: timed out waiting for API/web — check: docker compose logs"
    exit 1
  fi
  sleep 2
done

echo ""
docker compose ps
echo ""
echo "HTTPS:  https://numzlab.tail2839ee.ts.net"
echo "Vite:   http://127.0.0.1:5173"
echo "API:    http://127.0.0.1:3002/api/v1/health"
echo "Logs:   docker compose logs -f"
