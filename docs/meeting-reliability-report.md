# Meeting reliability: delivery report (2026-10-10)

Branch `feature/meeting-reliability`, 7 commits on top of `main` (`f0ed1f8`), **local only**: not pushed, not merged,
not deployed. Nothing in production was changed, restarted, migrated or written to.

Labels used below: **tested** = a test that ran and passed in this session; **observed** = seen directly in a
real run; **unverified** = code exists, nothing has exercised it for real.

## 1. Audit findings and evidence

Corrections to the brief: the sidecar is **Flask + flask-sock**, not FastAPI; the product had **no tab or system
capture** at all; there is **no CI**; reconciliation is **not overlap-aware**; the sidecar listens on `0.0.0.0:8765`.

| # | Finding (ranked) | Evidence | Status |
|---|---|---|---|
| 1 | Any error frame from the speech service ended the whole recording: one refused line stopped the microphone and lost everything said afterwards | `liveSpeechClient.js` dropped the error `code`; `meetingController` treated every error as fatal. Reproduced red-before-green in `tests/meetingController.test.js`, `tests/liveSpeechClient.test.js` | fixed, **tested** |
| 2 | "Start the meeting" could only open a panel and ask for the launch code; the code sat in `sessionStorage` | `meetingCommands.js`, `meetingPanel.js` | fixed, **tested** |
| 3 | The meeting client never resumed its `AudioContext`. A start without a click could record silence under a "Recording" label | `liveSpeechClient.js` | fixed, **tested** against fakes |
| 4 | No notion of capture source, and a source that ended mid-meeting produced silence while the UI said "Recording" | `liveSpeechClient.js` held one `getUserMedia` stream and never listened for `ended` | fixed, **tested** against fakes |
| 5 | No client-side backpressure: a stalled connection grew `WebSocket.bufferedAmount` without bound | `liveSpeechClient.js` | fixed, **tested** |
| 6 | Nothing compared a transcript with what the assistant had just said | `voiceOrchestrator.js` | added, **measured on a synthetic corpus** (section 5) |
| 7 | Meeting intelligence was unreachable and ungrounded; the rolling tracker discarded segments ingested while the model was working | `rollingIntelligenceService.js` (`pendingSegments = []` after the await), no route | fixed, **tested** |
| 8 | `errorHandler` turned every 5xx, including declared ones, into a generic 500 | `server/http/errorHandler.js`; its own comment promised 503 messages | narrowed fix, **tested** |

**Not fixed (and why):** the assistant server keeps generating an interrupted reply (assistant stream, outside this
mission; the client works around it); the assistant API is open when no access code is set (a production
configuration, not mine to change); the sidecar has no authentication and listens on all interfaces (host/network
configuration); frames carry no sequence numbers, so the server cannot detect client-side drops (needs a protocol
change and a sidecar restart); reconciliation does not model overlapping speakers (no diarization on the live path).

## 2. Implementation decisions and rationale

- **Launch session = server-set HttpOnly cookie, not a stored code.** The code never reaches page scripts; rotating
  the launch code or the ticket secret voids every session; it authorises starting a meeting and nothing else; a wrong
  code is throttled exactly as before and the cookie is not a guessing path. Rejected: keeping the code in
  `localStorage` (readable by any script), a long-lived bearer token (a second credential type to manage).
- **Voice start reuses the existing controller and server launch.** No new endpoint. The reply is built from the
  controller's state after `start()` returns, so it never claims a recording or a save the server did not confirm.
- **`Idempotency-Key` per start attempt**, kept when the outcome is unknown (network error, 5xx) and dropped after a
  definitive refusal, so a lost answer plus a retry returns the same meeting.
- **Capture sources resolved in the browser, mixed into the one stream.** One stream keeps the server's timeline,
  persistence and integrity model unchanged. Per-source separate sessions would give real speaker evidence but
  need concurrent-session semantics on the timeline; not attempted. A refused source in "both" is reported as
  NOT recorded while the other carries on; it is never silently dropped.
- **No silent degrade, no silent success:** every source state is shown, and every source ending is an error.
- **Echo guard is text-only and conservative** (threshold 0.7, 1.5 s window, interruption words always kept),
  because ignoring a person is a worse failure than answering an echo. It can be switched off.
