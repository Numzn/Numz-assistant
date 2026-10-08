#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/home/numz14/.local/node22/node-v22.15.0-linux-x64/bin:/home/numz14/.local/bin:$PATH"
BASE_URL="${BASE_URL:-https://100.121.79.2}"

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

echo "--- DeepSeek probe: GET /api/v1/health/deepseek ---"
curl -sk "$BASE_URL/api/v1/health/deepseek" | python3 -m json.tool
echo

echo "--- Chat test ---"
SID=$(curl -sk -X POST "$BASE_URL/api/v1/assistant/sessions" \
  -H 'Content-Type: application/json' -d '{"metadata":{"verify":true}}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")
CHAT=$(curl -sk -X POST "$BASE_URL/api/v1/assistant/sessions/$SID/chat" \
  -H 'Content-Type: application/json' -d '{"message":"Hello Numz"}')
echo "$CHAT" | python3 -m json.tool
echo

echo "--- Audio health ---"
curl -sk http://127.0.0.1:8765/health | python3 -m json.tool
echo

echo "--- Frontend ---"
curl -sk -o /dev/null -w "HTTPS frontend HTTP status: %{http_code}\n" "$BASE_URL/"
echo
echo "=== Verification complete ==="
