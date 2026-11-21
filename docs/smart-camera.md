# Smart Camera

Point a phone at a practice question on another screen. The question is read off the picture, answered with the
working shown, and the camera goes back to waiting for the next one. Open it from **Smart Camera** in the sidebar
(`/camera.html`). Built on branch `feature/smart-camera`; **not merged, not deployed**.

## Flow

```
READY -> QUESTION_DETECTED -> CAPTURING -> EXTRACTING -> ANALYSING -> ANSWER_READY -> WAITING_FOR_NEXT
```

plus `IDLE` (camera off), `STARTING`, `AWAITING_CONFIRMATION` (review mode: the question waits for a tap), `PAUSED`
and `ERROR`. The state machine is `src/interfaces/camera/cameraSession.js`; it has no screen, camera or network of its
own, so it is tested with scripted ones.

1. **On the phone** (`frameAnalysis.js`, `cameraSession.js`): the live preview is sampled about four times a second at
   160x120 grayscale. A picture is considered only when the camera has held still for 0.7 s, the scene looks like
   text, and 2 s have passed since the last one.
2. **Read** (`POST .../read`): the picture (JPEG, at most 1568 px on the long side) goes to the vision provider, which
   returns the question as JSON (text, options, type, subject, whether it needs a figure, confidence). The question is
   validated: not a question, too little text and low confidence are refused with a reason and nothing is answered.
3. **Same question?** (`questionIdentity.js`): the text is normalised (case, numbering, punctuation, maths symbols)
   and compared with the session's earlier questions. Numbers and option letters must match exactly; the rest must be
   96% alike. A match is reported as a duplicate with the answer it already has: no model is asked again.
4. **Answer** (`POST .../answer`): the configured text model (DeepSeek in production) gets the question inside
   `<question>` markers with its own prompt, and returns structured JSON: answer, steps, explanation, confidence
   (high/medium/low) and what it is unsure of. Maths is plain-text steps. A reply that is not JSON is shown as text with
   low confidence and a note. A question that depends on a figure is answered by the vision model with the picture
   (kept in memory for 2 minutes for that, then dropped); if the picture has expired the answer is capped at medium
   confidence and says it could not see the figure.
5. **Saved**: each answered question is saved as an ordinary assistant conversation whose id is the camera session id,
   so it appears in Conversations and can be deleted there. Only text is saved, never a picture.

Review mode (the switch on the page, remembered per device) stops after step 2 and shows the question, editable, with
Answer / Skip. Automatic mode (the default, as chosen) goes straight on. "Capture now" reads what the camera sees now,
steady or not.

## Server API (all behind the assistant's access gate, nothing cacheable)

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/v1/assistant/camera/sessions` | `{}` | `201 { sessionId, visionConfigured, limits }` |
| `POST .../sessions/:id/read` | the picture itself, `Content-Type: image/*` | `{ status: 'new'\|'duplicate'\|'not-a-question'\|'unclear', ... }` |
| `POST .../sessions/:id/answer` | `{ questionId, text? }` (text = the person's correction) | `{ status: 'answered', questionId, answer, markdown, cached? }` |
| `DELETE .../sessions/:id` | | `204`; idempotent; removes the session and the saved conversation |

Error codes the page acts on: `vision-not-configured`, `session-limit`, `image-too-large`, `invalid-image` (permanent);
`session-not-found` (the page starts a new session), `camera-rate-limited` (429 + `Retry-After`), `camera-busy`,
`read-failed`, `answer-failed`, `question-not-found`, `invalid-question`.

## Turning it on

The page opens without any of this, but cannot read pictures. In `.env.secrets` (the key never goes in `.env`):

| Setting | |
| --- | --- |
| `CAMERA_VISION_PROVIDER` | `anthropic` or `openai-compatible` |
| `CAMERA_VISION_API_KEY` | the provider's key |
| `CAMERA_VISION_MODEL` | a model that accepts pictures. No default on purpose: it sets what each picture costs and how well glare is read |
| `CAMERA_VISION_BASE_URL` | optional for `anthropic` (a gateway); required for `openai-compatible` |

Answers use the assistant's existing text model (`AI_PROVIDER`). The start-up log says which settings are missing, never
a value.

## Limits (all in `CAMERA_LIMITS`, `server/camera/cameraService.js`)

100 pictures per session, 1.5 MB per picture, one read per 2 s per session, 2 reads at once across the server, 20
live sessions (the idlest is dropped), a session expires after 30 minutes idle, every model call has a 40 s deadline.
On the phone: the camera switches itself off after 5 minutes with nothing new (also when paused), and a hidden page is
paused.

## Privacy

- The camera opens only when **Start camera** is pressed. The indicator on the preview always says *Camera off*,
  *Scanning*, *Scanning · picture sent to be read*, *Paused · nothing is sent*, or why it is not scanning.
- While scanning, each picture is sent to the configured vision provider (a third party) and is not kept by this app.
  The page says so, and says to use it only on material you are allowed to capture, not in exams that forbid help.
- Hidden page: paused. Page closed: camera released. Camera taken away by the OS: stopped, with a message.
- Logs carry ids, statuses and counts only: no picture, question, answer, or upstream error text.
- **Clear history** (two taps) deletes the session and its saved conversation on the server.

## What is and is not verified

Verified: 900 Node tests (the camera adds about 190: frame analysis, state machine, question identity, model-reply
parsing, the service, the routes with the real browser client over a real socket, the vision adapters against a fake
`fetch`, the presenter); the production build within a bundle budget (25 KB gzipped for the camera page); and
`scripts/camera-e2e/run.mjs`, 31 checks in real headless Chromium against the production build and its security headers,
with a fake camera feed and stub models (no console or CSP errors).

**Not verified, and why it matters:**

- **No live vision call has ever been made.** The Anthropic and OpenAI-compatible request shapes follow the public docs
  and are pinned by tests, but only a real key and one real call will show they are accepted, and how accurately a phone
  photo of a screen (glare, moire, tilt) is read.
- **No real phone has run it.** Switching camera and the torch are written defensively and untested on hardware. The
  frame thresholds (still, text-like, 0.15 "looks different") are unmeasured defaults.
- **The phone cannot tell two questions in one layout apart.** Measured on 18 rendered quiz screens with simulated hand
  wobble: "12 + 7" and "13 + 7" differ by 0.003 (below sensor noise); a page jostled by a hand reaches 0.5 to 0.75. So
  "looks unchanged" is never treated as "already seen": it only slows re-checking (15 s, 30 s, then every 60 s), and the
  server's text comparison decides. A change the phone cannot see is therefore picked up within about a minute at the
  worst, or at once with Capture now. A re-check that finds nothing costs one read and does not keep the camera on.
- Moire, glare and very small text were only measured with a local OCR spike (before the vision model was chosen).

## Before it can ship

1. **Lock the assistant API.** `ASSISTANT_ACCESS_CODE` is unset in production, so these routes (and the vision key
   behind them) would be open to anyone who can reach the server. Set a code of at least 12 characters first.
2. A vision provider, key and model (see above), and a decision on cost: every picture sent is a paid call.
3. A rebuilt image (the page is a third Vite page; nothing else about the build changes).
4. One real test on a real phone over https (cameras need a secure page; `localhost` or the tailnet https name).

## Running the browser check

```bash
npx vite build
CAMERA_E2E_DIR=/tmp/camera-e2e FFMPEG=/path/to/ffmpeg node scripts/camera-e2e/run.mjs
```

It writes the uploaded picture and screenshots (phone and desktop sizes) to `CAMERA_E2E_DIR`.