- **Intelligence from the saved transcript only, behind the admin token.** The caller names a meeting; text is never
  accepted. Notes are refused until the transcript is `verified`.
- **Only deterministic findings can be `confirmed`.** A model's reading is at best `inferred`.

## 3. Files

Created (12): `src/interfaces/voice/captureSources.js`, `src/interfaces/voice/selfEchoGuard.js`,
`server/intelligence/meetingSignals.js`, `server/intelligence/grounding.js`,
`server/services/meetingIntelligenceService.js`, `tests/captureSources.test.js`, `tests/selfEchoGuard.test.js`,
`tests/meetingIntelligence.test.js`, `server/api/meetingLaunchClient.test.js`,
`server/api/meetingIntelligence.test.js`, `server/api/errorHandler.test.js`, `docs/meeting-intelligence.md`
(and this report).

Changed (25): `server/auth/meetingAuth.js`, `server/routes/meetings.js`, `server/server.js`,
`server/services/meetingSessionService.js`, `server/services/rollingIntelligenceService.js`,
`server/http/errorHandler.js`, `src/interfaces/meeting/{meetingApi,meetingController,meetingPanel,liveSupport}.js`,
`src/interfaces/commands/meetingCommands.js`, `src/interfaces/voice/{liveSpeechClient,voiceOrchestrator}.js`,
`src/main.js`, `src/config/settings.js`, `index.html`, `style.css`, `docs/meeting-lifecycle.md`,
`docs/voice-self-echo.md`, and tests `tests/{liveSpeechClient,meetingApi,meetingCommands,meetingController,voiceOrchestrator}.test.js`,
`server/api/meetingLaunch.test.js`.

Removed: none. **No Python was changed**, so the sidecar needs no restart for this branch.

## 4. Tests run (exact)

| Command | Result |
|---|---|
| `npm test` (Node: server/meetings, persistence, auth, websocket, api + tests/) | **526 passed, 0 failed, 0 skipped** |
| `audio/.venv/bin/python -m unittest discover -s tests -t .` (in `audio/`) | **213 tests OK (7 skipped)**; no Python changed, same code as `main` |
| `npx vite build` | built, no errors (existing chunk-size warning only) |

Red before green: items 1 and 2 server tests failed on `main` first (10 server, 4 client). Mutation checks (change
the code, watch the named test fail, restore): client idempotency header removed -> lost-response test fails; no
backpressure -> backpressure test fails; no mix gain -> mixing test fails; "all sources ended" never errors ->
ended test fails; echo guard off -> both echo tests fail.

## 5. Audio-quality and self-echo measurements (with conditions)

**No real-audio quality measurement was made in this mission.** There is no microphone on the build host, and the
user's browser cannot reach a local server. The level-monitor thresholds (RMS 1e-4, "no sound yet" after 8 s,
"quiet" after 20 s) and the mix gain 0.7 are **unmeasured defaults**.

Self-echo transcript guard, **synthetic corpus** (`tests/selfEchoGuard.test.js`, deterministic, seeded; written text
with simulated recognition slips, not recordings): 68/72 of the assistant's own speech caught (exact, prefix,
suffix and middle 12/12 each; noisy 9/12; noisy fragment 11/12); **0/36** unrelated user utterances dropped;
**0/36** overlapping or quoting utterances dropped; **3/3** word-for-word repeats of its instructions 1 s after it
stopped **are** dropped (the known cost). Threshold sweep 0.4 to 0.9 is in `docs/voice-self-echo.md`.
Conditions that matter and were not tested: real TTS audio, a real room, a real recognizer.

## 6. Timestamp, persistence, reconciliation and verification results

Unchanged by design: segment identity, the meeting timeline offsets, idempotent insert, `computeIntegrity`
(VERIFIED / INCOMPLETE / INCONSISTENT / OPEN / UNVERIFIED) and the rule that `/end` refuses while a session is
open or lines are missing. Existing suites for these pass (Node 526, Python 213).

New and **tested**: a repeated launch is the same meeting (no duplicate), including after a lost answer, over real
HTTP; a refused or failed line is shown as "not saved" and the meeting is not reported verified; intelligence states
`verified | unverified | incomplete | open` from the same integrity report and is provisional unless verified.

