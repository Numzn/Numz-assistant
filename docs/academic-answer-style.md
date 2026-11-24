# The academic answer style

How a study answer is written and what it may rest on. One place holds the rules: [`server/academic/answerStyle.js`](../server/academic/answerStyle.js). Nothing in it
knows a course or a subject; the course's own material arrives as sources.

## Where it applies

The study pipeline only: a question typed in the Study panel, a question read from the screen, and (in the same words) a screenshot of a question taken with the
chat's Screenshot button. The ordinary conversation, coding help and the voice assistant never import it (a test fails if they do).

```
question ─ understood (questionAnalysis.js: kind, parts, instructions, marks, command words)
         ─ course resolved ─ sources retrieved (knowledgeService.js: duplicates are one source)
         ─ prompt assembled (responseEngine.js ← answerStyle.js)  ─ model  ─ checked (answerCheck.js ← answerStyle.js) ─ shown
```

## The three groups of rules (kept apart on purpose)

| Group | What | Where |
|---|---|---|
| **Writing** | begin with the answer; everyday English, short sentences, the lecturer's terms; no stock introductions or conclusions, no repeated points; correct spelling and grammar, never mistakes on purpose; nothing about how the answer was made; no promise of full marks or of not being recognised as machine-written | `STYLE_NATURAL`, `ANSWER_VOICE` |
| **Shape** | depth from the marks (`marksGuide`: 1–2, 3–4, 5, 6–9, 10+; "a guide, not a rule"); what each command word asks for (`COMMAND_GUIDE`: define, state/list/identify, explain, describe, discuss, compare, analyse, illustrate, draw/diagram, case study); the size of the question when no marks are known (`ANSWER_SIZE`) | `answerStyle.js`, `requirementLines` in `responseEngine.js` |
| **Sources** | order of authority: lecturer's materials, then the student's assignments and handouts, then past papers (for wording and what an exam expects), then general knowledge only as below; a past-paper question shows a topic was examined, not that the notes explain it; an assignment may be a simplified example; keep the lecturer's wording; say when sources conflict; cite only labels that were given; if the sources name a topic but do not explain it say so in one sentence and put anything added from general knowledge after "Supplementary:"; no material matched: begin "Not from your notes:"; "use only my notes" (in the note or in the question): no general knowledge, say the notes do not cover it | `sourceRules`, `sourceKind`, `detectSourceOnly` |

Source kinds come from the document's type and title (there is no database type for "assignment" or "past paper", and adding one would need a migration of a
constrained column): a title with "past paper", "exam", "quiz" … is a past paper, one with "assignment", "handout", "lab" … is an assignment; lecture notes,
transcripts, outlines and study guides are the lecturer's.

## Checks on every answer (no model, a fraction of a millisecond)

An AI-style opening ("Certainly! I would be delighted…", "In today's rapidly evolving…"), inflated wording where a plain word would do, a promise of full marks or
of not being detected, a page number or author-and-year that is not in the sources the answer was given, and a diagram that was asked for and is missing each send
the draft back once with exactly what was wrong (the same one repair as the older checks; a complex question still gets its second model look).

## Tests

`server/academic/answerStyle.test.js` (the fifteen cases of the brief, deterministic), plus pipeline cases in `answerService.test.js`: a lead-in or an invented
reference is repaired, "use only my notes" reaches the model, a gap gets the supplementary rule, a duplicate upload is one source, 5 and 10 marks get their own depth.

## Limits

* The rules shape and check what the model writes; a model can still ignore one. The checks catch what can be caught by rule (openings, wording, promises,
  references, a missing diagram), not a wrong fact or a gap filled silently.
* "Use only my notes" is found by wording (many phrasings, not all). A session-wide switch for it was not added (it would need a settings screen).
* Past papers and assignments are told apart from other material by their title, not by a type the person chooses.
* The depth for a given number of marks is a guide in the prompt, not a measured word count.
