# Live meeting intelligence: dev run evidence (2026-10-10)

Run against **development credentials and a development meeting API**, never production. The production API, database
and speech sidecar were not touched.

## What ran

| Part | Where |
|---|---|
| Frontend | this branch's Vite dev server, reached by the user's SSH tunnel as `http://localhost:15173` in their real Chrome |
| API | this branch, `node server/server.js` on `:3002`; throwaway admin token, ticket secret and launch code; a scratch SQLite file; debounce set to 6 s to keep the run short |
| Speech sidecar | a **second** instance of the same Python on `:8766`, `MEETING_API_URL` = the dev API, scratch outbox |
| AI provider | a local stub that answers the rolling prompt and the final-record prompt with JSON citing **real segment ids copied from the prompt**, and (deliberately) an invented section, a name and a number that are not in the transcript |
| Audio | the repo's `jfk.wav` and two cuts of it, fed in as a synthetic microphone stream (the page's `getUserMedia` replaced) |

Real: the browser, the page's meeting, panel and command-router code, the relay, the sidecar and its recognizer,
persistence, integrity, the live intelligence service, the cookie and launch session. **Stand-ins:** the model
(a stub), the microphone (synthetic), and `jfk.wav` is the only speech available, so the "decisions" are the stub's
reading of "ask what you can do for your country", not real meeting content.

## Results

| # | Scenario | Result |
|---|---|---|
| 1 | No browser: launch, stream `jfk.wav` through the relay, poll the live state, end with the ticket | before the debounce: lines persisted, `analysis.status: behind` (model not asked); after it: 2 merged / 1 pending (`behind`), topics and a decision present; on closure `final: running` while the pending line was drained, then `final: ready`, `phase: final`, `provisional: false`; integrity VERIFIED 3/3 |
| 2 | Real Chrome, typed code once, **Start**; clips played into the microphone stream | panel `Recording`; its **Live — provisional. Based on 0 saved lines. Nothing has been said and saved yet.** became "Based on 3 saved lines. 1 newer line is not analysed yet; last update HH:MM:SS" and then "Updated HH:MM:SS"; Decisions, Action items ("owner not stated · no deadline stated"), Open questions and Notes filled with the evidence label "model reading, provisional" and the time |
| 3 | Chat, while the meeting was recording: "What decisions have been made?", "Who is responsible for each task?", "What questions remain unanswered?" | each answered from the same state: status line first (live, provisional, 3 saved lines, updated time), then the findings; owners: "no owner stated ... I only report an owner when a speaker named one"; nothing sent to the assistant model, nothing touched in the recording |
| 4 | Chat: "End the meeting and give me the final summary" | asked to confirm; **no stop before "yes"**; after "yes": "Saved 3 lines. The transcript is complete and verified." then "**Final — the transcript was verified** (3 saved lines)" and the summary |
| 5 | The summary the stub wrote contained "Senator Kennedy" and "40000", which are not in the transcript | flagged in chat and in the panel: "Check this summary: it mentions Senator, Kennedy, 40000, which do not appear in the transcript."; the invented topic that cited a segment that does not exist was dropped and counted |
| 6 | Panel layout with findings present | the lines list, counts, Stop button and findings stack and the panel scrolls (a first pass squeezed the lines list and overlapped the Update button; fixed) |
| 7 | Dev database at the end | three meetings, all COMPLETED, every recording VERIFIED with stored = committed, intelligence `verified` |

## Not verified

A real model (its answers are only as good as the grounding check can tell: existence and lexical support, not
truth); real meeting content with decisions, owners and deadlines; a real microphone or tab capture; voice
(spoken) questions, which are not available during a live recording by design; multiple concurrent real meetings
in one browser session (covered by tests over HTTP, not run in the browser).
