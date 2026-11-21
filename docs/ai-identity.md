# NUMZ AI 2.0 — sign-in, private workspaces, limits

One identity authority, two applications, two sessions. NUMZLAB (`numzlab-auth`) decides **who a person is** and **whether they are approved**
(Google sign-in, the invited-people list, roles, suspension). NUMZ AI keeps **its own session, its own data and its own limits**. Signing out of
one never signs out of the other, and NUMZ AI works with no NUMZLAB dashboard session at all.

## How a person gets in

```
https://lab.numz.site/ai/   (one site; /ai/ is NUMZ AI, everything else is the dashboard)
 1  NUMZ AI shows "Continue with Google"             GET /ai/auth/login     sealed one-time state + PKCE challenge kept in a short cookie
 2  -> numzlab-auth /auth/broker/authorize           redirect address must equal the registered one exactly; PKCE S256 only
 3  -> Google (account chooser) -> numzlab-auth      the same approval as the dashboard; NO dashboard session is created
 4  <- /ai/auth/callback?code=…&state=…              a 60-second, single-use code
 5  NUMZ AI's SERVER -> numzlab-auth :18792          swaps code + client secret + PKCE verifier for a signed statement (the browser never sees it)
 6  NUMZ AI creates ITS OWN session                  cookie numzai_session: HttpOnly, Secure, SameSite=Lax, Path=/ai; only its hash is stored
```

* **Session:** idle limit 60 min, total lifetime 8 h (`AI_SESSION_IDLE_S`, `AI_SESSION_MAX_S`), a new session on every sign-in.
* **Suspension/removal at NUMZLAB:** NUMZ AI asks `numzlab-auth` whether the person is still approved at most every 60 s while they use it
  (`AI_REVALIDATE_S`). If not, every session ends and every open socket is closed within seconds. If NUMZLAB cannot be reached the last answer
  stands for 10 minutes (`AI_REVALIDATE_GRACE_S`), then access stops: it never fails open. A role change applies without signing in again.
* **Eligibility:** every approved, active NUMZLAB account (permission `ai.use`, minimum role viewer). What each role may do inside NUMZ AI is
  `server/auth/rolePolicy.js`: all roles may chat, speak, use the camera and see their own usage, with allowances that grow with the role; only
  administrators see everybody's usage (counts and money, never text), end someone's NUMZ AI sessions, pause the AI and run diagnostics.
  **Nobody, an administrator included, has a route to another person's conversations.**
* **Private by construction:** every conversation, camera session and usage record has an owner; the store's statements all say
  `owner_user_id = ?` (`server/persistence/conversationRepository.js`), so a conversation that is not yours is "not found". Conversations that
  existed before people (16 at the time of writing) have no owner and are invisible to everyone until the host's administrator gives them to one
  person: `node server/cli/aiAdmin.js legacy claim <email>`.

## What protects what (every entry point checks for itself; Caddy is convenience, not the control)

| Entry point | Check |
|---|---|
| `/api/v1/assistant/*` (chat, stream, history, speech, state), camera | a valid session, the CSRF token and our own origin on every change, the person's capability and limits |
| WebSocket `/api/v1/assistant/ws` | our own origin, a valid session at the upgrade, closed when access ends, 64 KiB frames, a message rate |
| `/api/v1/live-speech` | the meeting ticket **and** a signed-in person on our own page |
| `/api/v1/admin/*`, `/health/deepseek`, `/audio-health` | the `ai.admin` capability (administrators) |
| `/api/v1/health` | public: says only that the server is up. Details: `/health/detail` (signed in) |
| meetings | tokens and tickets exactly as before; **starting** one from the browser needs only a signed-in person (see below) |
| speech service `:8765` | `X-Audio-Key` on every route including the WebSocket handshake (`AUDIO_SERVICE_KEY`) |

