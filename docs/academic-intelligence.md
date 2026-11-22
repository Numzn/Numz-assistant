# Academic Intelligence & Memory Lanes

NUMZ AI as a study partner, inside the one NUMZ AI that already exists: a person can open a **study session**, give NUMZ AI their **own course
notes** (text or markdown), let it **read questions from their screen** (desktop app only), and get **explanations grounded in their notes**, with
the sources shown. Branch `feature/academic-intelligence`; **not merged, not pushed, not deployed.**

There is no second assistant, no second login and no second conversation store. Answers join the conversation that is open; the Study panel is a
panel of the same page.

## What a person does

1. Open **Study** (header). Add a course and some notes under **Materials** (`.md` / `.txt`; a lecture they recorded in NUMZ AI can be added too).
2. **Session** tab: say what kind of session it is: **Study**, **Practice** or **Restricted assessment**. Optionally choose the course and a topic.
3. In the desktop app only: tick **Read my screen while I study**, optionally list words (an app or window title) that must never be read.
4. NUMZ AI finds questions on the screen and lists them in the panel. **Explain** answers one (or turn on "explain questions it finds
   without asking me"). Or type a question in the box. The answer goes into the conversation with the sources it used.
5. Tell it what helped (**Helped / Didn't help / Simpler / Deeper / Something is wrong / Keep as a note**). That, and only that, is what it
   learns about how they learn.
6. **Memory** tab: everything it keeps, to change, export or delete.

A **restricted** session is an assessment that does not allow help: NUMZ AI does not read the screen and does not answer questions. It will only
explain a *named concept* in general terms (and refuses anything that looks like a pasted question).

## The six memory lanes (a facade, not a new store)

| Lane | Where it lives | Notes |
|---|---|---|
| Profile | `ai_user_settings.settings_json` | writing style, level, approach, adaptive-learning switch |
| Academic | the same settings + `academic_courses` | courses, programme, year |
| Knowledge | `academic_documents`, `academic_chunks` (+ FTS5) | the person's text and markdown, searched per course |
| Conversation | the existing saved conversations | unchanged |
| Experience | `learning_experiences` | what helped / what was hard, with confidence and evidence |
| Session | `academic_sessions` + in-memory runtime | the current study session; ended ones are purged after 14 days |

`GET /academic/memory` shows all six; `DELETE /academic/memory/lane/:lane` and `DELETE /academic/memory?confirm=all` delete them;
`GET /academic/memory/export` downloads them. Conversations are never touched by "delete everything academic".

## How an answer is made

`responseEngine.js` writes **one explicit system message per answer** (never the voice persona): the writing profile
(`natural_student_academic` by default), the kind of task (define, explain, discuss, compare, analyse, evaluate, calculate, multiple choice),
the evidence found, and what is known about how this person learns, in this priority: what they just asked or corrected; the task and the
assessment rules; their own materials; research; their preferences; what happened before; general knowledge.

* **Materials and the screen are data, not instructions.** They are fenced (`<question>`, `<source id="S1">`, `<student_note>`,
  `<learning_notes>`) and the prompt says so; anything in them that looks like one of our fences is neutralised first.
* **Citations are verified, not trusted.** The model may cite only the labels it was given (`[S1]` course material, `[R1]` research); a label it
  was not given is removed, and the **Sources** list shown to the person is built from our own records of those sources, with the document and
  the lines they came from.
* **Grounding is reported honestly**: from your course materials / research / both / general knowledge.
* **Retrieval** (`knowledgeService.retrieve`) searches the chosen course. Another of the person's courses is searched only when named, with a
  stated reason that travels with the evidence. Another person's course cannot be named into a search.

## Integrity: the application decides, the model does not

`integrity.js` is a gate in code that runs before any model or screen read. The person **declares** the session type; NUMZ AI **cannot verify**
that an exam is an exam (a screenshot cannot prove it), so:

* **Restricted:** no capture is accepted (a database trigger also refuses to enable it), `ask` is refused, only `explain_concept` and feedback
  are allowed, and the concept must be a short phrase.
* **Study / Practice:** a question the reader flags as looking like an assessment (`assessmentSignals`: "closed book", "do not use notes", an
  invigilator instruction...) is **not answered until the person confirms it is practice**, or ends the session. The signals are advisory.
* The session type is **permanent** once the session starts (a trigger enforces it); a new session is needed to change it.
* A session that ends (time, restart, "End session") ends reading everywhere.

## Hybrid screen reading: local first, then selective cloud

| Half | Where | What it does |
|---|---|---|
| Local | the desktop app (Rust, `numz-capture`) | every 1.5–30 s (default 2.5) takes ONE still, compares a 32×18 luminance signature, and reports a picture only when the screen has changed **and settled**; at least 10 s between pictures |
| Exclusions | the desktop app | **before** any picture: if a password manager, a sign-in/verification/private-browsing window or any window the person listed is open, no picture is taken at all |
| Cloud | the server (`captureService.js`) | integrity gate, capture switch, image checks (≤ 4 MB, ≤ 36 MP), 8 s between reads, 80 reads per session, duplicate-picture hash, metered as `academic_read` |

The watcher is visible: the panel indicator reads **"Study · screen reading ON"**, and the app window's title says **"NUMZ AI - study session,
screen reading ON"** (paused: "study session paused"). A **dead-man switch** stops the watcher by itself if the page stops asking for results for
20 s (a closed or crashed page cannot leave it running). It never simulates input, takes no video, and writes nothing to disk. The picture is
discarded as soon as it is sent. It starts only where windows can be listed (X11, Windows, macOS), **not on Wayland**, where the desktop's own
portal prompt would be needed for every picture.

A reload turns screen reading **off**: the person has to turn it on again.

## Research (optional per session)

OpenAlex search and Crossref DOI verification, fixed hosts only, with a minimal derived query (never the whole question or any of the person's
notes); each result is labelled `[R1]…` and **verified** against Crossref before it can be cited. A per-person daily allowance (default 40)
applies; an outage never fails an answer. `ACADEMIC_RESEARCH=off` disables it on a server.

## What it learns (`learningMemory.js`)

Only from feedback the person gives, and only while **Learn from my feedback** is on (off: nothing is recorded or used).
A first observation is *tentative*; the same difficulty twice within 30 days becomes *needs practice*; two helpful explanations after a difficulty
make it *improving*. A lesson is *established* with ≥ 3 pieces of evidence and confidence ≥ 0.7 (a difficulty needs 4); an established lesson that
is contradicted becomes *needs reassessment* instead of being overwritten. A correction from the person outranks everything. Each can be forgotten.

## Server API

All under `/api/v1/assistant/academic`, behind `access.requireSession('academic')`: a **real signed-in person** is needed (the shared access code
gives no identity, so it is refused). State-changing calls carry the session's CSRF token like the rest of the app.

| Route | |
|---|---|
| `GET/PUT /profile`, `GET/POST /courses`, `PATCH/DELETE /courses/:id` | profile and courses |
| `GET /courses/:id/documents`, `POST /courses/:id/documents?title=&type=` | the body **is** the text (`text/markdown` or `text/plain`, ≤ 2 MB); a changed re-upload is a new version |
| `POST /courses/:id/documents/from-meeting`, `GET /meetings` | a finished lecture of your own as course material; the list to choose from |
| `DELETE /documents/:id`, `GET /search?course=&q=` | |
| `POST /sessions`, `GET /sessions/current`, `PATCH/…/pause/resume/stop` | study sessions |
| `POST /sessions/:id/captures` (the picture is the body), `GET /sessions/:id/questions` | the screen |
| `POST /sessions/:id/questions/:qid/answer`, `/ask`, `/concept` | answers |
| `POST /feedback`, `GET /progress` | learning |
| `GET /memory`, `GET /memory/export`, `DELETE /memory/lane/:lane`, `PATCH/DELETE /memory/experiences/:id`, `DELETE /memory?confirm=all` | the Memory Centre |
| `POST /research` | scholarly lookup |

Refusals carry stable codes the page acts on (`restricted-assessment`, `confirm-required`, `session-paused`, `session-ended`,
`capture-rate-limited`, `daily-limit`, `cross-course-needs-reason`, `document-too-large`, `storage-full`, ...) and plain messages.

## Limits

100 documents per course, 300 per person, 8 million characters per person; a document ≤ 600 000 characters / 3 000 parts; a study session
lasts at most 4 hours. Daily allowances (`academicReadsPerDay`, `academicAnswersPerDay`) are per role (viewer 120/150, operator 300/400,
admin 600/800) and the emergency pause (`aiAdmin pause academic`) stops both. Spend is metered (`academic_read` priced as vision).

## Privacy

* Everything is owned by the signed-in person: every statement filters on the owner, and database triggers refuse a course/document/session that
  crosses owners. Another person's id is "not found".
* **Pictures** are never stored: sent to the vision model, read, dropped. A recognised diagram is kept in memory for 2 minutes at most.
* **Logs** carry ids, kinds and sizes: never a picture, a question, an answer or a note.
* **Sent to the AI provider:** the question text, the passages retrieved from the person's notes, and (if used) the research abstracts. Nothing
  from other courses unless the person named them. The picture goes to the vision provider the Smart Camera already uses.
* Meetings now have an owner (`meetings.owner_user_id`). Meetings made before 2026-11-21 have none, so they are invisible to academic
  features until a host claims them: `node server/cli/aiAdmin.js meetings list|claim <person>`.

## Verification (what was and was not shown)

| | |
|---|---|
| `npm test` | 1190 passing (server, repositories, identity, routes, page logic) |
| `cargo test --workspace` (Linux) | passing, incl. the watcher's 26 tests (change detection, exclusions, dead-man switch, pause, pacing) |
| Real Chromium, real server, real numzlab-auth broker | `node scripts/academic-e2e/run.mjs`: 33/33 — Study panel end to end, restricted behaviour, no leakage between two people, delete-everything, phone width |
| Real desktop app on X11 (Xvfb + openbox), real server and broker | `node desktop/e2e/study.mjs` (see `desktop/README.md`) (23 checks) — pictures taken only while reading; none with a password manager or a listed window open; none while paused or after Stop; the watcher stops itself when the page goes away; a restricted session never reads; focus, pointer and stacking untouched |
| **Not verified** | Windows and macOS capture/watcher (only type-check), Wayland, a real vision/text model, the live OpenAlex/Crossref services, a real phone, a real person's screen |

The model in every test is a stand-in: answer *quality* is unmeasured. The wording rules (natural student writing, citing only given sources) are
prompt instructions plus the citation check; they are not a guarantee of tone.

## Rollout notes

Migrations 8–10 are additive (older images ignore the new tables). The release needs `CAMERA_VISION_*` configured (already is) and per-person
sign-in (already is). The desktop app must be rebuilt for the new watcher commands. Nothing here is deployed.
