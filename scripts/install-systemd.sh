#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

NODE_BIN="/home/numz14/.local/node22/node-v22.15.0-linux-x64/bin"
LOCAL_BIN="/home/numz14/.local/bin"

write_unit() {
  local name="$1"
  local description="$2"
  local exec="$3"
  local after="${4:-network-online.target}"

  cat >"$UNIT_DIR/$name.service" <<EOF
[Unit]
Description=$description
After=$after
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PATH=$NODE_BIN:$LOCAL_BIN:/usr/bin:/bin
EnvironmentFile=-$ROOT/.env
EnvironmentFile=-$ROOT/.env.secrets
ExecStart=$exec
Restart=on-failure
RestartSec=5
StandardOutput=append:$ROOT/logs/${name}.log
StandardError=append:$ROOT/logs/${name}.log

[Install]
WantedBy=default.target
EOF
}

mkdir -p "$ROOT/logs"

write_unit "numz-assistant-audio" "Numz-Assistant Audio Sidecar (Whisper STT)" \
  "$NODE_BIN/npm run dev:audio"

write_unit "numz-assistant-api" "Numz-Assistant Express API" \
  "$NODE_BIN/node server/server.js" "numz-assistant-audio.service"

write_unit "numz-assistant-vite" "Numz-Assistant Vite Frontend" \
  "$NODE_BIN/npm run dev" "numz-assistant-api.service"

cat >"$UNIT_DIR/numz-assistant-https.service" <<EOF
[Unit]
Description=Numz-Assistant HTTPS Reverse Proxy (Caddy)
After=numz-assistant-vite.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT
ExecStart=/usr/bin/docker compose -f $ROOT/docker-compose.https.yml up -d
ExecStop=/usr/bin/docker compose -f $ROOT/docker-compose.https.yml down
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable numz-assistant-audio.service numz-assistant-api.service numz-assistant-vite.service numz-assistant-https.service

echo "Systemd user units installed in $UNIT_DIR"
echo "Enable boot persistence (optional, may require sudo):"
echo "  sudo loginctl enable-linger $USER"
echo
echo "Start now:"
echo "  systemctl --user start numz-assistant-audio numz-assistant-api numz-assistant-vite numz-assistant-https"