**Gap, stated plainly:** audio dropped by the new client backlog bound is counted and shown in the panel, but the
server cannot see it (no sequence numbers), so `verified` on the server means "every line the service produced was
stored", not "every sound was transcribed". The meeting panel is the only place the gap is visible.

## 7. Security review and remaining risks

- Launch cookie: `HttpOnly`, `SameSite=Strict`, `Path=/api/v1/meetings`, `Secure` over https, HMAC-signed with a key
  derived from the launch code and the ticket secret, constant-time compared, carries no secret. **Risk:** a session
  cannot be revoked individually; a copied cookie can start meetings (not read, end or list anything) for up to
  8 h or until a secret is rotated.
- **Risk:** any speech that parses as exactly "start the meeting" starts one while the browser is unlocked. The
  command must be the whole utterance; recording is visible in the panel; duplicate starts are blocked.
- New admin-only routes; a meeting ticket is refused on both (**tested**). `POST .../intelligence/notes` sends the
  transcript to the configured AI provider: a deliberate request, but the transcript leaves this server.
- `errorHandler` now exposes the message of **our own** domain errors on 5xx (up to 200 chars of a provider message
  for the notes route). Non-domain 5xx stay generic (**tested**).
- Secrets: the launch code, admin token and tickets are never put in a URL or page-visible storage by this change;
  the old `sessionStorage` copy is cleared.
- **Operational accident, disclosed:** while stopping my local test server I ran `pkill -f "node server/server.js"`,
  which also matched the root-owned production server process. The OS denied the signal (not my user); production
  health stayed 200 and its PID unchanged. I should have killed by PID.

## 8. Known limitations and unverified scenarios

- **Unverified in a real browser:** the launch cookie, the source selector and indicators, `getDisplayMedia` (the
  picker, tab and system audio, stopping the video track while keeping audio), AudioContext resume without a
  gesture, voice start end to end. Chrome here runs on the user's Windows machine, which cannot reach a local
  server.
- **Unverified with real audio:** every threshold in section 5; mixed mic+tab audio quality; duplicate voices with
  speakers.
- Whole-system audio is only offered by some browsers (Chrome/Edge on Windows); elsewhere only a tab can be shared.
  Sharing needs a click, so voice always uses the microphone.
- A real model has not been run through the notes route; grounding is lexical (it cannot tell a true claim from a
  plausible false one that reuses the cited words).
- The word-pattern findings are English-only surface patterns.
- Live transcripts carry no speaker labels, so owners are rare by design; no speaker is ever guessed.
- The echo guard drops a user who repeats three or more of the assistant's words in order within 1.5 s.
- The rolling tracker is fixed but still not fed by any live meeting.

## 9. Run and test locally

```bash
cd /srv/projects/Numz-assistant/.claude/worktrees/meeting-reliability
npm test                                   # Node suites (526)
(cd audio && /srv/projects/Numz-assistant/audio/.venv/bin/python -m unittest discover -s tests -t .)
npx vite build
node --test tests/selfEchoGuard.test.js    # prints the measured echo table as diagnostics
node --test server/api/meetingLaunchClient.test.js   # browser code against the real server router
```

For a real-browser check: `npm run dev` and `npm run dev:audio` on a host the browser can reach (a tunnel as in
`docs/meeting-lifecycle.md`), set `MEETING_LAUNCH_CODE` for the dev server only, and use a **dev** `MEETING_API_URL`
so test meetings are not written to production.

## 10. Production verification steps, awaiting explicit approval

Nothing below has been done. Each needs a separate go-ahead:

1. Review and merge `feature/meeting-reliability` (small commits; revert-able individually).
2. Build and deploy the app image (no sidecar restart: no Python changed). Tag the running image first for rollback.
3. Check: `GET /api/v1/health` shows `meetings.launch.enabled`; `GET /api/v1/meetings/launch/session` answers
   `{available:true, authenticated:false}`; the two intelligence routes answer 401 without the admin token.
4. Supervised manual run by the user, from their own browser: type the code once; stop; say "start the meeting";
   confirm the panel shows Recording and the first lines say saved; try tab audio and "both"; close the shared tab
   and confirm the panel says so; stop and confirm "saved and verified".
5. `GET /:id/intelligence` for that test meeting; then, only if wanted, `POST .../intelligence/notes` (sends the
   transcript to the AI provider).
6. Leaves one test meeting in production (closed meetings cannot be deleted through the API).
