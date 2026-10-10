# Live meeting intelligence

Status: **Implemented and tested locally** on branch `feature/live-meeting-intelligence`. **Not merged, not deployed.**
Exercised in a real Chrome against a dev stack (dev API, dev speech sidecar, stub AI provider, synthetic audio
stream, real recognizer); see "Evidence" below for what that does and does not show.

This is one pipeline, not a second system: it reuses the canonical store, the meeting auth, the rolling tracker
(`rollingIntelligenceService.js`), the grounding checks and the existing meeting panel and command router.

## The pipeline

```
 speech sidecar ──final line (ticket)──▶ POST /:id/transcript/final
                                           │ validate, stable id, idempotent insert  (UNCHANGED)
                                           ▼
                                   canonical store (SQLite)
                                           │ 'TranscriptSegmentPersisted'  (only INSERTED lines)
                                           ▼
        liveMeetingIntelligenceService   one runtime per meeting, keyed by meeting id
          tracker.ingest (dedupe by id) ─▶ debounce (15 s, or 15 waiting) ─▶ ONE model update at a time
          timeline order, batches of 60 ─▶ answer parsed; unusable ⇒ batch stays pending, backoff
          grounded against the SAVED transcript ─▶ merged with what the words state outright
                                           │ one state object, revision-numbered
                                           ▼
        GET /:id/intelligence/live  (the meeting's own ticket, or admin)
                                           ▼
        meetingIntelligenceStore  (the browser's ONE copy; polls, only changes)
                    ├──▶ meeting panel   (decisions, actions, questions, notes, status, final summary)
                    └──▶ command router  (chat and voice: notes, decisions, questions, actions, owners, final)
```

Order guarantees: a segment reaches a tracker only through the store's own persisted event, so audio, partial
text and refused lines never do. A runtime started late (server restart, first request) loads what is persisted.
A model failure, an unusable answer or a restart loses nothing: the transcript is never written by this module and
unmerged segments stay pending.

## What the state says (`GET /api/v1/meetings/:id/intelligence/live`)

| Field | Meaning |
|---|---|
| `phase` | `live`, `closing` (finalizing), `final` (record ready), `closed` (completed, no final record), `ended` (failed or cancelled) |
| `provisional` | `true` until the meeting is closed **and** its transcript verified **and** the final record is ready |
| `transcript` | `state` (`open` / `verified` / `unverified` / `incomplete`), `segmentCount`, integrity facts, from the existing integrity report |
| `analysis` | `status` (`idle`, `current`, `updating`, `behind`, `error`, `off`), `lastSuccessAt`, `lastAttemptAt`, `pendingSegments`, `mergedSegments`, `error` |
| `findings` | `topics`, `decisions`, `openQuestions`, `questionsAsked`, `actionItems`, `notes`; each item has `status` (`confirmed` / `inferred` / `uncertain`), `source` (segment ids, times), `evidence` (the saved words), `owner` and `due` only as spoken |
| `final` | `status` (`not-started`, `pending`, `running`, `ready`, `failed`, `withheld`, `empty`), `reason`, `summary`, `findings` |
| `revision` | bumps on any change; `?since=<revision>` answers `{ unchanged: true }` without rebuilding anything |

Three tiers, in the words used on screen and in chat:

- **Live, provisional**: the meeting is open, or its transcript is not verified. Model readings are labelled
  "model reading, provisional".
- **Stated in the transcript** (`confirmed`): the saved words themselves state it (a sentence ending in "?",
  "I'll send ... by Friday", "we decided to ..."). Found without a model, available immediately.
- **Final**: closed, integrity verified, the final record written from the whole saved transcript.

"Never stale as current": `analysis.status` is `error` or `behind` whenever saved lines have not been absorbed,
and chat and the panel say how many, since when the update has been failing, and that the findings **may be out
of date**. If the page itself cannot reach the server, that is reported separately.

## Closure

When the meeting is completed the service drains pending work (a couple of attempts; a long backlog from a
restart is safely cancelled because the final pass reads the whole transcript anyway), then reads the existing
integrity verdict. **Only a verified transcript gets a final summary.** `unverified` and `incomplete` are
`withheld` with the reason, and chat says so; the explicit findings remain. A failed final can be retried
(`POST .../intelligence/refresh`, the panel's "Retry the final summary"). The final record is itself checked:
citations to segments that do not exist are dropped and counted, and a summary that names things the transcript
never contains is flagged ("Check this summary: it mentions ...").

## Chat and voice

The command router (`src/interfaces/commands/meetingCommands.js`) answers, from the one state the panel also
renders, after asking the server to update now:

| Say or type | Reply |
|---|---|
| "show me the notes so far", "catch me up", "what has been said so far" | topics, notes, counts, status line |
| "what decisions have been made?" | decisions with evidence labels and times |
| "what questions remain unanswered?" | open questions (or the questions asked, saying it cannot tell which were answered) |
| "what action items have been assigned?" | action items with owner and deadline **only as stated** |
| "who is responsible for each task?" | owners as named; "no owner stated" otherwise |
| "end the meeting and give me the final summary" | asks to confirm, stops through the meeting's own end flow (integrity check), waits for the final record, reports it |
| "show me the final summary" | the finished meeting's record |
| "start the meeting" / "stop the meeting" | unchanged |

Only whole messages match; "how do I get the meeting notes into a PDF?" goes to the assistant. Replies have a
Markdown form (chat) and a plain, short `speech` form (voice).

**Voice during a live recording is deliberately not offered.** While a meeting records, the assistant neither
listens nor speaks (otherwise it would record itself, and a second recognition stream would compete with the live
one for the single shared model). Questions during a meeting are typed; spoken questions and "show me the final
summary" work once the recording has stopped.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `MEETING_LIVE_INTELLIGENCE` | `on` | `off`: **no transcript is sent to a model provider**; only findings stated outright remain, final summaries are withheld (`model-disabled`) |
| `MEETING_INTELLIGENCE_DEBOUNCE_MS` | `15000` | how long after the first unanalysed line the model is asked: the latency/cost dial |

With no AI provider configured the service does not call one; the state says `error` / `provider-unavailable`.

**Privacy and cost:** with the default on and a provider configured, a meeting's saved lines are sent to that
provider while it runs (batched, at most one call per 15 s per meeting, plus one final call). Turn it off per
server with `MEETING_LIVE_INTELLIGENCE=off`.

## Limits

- English wording patterns for the stated findings; they miss the implied.
- The model's output is checked for existence and lexical support, not truth.
- Intelligence is held in memory and rebuilt from the saved transcript after a restart (the model catches up in
  batches; a lost final record is regenerated on the next request).
- One server process.
- Live transcripts carry no speaker labels, so owners exist only where a speaker said a name.
- Polling (4 s, 20 s when the tab is hidden, 3 s while a final record is pending), not push.
- Voice during a live recording: see above.
