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

When a study session has **Read my screen** on (desktop app only), reading is automatic from the screen to the answer. Nobody presses anything:

1. The person starts the session. The page asks the app's watcher to start (with the person's exclusions); the panel and the window title say
   "screen reading ON".
2. **Monitor.** Every **2.5 s** the watcher takes one look: it lists the open windows, and, only if none is excluded, captures one still of the
   screen and reduces it to a fingerprint.
3. **Detect changes.** The fingerprint is compared with the screen it **last reported** (see below). Nothing is sent for a screen that is the same.
4. **Wait for stability.** A difference means a **possible** new screen. It is not captured yet: the watcher waits until **two looks in a row
   agree** (the screen has settled), so a scroll, a page load or someone still typing is waited out.
5. **Capture.** A settled new screen is captured (kept in the app's memory) and counted, never closer than **10 s** to the last one.
6. The page collects it at its next check (about every 1.5 s, which is also the watcher's heartbeat), shrinks it (JPEG, at most 1600 px) and sends it
   to the server in the background, one at a time; the native copy is discarded at once. A screen the server cannot take yet (too soon, busy, a failed
   read, the network) is sent again after 4 s and 8 s, then let go; a newer screen replaces one that is waiting.
7. **Recognise content, identify boundaries.** The server runs the existing gates (integrity, capture switch, image checks, **8 s** between reads,
   **80** reads per session, identical-picture hash, the person's allowance) and asks the vision model **one question**: break the screen into
   **segments**, in reading order. A segment is any independent piece of meaningful content (a question, instructions, a paragraph, a heading,
   a list, a table, code, a formula, a figure), copied as shown, with its place on the screen, whether the edge of the screen cuts it off, and which
   group it belongs to. It is not tied to one kind of document: a page of notes, a slide, code or a web article yields segments just as a quiz does.
8. **Organise, suppress duplicates.** Each segment is matched against everything the session has already seen (the content ledger, below):
   **new**, **seen** (nothing to do), **grown** (more of it is visible now), or **continued** (it finishes one that an earlier screen cut off).
   Related segments stay related.
9. **Process, display.** Everything seen is listed in the Study panel ("Content seen in this session": each segment once, with how often it was
   seen). **Questions** among the new or completed segments become cards and are **answered** from the person's course notes (and the related content on
   screen) into the Study panel **and the conversation**, up to three per screen, one at a time. Other material is organised and shown; explaining it is
   one press ("Explain this"), because answering everything on every screen would spend a call per paragraph. A screen that may be an assessment is
   listed but not answered until the person confirms; "Explain the questions it finds, without me pressing anything" is on by default and can be turned off
   before the session starts.
10. The watcher keeps looking; the next change starts again at 2.

The content ledger (`contentLedger.js`) works from the **content**, never from a layout or a mode the person chooses, so the same rules cover:

| Situation | What happens |
|---|---|
| One segment on the screen, or several | each segment is recognised separately and matched on its own; the screen is "single" or "multiple" |
| Next / previous / tabs / slides | a different set each time: new content is new; a set that comes back is **seen**, so nothing in it is processed again (the screen is a "revisit") |
| Vertical scrolling | screens overlap: the overlap is seen, what appears is new; scrolling back is a revisit |
| Overlapping screens | overlap is decided per segment, never per screen: a segment is **never dropped because it overlaps** an earlier screen, and one that only resembles an earlier segment (other numbers, other words) is new |
| A segment cut off by the screen edge | it is held and marked as cut off (a cut-off question is listed but not answered by itself); when more of it is visible it **grows** in place; when its end is the start of the next screen's segment (shared words) the two become **one segment** without repeated words; if they share no words but are in the same group they are linked |
| Continuity | a segment that continues another keeps a link to it; related segments (one group, or one that names another by title) are passed to the answer as fenced data |
| Repeated content | text seen again (a misread letter tolerated, a different number not) is the same segment; an identical picture is stopped before any model is asked; a part of a known segment is seen |

Matching is by words and numbers (a segment is "the same" at about 94-96% likeness with identical numbers; a part must be found whole and in one
piece; a continuation needs 4 shared words when both screens marked the segment as cut at the join, 8 when only one did, 12 when neither did). When in
doubt it chooses **new**: reading something twice costs a little, missing it costs the person the content.

How a screen is judged to have **changed** (`detect.rs`):

* The still is reduced to a brightness plane (averaged down to at most 1280 px wide) and compared with the last reported screen in blocks of
  4x4 plane pixels by the **sum of the absolute brightness differences** in each block. An unchanged screen sums to exactly 0; one changed digit,
  word or token of code sums to hundreds, so edits to **numbers, text and code are not ignored** (proved on real anti-aliased text: `12 -> 13`,
  `abc -> abd`, `== -> !=`).
* **Stable** means two looks in a row with no block moved. **Unchanged** means a settled screen with no block different from the reported one.
* Things that move on their own are **learned and ignored**: a blinking caret, a ticking clock. A tile of the screen (a character or two across)
  that keeps moving by itself stops counting; a one-off edit, or the same place edited a few times, is never mistaken for that, and a change as big
  as a new page forgets what was learned. A once-a-minute clock is read a few times, then ignored.
* **This app's own window is left out of the comparison** (not out of the picture): counters, the "last read" line and answers arriving in the
  Study panel and the conversation would otherwise make every read cause the next. It needs the window's position, which Linux, Windows and macOS
  report.

| Half | Where | What it does |
|---|---|---|
| Local | the desktop app (Rust, `numz-capture`) | a look every 1.5–30 s (default **2.5**); one still per look, never video; reports a picture only for a changed **and settled** screen; at least **10 s** between pictures |
| Exclusions | the desktop app | **before** any picture: if a password manager, a sign-in/verification/private-browsing window or any window the person listed is open, no picture is taken at all |
| Cloud | the server (`captureService.js`) | integrity gate, capture switch, image checks (≤ 4 MB, ≤ 36 MP), **8 s** between reads, **80** reads per session, duplicate-picture hash, metered as `academic_read` |

The watcher is visible: the panel indicator reads **"Study · screen reading ON"**, and the app window's title says **"NUMZ AI - study session,
screen reading ON"** (paused: "study session paused"). A **dead-man switch** stops the watcher by itself if the page stops asking for results for
20 s (a closed or crashed page cannot leave it running); the page's check-in never waits for a read to finish, so a slow vision read cannot
trip it. Pause and End session take effect before the next look, and a screen that was in flight when pause was pressed is never sent. It never
simulates input, takes no video, writes nothing to disk, and does not bypass any operating-system capture permission or protected-window
restriction: what the system will not let it capture, it does not capture. The picture is discarded as soon as it is sent. It starts only where
windows can be listed (X11, Windows, macOS), **not on Wayland**, where the desktop's own portal prompt would be needed for every picture.

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
| `POST /sessions/:id/captures` (the picture is the body), `GET /sessions/:id/questions`, `GET /sessions/:id/content` | the screen: the reply lists the screen's **segments** (kind, title, text, `status` new/seen/grew/continued, `partial`, `continuesFrom`, `related`, how often seen), the `layout`, how the screen relates to the last one (`arrival`: new-screen, overlapping, revisit, same, empty), a `summary`, and the questions to offer (`partial`, `completed`, `duplicate`); the content route lists every segment the session has seen, once each |
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

### Limits of the content intelligence

* **Only screens that come to rest are seen.** The watcher captures a screen that has stayed the same for two looks and never closer than 10 s to the
  last one, so content that is scrolled past quickly, or changes again inside the 10 s gap, is not seen. That is the capture engine's design, kept as it was.
* **One read per screen, so one reply budget.** A segment's text is capped (about 1500 characters asked of the model, 2500 kept) and a screen lists at
  most 12 segments; a page denser than that is read in pieces as it scrolls. A reply that does not parse is "unclear" and the screen is read again at its next change.
* **Content is matched by words.** Two segments with identical text in different places (a repeated table row, boilerplate) are one segment; a
  segment the model reads differently by more than a few words is new rather than "the same"; a continuation across screens needs shared words (or the same
  group) to be joined, otherwise it is a new segment linked to the one it continues.
* **Other material is explained on request.** Questions are answered by themselves; a paragraph, code or table is listed, and "Explain this" asks about it.
* The model's `region`s are approximate and are not used to decide anything.

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
| `npm test` | 1241 passing (server, repositories, identity, routes, page logic, the study controller); 54 of them are new for content intelligence: the ledger (18), the reading parser, the capture service across layouts, the related content in answers, the content route, the page |
| `cargo test --workspace` (Linux) | 51 capture-library tests + 2 source scans passing (scrolling, paging, tabs and two-panel screens at the detector and the watcher included): change detection on synthetic and **real** anti-aliased text, flicker learning, the app's own window left out, the watcher's gap, exclusions, pause, stop and heartbeat |
| Real Chromium, real server, real numzlab-auth broker | `node scripts/academic-e2e/run.mjs`: 33/33 — Study panel end to end, restricted behaviour, no leakage between two people, delete-everything, phone width |
| Real desktop app on X11 (Xvfb + openbox), real server and broker | `node desktop/e2e/study.mjs` (see `desktop/README.md`) (41 checks) — one segment, several at once, next and previous, vertical scrolling, a segment cut by the screen edge and completed on the next screen, and content that comes back, each on the picture the watcher really took (the vision model is a stand-in that reads coloured bands, so this proves capture, timing, matching and the panel, not the model); a changed screen is captured, read and answered with nobody pressing anything, down to one changed digit, word or code token; an unchanged screen and the app's own window changing cause no capture; pictures are taken only while reading; none with a password manager or a listed window open; none while paused or after Stop; the watcher stops itself when the page goes away; a restricted session never reads; focus, pointer and stacking untouched |
| **Live vision model** | 12 real calls to the configured OpenAI vision model on pages rendered by a real browser (one paragraph, notes beside a multiple-choice question, a long page at several scroll positions, the same page again): it returned the segment JSON every time, separated side-by-side panels, kept a question's three options, gave sensible groups and titles, set `cutOff` on a paragraph that the screen edge sliced, and the ledger recognised the same paragraph across different layouts and treated the return visit as seen. A sample this small proves the prompt is followed, not how often it is |
| **Not verified** | Windows and macOS capture/watcher (only type-check), Wayland, answer quality with a real text model, how often the real vision model mislabels a cut-off edge or merges two panels (code, tables, figures and slides were not in the live sample), a very long page (the reply is capped, see Limits), a real phone, a real person's screen |

The model in every test is a stand-in: answer *quality* is unmeasured. The wording rules (natural student writing, citing only given sources) are
prompt instructions plus the citation check; they are not a guarantee of tone.

## Rollout notes

Migrations 8–10 are additive (older images ignore the new tables). The release needs `CAMERA_VISION_*` configured (already is) and per-person
sign-in (already is). The desktop app must be rebuilt for the new watcher commands. Nothing here is deployed.