**Meetings start with your sign-in.** In per-person mode there is no launch code: a signed-in person (capability `meetings.launch`, held by every
role) presses Start meeting, or says "start a meeting", and it begins. The server's gate (`signedInLaunch` in `server/auth/meetingAuth.js`) lets a
request through only when the sign-in check in front of it has already set a real person on the request; the shared fallback owner and the
system worker do not count, a `MEETING_LAUNCH_CODE` that is still set is ignored (not accepted as a way in), and no launch cookie is ever issued.
The meeting records who started it (`metadata.launchedBy`: the NUMZLAB user id only, no name or email). The meeting still gets its own
short-lived ticket, which is what the speech connection and the end-of-meeting call use. Signing out, or being suspended at NUMZLAB, ends the
ability at once, because it is the live session that is checked every time. In the shared-code fallback mode (`ASSISTANT_AUTH_MODE=code`) the
launch code works exactly as before.

Cross-site: no CORS at all in this mode, `Origin` must equal `PUBLIC_ORIGIN`, the session cookie is `SameSite=Lax` on `/ai` only.
**Residual risk you chose:** `/ai/` shares an origin with the dashboard. A script injected into NUMZ AI could therefore call the dashboard as the
person. Mitigations in place: CSP `script-src 'self'`, no `innerHTML` anywhere in the page's code, DOM-only Markdown with a safe-link filter, the
dashboard's own 15-minute admin idle limit. Moving NUMZ AI to its own host later is configuration (`PUBLIC_ORIGIN`, `PUBLIC_BASE_PATH`), not code.

## Limits and cost control

Per person: requests a minute, concurrent answers, daily allowance (questions, camera reads, speech seconds), by role. Overall: concurrent model
calls, a per-call time limit, spending thresholds (per person per day, overall per day and month; warned at 80 %, refused at 100 %; they need the
`AI_PRICE_*` settings, otherwise tokens and counts are what is tracked). Every call writes one `ai_usage` row (who, kind, model, token counts, an
estimated cost, how it ended, how long): never text, pictures or audio. **Emergency stop:** `AI_KILL_SWITCH=on`, or
`node server/cli/aiAdmin.js pause [all|chat|voice|camera]` / an administrator's `POST /api/v1/admin/pause`; every paid call answers 503 `ai-paused`
before anything is sent. Settings: `.env.secrets.example`.

## Operating it (on the host)

```bash
docker exec numz-assistant-production node server/cli/aiAdmin.js users            # who has signed in, their role, live sessions
docker exec numz-assistant-production node server/cli/aiAdmin.js usage 7          # counts and cost per person, last 7 days
docker exec numz-assistant-production node server/cli/aiAdmin.js revoke-user ada@example.com
docker exec numz-assistant-production node server/cli/aiAdmin.js pause camera      # resume camera
docker exec numz-assistant-production node server/cli/aiAdmin.js legacy list | claim <email> | export <file> | purge --yes
VERIFY_PERSON=<admin email> BASE_URL=https://lab.numz.site/ai bash scripts/verify-deployment.sh   # mints a 15-minute session on this host
```

## Cut-over runbook (nothing below has been run in production; each step has a check and a way back)

Before anything: no meeting LIVE (`aiAdmin.js` is not needed: the guard in `docs/` of earlier deploys), back up `/data/speech.sqlite`
(`docker exec numz-assistant-production node -e "…VACUUM INTO…"` or the nightly copy), `auth.db` and `auth.env`
(`sudo cp -a /var/lib/private/numzlab-auth /srv/backups/manual/ai2-<date>/`), and tag the running image
(`docker tag numz-assistant-assistant-production:latest numz-assistant-assistant-production:deployed-<date>-before-ai2`).

