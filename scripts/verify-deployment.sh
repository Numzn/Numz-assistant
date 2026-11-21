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

# BASE_URL may include the app's base path (https://lab.numz.site/ai): the API is under it. The public health answer says only that the
# server is up (with per-person sign-in the details are for signed-in people).
echo "--- Health: GET /api/v1/health ---"
curl -sk "$BASE_URL/api/v1/health" | python3 -m json.tool
echo

# The assistant may need an access code (ASSISTANT_ACCESS_CODE on the server). To run the authenticated checks
# below, give the script the same code in its environment: ASSISTANT_ACCESS_CODE=... bash scripts/verify-deployment.sh
# It is sent once, from stdin (never on a command line), and only a session cookie is kept, in a temporary file.
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT
STATUS_JSON="$(curl -sk "$BASE_URL/api/v1/assistant/auth/status" || echo '{}')"
AUTH_REQUIRED="$(printf '%s' "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('required', False))" 2>/dev/null || echo False)"
AUTH_MODE="$(printf '%s' "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode', 'code'))" 2>/dev/null || echo code)"
RUN_ASSISTANT_CHECKS=1
AUTH=(-b "$COOKIES") # what authenticated requests carry; replaced below in the per-person mode
ORIGIN="$(printf '%s' "$BASE_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
echo "--- Assistant access ---"
if [[ "$AUTH_MODE" == "broker" ]]; then
  # Per-person sign-in is Google in a browser: a script cannot do that. VERIFY_PERSON (the email of a signed-in person, ideally an
  # administrator, so the diagnostics can run) gets a short session minted ON THIS HOST (audited, 15 minutes), used for these checks only.
  if [[ -n "${VERIFY_PERSON:-}" ]]; then
    MINTED="$(docker exec numz-assistant-production node server/cli/aiAdmin.js mint-session "$VERIFY_PERSON" 2>/dev/null | tail -1 || true)"
    if [[ -n "$MINTED" ]]; then
      read -r COOKIE_NAME COOKIE_VALUE CSRF < <(printf '%s' "$MINTED" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['cookieName'], d['cookieValue'], d['csrf'])")
      AUTH=(-H "Cookie: $COOKIE_NAME=$COOKIE_VALUE" -H "X-CSRF-Token: $CSRF" -H "Origin: $ORIGIN")
      echo "per-person sign-in: yes; a 15 minute session was minted on this host for $VERIFY_PERSON"
    else
      echo "per-person sign-in: yes; could not mint a session for $VERIFY_PERSON (has that person signed in once?): the DeepSeek and chat checks are SKIPPED"
      RUN_ASSISTANT_CHECKS=0
    fi
  else
    echo "per-person sign-in: yes; set VERIFY_PERSON=<email> to run the DeepSeek and chat checks, which are SKIPPED"
    RUN_ASSISTANT_CHECKS=0
  fi
elif [[ "$AUTH_REQUIRED" == "True" ]]; then
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
  curl -sk "${AUTH[@]}" "$BASE_URL/api/v1/health/deepseek" | python3 -m json.tool
  echo

  echo "--- Chat test ---"
  SID=$(curl -sk "${AUTH[@]}" -X POST "$BASE_URL/api/v1/assistant/sessions" \
    -H 'Content-Type: application/json' -d '{"metadata":{"verify":true}}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")
  CHAT=$(curl -sk "${AUTH[@]}" -X POST "$BASE_URL/api/v1/assistant/sessions/$SID/chat" \
    -H 'Content-Type: application/json' -d '{"message":"Hello Numz"}')
  echo "$CHAT" | python3 -m json.tool
  echo
fi

echo "--- Audio health ---"
# The speech service answers only callers that hold its key (AUDIO_SERVICE_KEY in .env.secrets); read here, never printed.
AUDIO_KEY="$(grep -E '^AUDIO_SERVICE_KEY=' "$ROOT/.env.secrets" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [[ -n "$AUDIO_KEY" ]]; then
  curl -sk -H "X-Audio-Key: $AUDIO_KEY" http://127.0.0.1:8765/health | python3 -m json.tool
  echo "without the key: HTTP $(curl -sk -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/health) (expected 401)"
else
  curl -sk http://127.0.0.1:8765/health | python3 -m json.tool
  echo "WARNING: AUDIO_SERVICE_KEY is not set: the speech service answers anyone who can reach it"
fi
echo

echo "--- Frontend ---"
curl -sk -o /dev/null -w "HTTPS frontend HTTP status: %{http_code}\n" "$BASE_URL/"
echo
echo "=== Verification complete ==="
