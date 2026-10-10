# Meeting intelligence

Status: **Implemented and tested locally** (`tests/meetingIntelligence.test.js`, `server/api/meetingIntelligence.test.js`).
**Not deployed. Not exercised against a real model or a real meeting.** Nothing here runs by itself: it answers when an
operator asks.

## What it is

Questions, action items, decisions, and (on request) a model-written summary and notes, computed from a meeting's
**saved canonical transcript**. The caller names a meeting; text is never accepted from the request.

| Route (admin token only) | What it does | Cost |
|---|---|---|
| `GET  /api/v1/meetings/:id/intelligence` | Findings from the words themselves (`server/intelligence/meetingSignals.js`). No model. | none |
| `POST /api/v1/meetings/:id/intelligence/notes` | Sends the saved transcript to the configured AI provider, then checks every item it returns against that transcript (`server/intelligence/grounding.js`). Body: `{ "allowUnverified": true }` to accept an unverified transcript. | one model call; the transcript leaves this server |

A meeting ticket (what the browser holds) is refused on both: intelligence is an operator read, not part of the
recording path.

## Every answer says how settled its transcript is

`transcript.state`: `verified` (COMPLETED and every recording confirmed its line count), `unverified` (COMPLETED,
a recording never confirmed), `incomplete` (lines known missing), `open` (still recording). `provisional` is
`true` for anything but `verified`. Notes are **refused (409 `transcript-not-final`)** unless `verified`, or
`unverified` with `allowUnverified`. An empty transcript is refused (409 `transcript-empty`); more than 2000 lines
is refused (413 `transcript-too-long`) rather than silently truncated.

## Evidence labels

| `status` | Meaning |
|---|---|
| `confirmed` | the words themselves state it: a sentence ending in "?", "I'll send ...", "we decided to ..." |
| `inferred` | the wording suggests it ("let's ...", a question with no question mark) **or** a model read it and its words are mostly found in the lines it cites |
| `uncertain` | present, but weakly supported: the model's words are not in what it cites, a cited line was recognised with low confidence, or a summary contains numbers/names that appear nowhere in the transcript |

Only the word-pattern findings can be `confirmed`. A model's reading is at best `inferred`.
`basis` says which: `explicit-wording` or `model-inference`. `caveats` lists the reasons (`weak-lexical-support`,
`low-asr-confidence`, `model-timestamps-replaced`, `some-cited-segments-do-not-exist`, `owner-unverified`,
`contains-terms-not-in-transcript`).

## Links to the transcript

Every item carries `source: { segmentIds, start, end }` and, for model items, `evidence: [{ segmentId, text }]`.
**Times and quotes come from the saved segments, never from the model.** A model item that cites no segment, or
only segments that do not exist, is dropped and listed under `notes.rejected` with the reason; it is not shown as a
finding.

## Who said it

Never guessed. `speaker` on a finding is passed through only when the segment carries a real label (not `null`, not
`overlap`, not marked `uncertain`). An action's `owner` is set only when the text names one ("Priya will ...") or the
speaker says "I will"; "we" is a group (no owner). A model's owner is kept only if the cited text names them or the
cited segment carries that label.

## Limits

- The word patterns are **English surface patterns**: they miss what is implied and they sometimes match words that
  were not meant that way. They are a floor, not a reading of the meeting.
- The grounding check is lexical: it tells a claim that shares no words with its citation from one that does, not a
  true claim from a plausible false one that reuses the same words.
- Whether the model's notes are *good* has not been measured; only that they cannot cite what does not exist.
- A meeting recorded through a microphone that hears everyone has no speaker labels (the live path does not run
  diarization), so owners are rare by design.
- Rolling (during the meeting) notes are now wired: see [live-meeting-intelligence.md](live-meeting-intelligence.md).
  Everything here (admin routes, grounding, evidence labels) is the same machinery that pipeline uses.