1. **Merge both branches locally** (`infra/ai-broker` into the infrastructure checkout, `feature/ai-2-identity` into `main`). No push without your go.
2. **numzlab-auth** (root-owned directory): install `auth_api.py` (0644), `auth-admin.sh` (0755), `auth.env.example`, `README.md` and the tests with
   `sudo install`; `sudo auth-admin.sh broker-client add numz-ai --redirect https://lab.numz.site/ai/auth/callback --write-env /srv/projects/Numz-assistant/.env.secrets`;
   `sudo auth-admin.sh broker-client enable`; `sudo auth-admin.sh check-config`; `sudo systemctl restart numzlab-auth`.
   Check: `curl 127.0.0.1:18791/auth/me`, dashboard sign-in still works, `:18791/auth/broker/token` → 404, `:18792/auth/broker/user/aaaaaaaaaaaa` → 401.
   Back: `sudo auth-admin.sh broker-client disable` + restart (or reinstall the previous file); dashboard sessions are untouched.
3. **Speech service key:** add `AUDIO_SERVICE_KEY=<24+ random characters>` to `.env.secrets` (never print it); with **no meeting live**
   `systemctl --user restart numz-assistant-audio`; then recreate the app (step 4) so both hold the key. Check: `/health` with the key 200, without 401.
   Back: remove the line, restart both.
4. **NUMZ AI image:** build from `git archive` of the merge commit (the routine of earlier deploys), compare, smoke, then recreate
   (`docker compose -f docker-compose.production.yml up -d --force-recreate --no-build assistant-production`). It starts in **code mode**, exactly
   as today (the access code you have now), now also answering under `/ai/`. Check: `scripts/verify-deployment.sh`. Back: retag the
   `before-ai2` image and recreate.
5. **Dashboard service worker, then Caddy:** `dashboard/scripts/deploy-frontend.sh` (no restart). Let browsers pick it up (open the dashboard once).
   Then install the new `dashboard/Caddyfile` (backup `Caddyfile.pre-ai`), `docker exec numzlab-dashboard caddy validate …`, graceful `caddy reload`.
   Check: `https://lab.numz.site/ai/` shows the access-code card; the dashboard and `/cv` behave as before (`scripts/verify-deploy.sh --private`).
   Back: restore `Caddyfile.pre-ai`, reload (seconds).
6. **Turn on per-person sign-in for you only:** in `.env.secrets` set `ASSISTANT_AUTH_MODE=broker`, `PUBLIC_ORIGIN=https://lab.numz.site`,
   `AI_ALLOWED_EXTERNAL_IDS=<your NUMZLAB user id, from sudo auth-admin.sh users>`; recreate. Sign in with Google at `/ai/`; then
   `docker exec numz-assistant-production node server/cli/aiAdmin.js legacy claim <your email>`. Back: `ASSISTANT_AUTH_MODE=code` and recreate.
7. **Everyone NUMZLAB approves:** remove `AI_ALLOWED_EXTERNAL_IDS`; recreate. (Not before step 6 works for you with a real browser.)
8. **Close the old addresses:** install `platform-gateway/Caddyfile.ai-redirect-staged` as the gateway's Caddyfile and `docker/Caddyfile.moved` as the
   tailnet block, reload both; update the registry entry. Check: the old addresses redirect pages and answer 410 to the API. Back: restore the backups.
9. **After a quiet week:** the access code can go (or stay as the rollback). Rotate the OpenAI key that was pasted in chat and the NUMZLAB Google
   client secret (a standing item in numzlab-auth's own findings).

## Tests

`npm test` (server, page logic, the real-server end-to-end suite with `NUMZLAB_AUTH_DIR=<numzlab-auth checkout>`), `cd audio && python -m unittest
discover -s tests -t .`, `node scripts/ai-e2e/run.mjs` (real Chromium → real Caddy → real server → real numzlab-auth, camera and microphone included),
`node scripts/camera-e2e/run.mjs` and `unhappy.mjs` (the shared-code mode, in a real browser). In numzlab-auth: `python3 -m unittest discover -s tests`,
`tests/rehearse_caddy.py` (three real Caddy hops) and the service-worker tests (`npx vitest run src/pwa/sw.test.ts` in the dashboard frontend).
