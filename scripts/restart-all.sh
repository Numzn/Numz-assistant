#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/home/numz14/.local/node22/node-v22.15.0-linux-x64/bin:/home/numz14/.local/bin:$PATH"

echo "Stopping legacy nohup processes..."
pkill -f "$ROOT/node_modules/.bin/vite" 2>/dev/null || true
pkill -f "$ROOT/server/server.js" 2>/dev/null || true
pkill -f "$ROOT/scripts/run-audio-server.js" 2>/dev/null || true
pkill -f "$ROOT/audio/server.py" 2>/dev/null || true
sleep 2

if systemctl --user is-active numz-assistant-api.service >/dev/null 2>&1; then
  echo "Restarting systemd user services..."
  systemctl --user restart numz-assistant-audio.service
  systemctl --user restart numz-assistant-api.service
  systemctl --user restart numz-assistant-vite.service
  systemctl --user restart numz-assistant-https.service
else
  echo "Starting via start-dev.sh (systemd not installed)..."
  "$ROOT/scripts/start-dev.sh"
fi

sleep 4
"$ROOT/scripts/verify-deployment.sh"
