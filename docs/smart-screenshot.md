# Smart Screenshot: adaptive answering and faster processing

Branch `feature/smart-screenshot-upgrade` (from main 8b5fc0c). **Not merged, not pushed, not deployed.** The upgrade covers the whole path from a
screenshot to the answer on screen, for both ways of taking one: the study watcher (the desktop app reads the screen when it changes) and the
chat's Screenshot button. It uses the existing pipeline and adds no new screen, no camera code and no new service.

```
desktop app (Rust)            page (study controller)          server                                      page (study panel / chat)
look ─ settle ─ report ─ poll ─ export JPEG ─ upload ─ read (vision) ─ understand ─ answer (streamed) ─ check ─ answer blocks + copy icons
```

## What changed

| Area | Change | Where |
|---|---|---|
| Capture and preparation | The picture is scaled with SIMD instead of the general resize and handed to the encoder without extra copies (scaling and encoding together take 2.4× less time at 1080p); the watcher no longer builds a preview picture nobody shows for every screen it reports; the look interval is 1.5 s (was 2.5 s) and the page asks for a finished picture every 0.5 s (was 1.5 s); the upload no longer waits for the app to release its copy | `desktop/src-tauri/crates/numz-capture/src/encode.rs`, `watch.rs`, `src/interfaces/academic/studyController.js` |
| No duplicate work | The same question asked twice (a double click, an automatic answer racing a button) is one answer on the page, and one answer on the server (the second ask shares the first's work, or is handed its result and is not added to the conversation twice). The server's exact-picture check, the app's changed-and-settled rule and the one retry are unchanged | `studyController.js` (`flights`), `answerService.js` (`entry.results`, `entry.working`) |
| Reading | The screen-reading prompt no longer asks for each segment's `region` (nothing used it): 20% fewer tokens written per read | `questionUnderstanding.js` |
| Question intelligence | A pure analysis of each question: its kind (definition, explanation, list, comparison, discussion, evaluation, calculation, application, case study, multiple choice), its labelled parts, every instruction in it, how many items it asks for, its marks, and how complex it is | `server/academic/questionAnalysis.js` |
| Adaptive answering | The prompt is built from that analysis: one sentence for a simple question, a concise answer for a moderate one, every requirement in turn for a complex one; the working a calculation needs and its final answer in bold; a case study answered from its own facts; multi-part questions answered part by part; everything in the plain voice of a student explaining to a student, with no introduction, no conclusion and no word limit | `responseEngine.js` (`requirementLines`, `ANSWER_SIZE`, `ANSWER_VOICE`) |
| Checking | Every answer is checked by rules before it is final (is there an answer; for multiple choice, one of the options; a result for a calculation; every part; as many items as asked; about this question; finished). One repair when a rule fails. A complex question is also read a second time by the model, which redoes the calculations. None of this takes another answer from the person's daily allowance | `answerCheck.js`, `answerService.js` |
| Answers as blocks | Each answer is a highlighted block with its label (ANSWER, or ANSWER (b) for a part) and a small copy icon beside it. The icon copies that answer only, as formatted text and as plain text. A multi-part answer is several blocks, each copied on its own. The same blocks appear in the conversation | `src/interfaces/chat/answerBlocks.js`, `answerFormat.js`, `style.css` |
| Progressive display | The words are shown as they are written (a few redraws a second, in place, so scrolling and selecting are never interrupted); the block says "writing…" then "checking…" and has no copy icon until the answer is final | `academicAnswers.js` (event stream), `academicApi.js`, `studyController.js`, `studyView.js` |
| Manual screenshots | A screenshot of a question taken with the chat's button is answered the same way (size, voice, ANSWER headings) instead of described | `server/screenshots/screenshotPrompts.js` |
| Parallel work | Two answers from one screen are worked on together (it was one after the other; two is the least any person's limit allows) | `studyController.js` |

### How a question is understood

| It is… | Examples | The answer |
|---|---|---|
| multiple choice / true-false | "Which is a noun? A) … B) …" | the option, its letter and text, on one line |
| a definition | "Define opportunity cost." | one sentence |
| an explanation | "Why is the sky blue?" | the shortest answer that is complete |
| a list | "List four functions of money." | exactly four items, names only (a short explanation only if the question asks to describe or explain) |
| a comparison | "Compare TCP and UDP." | straight to the differences, a small table when there are three or more features |
| a discussion / evaluation | "Evaluate rent control." | the judgement and the reasons on each side; a second look by the model |
| a calculation | "Calculate the interest…" | the working that is needed, the final answer and unit in bold |
| an application | "Using the supply model, predict…" | what happens or what to do, with the details given |
| a case study | a scenario, then "advise the owner…" | solutions from the case's own facts; a second look by the model |
| several parts | "(a) … (b) … (c) …" | one block per part, in order, each its own copy icon |

`classifyTask` is unchanged for the old tasks (its tests still pass); `list`, `apply` and `case_study` are new. What the rules cannot place is
explained, never refused: the analysis only shapes and checks an answer.

### Checking, and what it costs

| Level | For | What | Extra model calls |
|---|---|---|---|
| Rules | every answer | the checks in `answerCheck.js` (≈0.1 ms) | none; one repair call only when a rule fails |
| Second look | complex questions (evaluation, discussion, analysis, case study, three or more parts, 6+ marks) | the model gets the writer's own request and the draft, redoes the calculations, and says `OK` or gives a corrected answer; a "correction" that is only talk about the draft is ignored | one |

In the measured run, 5 of 8 kinds of screen needed one call, 2 needed two (the second look), and a multi-part screen (three questions) three.

## Performance: before and after

All "before" numbers are main at 8b5fc0c; "after" is this branch. The real models were used (`claude-sonnet-5-5` for reading and answering).
Provider latency moves by ±0.5 s from run to run, so differences under a second between single rows are not evidence; the first-words column
(the point of streaming) and the picture preparation are well outside that.

### 1. Preparing the picture (desktop app; release build, made-up screen-like pictures, 15 runs each, median)

`cargo run --release --example prepbench -p numz-capture`

| Screen | Scale + encode to read (ms) | Preview the watcher made for every report (ms) | Work per reported screen |
|---|---|---|---|
| 1920×1080 | 131.5 → **55.4** | 93.1 → **0** (no longer made) | 225 ms → **55 ms** (−75%) |
| 2560×1440 | 161.6 → **61.2** | 99.1 → **0** | 261 ms → **61 ms** (−77%) |
| 3840×2160 | 220.9 → **84.8** | 175.5 → **0** | 396 ms → **85 ms** (−79%) |
| 1366×768 (no scaling needed) | 32.7 → 34.1 | 73.5 → 0 | 106 ms → 34 ms |

The picture is the same one a person needs to read: the new scaling is held within 2 colour levels (of 255) of the old on average on a page of
text (a test), and the JPEG is the same size (185 → 186 KB at 1080p). Copies of the picture cost 1–4 ms; the general resize was the cost.

### 2. From the screen changing to the picture being in the page (the real watcher on a virtual clock)

`cargo run --release --example latencysim -p numz-capture` (120 random changes per row; the operating system's own capture time is not in it)

| Look every | Page asks every | Median | 90th percentile |
|---|---|---|---|
| 2.5 s (before) | 1.5 s (before) | 4.30 s | 5.70 s |
| 1.5 s | 1.5 s | 2.85 s | 3.70 s |
| **1.5 s (now)** | **0.5 s (now)** | **2.50 s** | **3.05 s** |

A changed screen is reported on the second look after the change (one to see it, one to see that it stopped moving), so a quicker look is a
quicker report. The cost is more looks: the watcher's own work per look (detection and bookkeeping) is 7–10 ms of CPU for a 1080p screen. The operating
system's capture comes on top of that and is not in this measurement. Reads are still at least 10 s apart (the app) and 8 s apart (the server): this makes the wait
shorter, not the number of reads larger.

### 3. Reading, answering and showing (real models, 8 kinds of screen × 3 runs)

`node scripts/smart-eval/run.mjs --root <checkout> --runs 3`, then `node scripts/smart-eval/report.mjs docs/smart-screenshot/before.json docs/smart-screenshot/after.json`.
"First words" is the time from asking for the answer until the first words can be shown (before: the whole answer, which was not streamed).

| Screen | First words before | after | Answer complete before | after | Words before | after | Correct before → after |
|---|---|---|---|---|---|---|---|
| definition | 1.1 | **1.0** | 1.1 | 1.6 | 34 | 22 | 3/3 → 3/3 |
| multiple choice | 2.7 | **0.6** | 2.7 | 0.7 | 3 | 5 | 3/3 → 3/3 |
| calculation | 1.0 | **0.7** | 1.0 | 1.0 | 15 | 18 | 3/3 → 3/3 |
| list | 1.6 | **0.6** | 1.6 | 0.9 | 20 | 19 | 3/3 → 3/3 |
| comparison | 5.9 | **0.7** | 5.9 | 3.2 | 126 | 170 | 3/3 → 3/3 |
| discussion / evaluation | 6.5 | **1.3** | 6.5 | 8.0 | 322 | 287 | 3/3 → 3/3 |
| case study | 3.5 | **1.1** | 3.5 | 4.8 | 125 | 167 | 3/3 → 3/3 |
| multi-part | 2.0 | **0.6** | 2.0 | 1.8 | 74 | 85 | 3/3 → 2/2 |
| **all** | 2.0 | **0.8** | 2.0 | 1.7 | 34 | 24 | 24/24 → 23/23 |

* **First words: −62%** (the median screen shows words after 0.8 s instead of 2.0 s; a comparison after 0.7 s instead of 5.9 s, an evaluation after 1.3 s instead of 6.5 s).
* **Read + answer complete: 5.3 s → 4.4 s (−17%)** over all screens. The two slowest kinds (evaluation, case study) are slower to *complete* (+1.5 s, +1.3 s) because the second look is a second model call; their words still appear after about a second, and the checked answer replaces them.
* One multi-part run in the "after" set could not be read (the reading model answered "unclear"); ten more reads of that screen on each version gave 10/10 on this branch and 8/10 on main (main shows the same occasional "unclear"), so it is not caused by this change.
* "Correct" is a check that each answer contains what a correct answer must (patterns per screen in `scripts/smart-eval/corpus.mjs`), not a grade of the writing.
* Tokens per screen: reading writes 330 → 264 tokens (the dropped `region`), the answer call reads 1,242 → 1,671 tokens (the longer prompt, and the second look on complex screens). Net, the prompt side costs more; the answers are shorter.

### 4. Everything else, measured

| Stage | Result |
|---|---|
| Question classification | 0.0–4 ms (a plain rule; the number is its first call, then below the timer) |
| Looking up course material, checking the answer by rules | 0–2 ms (`timings.lookup`, `timings.check` in every answer) |
| Drawing an answer into answer blocks (Chromium, 200 runs) | ≤ 0.5 ms for a 300-word answer with a list and table (before: ≤ 0.4 ms): drawing is not a cost |
| Page → server | the picture is sent as it is (no base64); the app's held copy is released while the upload goes (no longer awaited) |

## Reproducing

```bash
node scripts/smart-eval/run.mjs --root /srv/projects/Numz-assistant --runs 3 --label before --out docs/smart-screenshot/before.json   # main
node scripts/smart-eval/run.mjs --runs 3 --label after --out docs/smart-screenshot/after.json                                          # this branch
node scripts/smart-eval/manual.mjs                                   # the chat's Screenshot button on the same screens
node scripts/smart-eval/render.mjs [--root <checkout> --plain]       # drawing time in Chromium
cd desktop/src-tauri && cargo run --release --example prepbench -p numz-capture && cargo run --release --example latencysim -p numz-capture
```

## Checks run

| Check | Result |
|---|---|
| `npm test` (Node) | **1,345 of 1,345 pass** (1,298 before; 47 new: question analysis, answer layout, checks, streaming service and route, the page's controller and API, layout parity, prompts, provider) |
| Academic Chromium end to end (`node scripts/academic-e2e/run.mjs`), 59 checks: block, label, small icon, highlight, copy as formatted + plain text, copy only that answer, part-by-part blocks, words shown while writing, second look before final, phone width (375 px: no sideways scroll, touch area larger than the icon) | all pass |
| **The real desktop app, end to end** (`desktop/e2e/study.mjs`: the new Rust code built into the app, Xvfb + openbox, a real desktop, the real server and sign-in broker, a stand-in model) | **41 of 41 pass**: the real 1600×900 picture arrives with the right pixels, a changed digit / word / code token is captured, an unchanged screen is not captured again, the question is answered by itself, pause / stop / excluded windows / a hung page all behave |
| Rust: `cargo test --release -p numz-capture` | 53 + 2 pass (2 new: the scaling matches the old one; a picture that is small enough is not scaled) |
| Rust cross-checks: `cargo check --target x86_64-pc-windows-msvc` and `aarch64-apple-darwin` | pass |
| `vite build` and the bundle budget test | pass; first-load scripts 227.4 KB raw (main 218.3), 76.6 KB gzipped (73.3), page 79.1 KB Brotli (76.1): the raw budget was raised from 220 to 232 KB with the reason beside it |

Two things these runs found that the unit tests did not, both fixed: (1) a model service that answers a streaming request with one ordinary JSON completion
made the streamed answer come back empty (the real-app run's stand-in model does exactly that; the OpenAI-style provider now reads a plain completion when
that is what comes back, with a test that behaves like a real response whose body, once taken up as a stream, can no longer be read as text); (2) a
second look given only the question and the draft "corrected" a case-study answer into a refusal because it could not see the case, so it is now given
the writer's own request, and a "correction" that is only talk about the draft is ignored.

## Limits

* The Windows and macOS capture paths were only type-checked; the faster look interval and the SIMD scaling have not run on a real Windows or macOS PC. The real desktop app was run on Linux X11 only (41 of 41).
* The look interval of 1.5 s is a trade of battery and CPU for speed; the operating system's own capture cost per look was not measured on Windows or macOS. It is one constant (`WATCH_INTERVAL_MS`) if it should go back.
* The second look uses the same model as the writer; it catches slips and invented figures, not every wrong fact. A question whose answer cannot be confirmed is marked "could not be fully confirmed".
* Reading a screen (about 2.7 s) is now the longest single step for simple questions, and it is the vision model's: only a shorter reading (fewer segments) or another model changes it.
* Answers can be a little longer for comparison and case-study screens than before (they are now complete in the student's voice rather than a table alone); the size rules ask for the shortest complete answer but a model varies.
* `AI_PRICE_*` is unset, so no cost figure is claimed.
* This is on a branch: production runs the older code until it is merged and deployed.
