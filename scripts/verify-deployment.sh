#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/home/numz14/.local/node22/node-v22.15.0-linux-x64/bin:/home/numz14/.local/bin:$PATH"
# Default target: this machine's Tailscale address from the private .env, else the local API.
TAILSCALE_IP="$(grep -E '^TAILSCALE_IP=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [[ -n "$TAILSCALE_IP" ]]; then
  DEFAULT_BASE_URL="https://$TAILSCALE_IP"
else
  DEFAULT_BASE_URL="http://127.0.0.1:3002"
fi
BASE_URL="${BASE_URL:-$DEFAULT_BASE_URL}"

echo "=== Numz-Assistant Deployment Verification ==="
echo "Time: $(date -Is)"
echo "Base URL: $BASE_URL"
echo

echo "--- Environment ---"
for var in AI_PROVIDER AI_MODEL AI_BASE_URL PORT; do
  val="$(grep -E "^${var}=" "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
  echo "$var=$val"
done
if grep -qE '^AI_API_KEY=.+$' "$ROOT/.env.secrets" 2>/dev/null; then
  echo "AI_API_KEY=present (redacted)"
else
  echo "AI_API_KEY=MISSING or empty"
fi
echo

echo "--- Port checks ---"
ss -tlnp | grep -E ':(443|5173|3002|8765)\s' || echo "WARNING: expected ports not all listening"
echo

echo "--- Health: GET /api/v1/health ---"
curl -sk "$BASE_URL/api/v1/health" | python3 -m json.tool
echo

# The assistant may need an access code (ASSISTANT_ACCESS_CODE on the server). To run the authenticated checks
# below, give the script the same code in its environment: ASSISTANT_ACCESS_CODE=... bash scripts/verify-deployment.sh
# It is sent once, from stdin (never on a command line), and only a session cookie is kept, in a temporary file.
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT
AUTH_REQUIRED="$(curl -sk "$BASE_URL/api/v1/assistant/auth/status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('required', False))" 2>/dev/null || echo False)"
RUN_ASSISTANT_CHECKS=1
echo "--- Assistant access ---"
if [[ "$AUTH_REQUIRED" == "True" ]]; then
  if [[ -n "${ASSISTANT_ACCESS_CODE:-}" ]]; then
    LOGIN_STATUS=$(printf '%s' "$ASSISTANT_ACCESS_CODE" \
      | python3 -c "import sys,json; print(json.dumps({'code': sys.stdin.read()}))" \
      | curl -sk -o /dev/null -w '%{http_code}' -c "$COOKIES" -X POST "$BASE_URL/api/v1/assistant/auth/login" \
          -H 'Content-Type: application/json' --data-binary @-)
    echo "access code required: yes; login HTTP status: $LOGIN_STATUS"
    if [[ "$LOGIN_STATUS" != "200" ]]; then
      echo "WARNING: login failed; skipping the checks that need it"
      RUN_ASSISTANT_CHECKS=0
    fi
  else
    echo "access code required: yes; ASSISTANT_ACCESS_CODE is not set in this shell, so the DeepSeek and chat checks are SKIPPED"
    RUN_ASSISTANT_CHECKS=0
  fi
else
  echo "access code required: no (the assistant API is open)"
fi
echo

if [[ "$RUN_ASSISTANT_CHECKS" == "1" ]]; then
  echo "--- DeepSeek probe: GET /api/v1/health/deepseek ---"
  curl -sk -b "$COOKIES" "$BASE_URL/api/v1/health/deepseek" | python3 -m json.tool
  echo

  echo "--- Chat test ---"
  SID=$(curl -sk -b "$COOKIES" -X POST "$BASE_URL/api/v1/assistant/sessions" \
    -H 'Content-Type: application/json' -d '{"metadata":{"verify":true}}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")
  CHAT=$(curl -sk -b "$COOKIES" -X POST "$BASE_URL/api/v1/assistant/sessions/$SID/chat" \
    -H 'Content-Type: application/json' -d '{"message":"Hello Numz"}')
  echo "$CHAT" | python3 -m json.tool
  echo
fi

echo "--- Audio health ---"
curl -sk http://127.0.0.1:8765/health | python3 -m json.tool
echo

echo "--- Frontend ---"
curl -sk -o /dev/null -w "HTTPS frontend HTTP status: %{http_code}\n" "$BASE_URL/"
echo
echo "=== Verification complete ==="
