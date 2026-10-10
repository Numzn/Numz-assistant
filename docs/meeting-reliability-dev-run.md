# Supervised dev run: evidence (2026-10-10)

A whole meeting workflow run against **development credentials and a development meeting API**, never production.
Nothing in this run touched the production API, database, sidecar or image.

## What was running

| Part | Where | Notes |
|---|---|---|
| Frontend | this branch, Vite dev server on host `:5173`, reached by the user's SSH tunnel as `http://localhost:15173` in their real Chrome | a secure context; HMR reloaded the page on edits |
| API | this branch, `node server/server.js` on `:3002` | throwaway admin token, ticket secret and launch code (never printed or committed); a scratch SQLite file; `NUMZ_SKIP_ENV_FILES=1` |
| Speech sidecar | a **second** instance of the same Python on `:8766`, `MEETING_API_URL` = the dev API, a scratch outbox | the production sidecar on `:8765` was not touched, restarted or connected to |
| AI provider | a local stub on `:3999` answering every chat with one fixed sentence, and with notes JSON (one real citation, one invented, a summary with a name and a number that are not in the transcript) for the notes prompt | so the self-echo test knows exactly what the assistant says |
| Audio | the repo's `jfk.wav` (11 s) and two cuts of it | the **only speech available on this host**; transcripts below are what the real recognizer produced |

## What is real and what is not

Real: the browser, the page's meeting and voice code, the relay, the sidecar and its recognizer, persistence, the
API's integrity and intelligence, the cookie, the launch session.

**Not real (stand-ins):** the microphone and the shared-tab audio were **synthetic streams** carrying the clips,
injected by replacing `getUserMedia` / `getDisplayMedia` in the page; the assistant's speech output was a silent
stand-in with the real events and a duration proportional to the text. A real microphone prompt was raised in the
user's Chrome and **not answered within 40 s** (permission state `prompt`), so **no real device and no real
share picker was exercised**.

## Results

| # | Scenario | Result |
|---|---|---|
| 0 | No browser: launch with the code, same attempt again with the cookie only, stream `jfk.wav` through the relay, end with the ticket, read intelligence and notes (twice) | launch 201 + cookie; repeat 200 `reused` same meeting; 3 lines `INSERTED`; `stopped` 3 committed / 3 inserted; `/end` COMPLETED, VERIFIED 3/3; intelligence state `verified`; a ticket on the intelligence route 403 |
| 1 | Locked browser; code typed once; **microphone** | Recording, `Microphone: sound heard`, 2 lines saved, Stop -> "Saved 2 lines. The transcript is complete and verified."; DB: COMPLETED, VERIFIED 2/2. `document.cookie` does not show the launch cookie (HttpOnly); no copy of the code in `sessionStorage` |
| 2 | Unlocked; typed **"start a meeting called ..."**, no code | meeting started directly; chat reply "Starting the meeting. The meeting panel shows when the speech service has confirmed it."; 1 line saved; VERIFIED 1/1 |
| 3 | **Shared tab** audio from the panel; then "Stop sharing" mid-meeting; Reconnect; Stop | `getDisplayMedia` asked with `video:true` and echo cancellation off; the video track was stopped, the audio kept; `Tab or system audio: sound heard`; on stop-sharing: **Needs attention** + "Every audio source has stopped ..." + Reconnect / End meeting; Reconnect continued the same meeting (2 recordings); VERIFIED 1/1 and 2/2 |
| 4 | **Both** (microphone clip at t=0.5 s, tab clip at t=5.5 s) | picker asked first, then the microphone; both indicators; one mixed transcript with both clips' words, 3 lines, VERIFIED 3/3 |
| 5 | Both, picker cancelled | message: "Tab or system audio is NOT being recorded (Sharing ... cancelled or blocked.). Recording continues from Microphone." (warn); microphone line saved; VERIFIED 1/1 |
| 6 | Tab, shared without audio | refused with "The shared tab or screen has no audio ... tick Share audio ... Press Reconnect"; the meeting stayed open for Reconnect |
| 7 | Tab with a track that carries no sound | indicator `no sound yet` and a warning that it may be muted; ended with 0 lines (see finding 2) |
| 8 | **Lock**, then typed "start the meeting" | server `authenticated:false`; code field returned; reply "I opened the meeting panel. Enter the launch code there to start recording."; nothing started |
| 9 | **Self-echo**, voice mode, the assistant's own sentence re-entering the microphone 1.0 s after its speech ended | the capture began 2.0 s after the end; transcript "What your country can do for you, ask what you can do for you." (a recognition slip) was **ignored** (console: "ignored a transcript that is the assistant's own speech"), **no second assistant turn**, state back to LISTENING |
| 10 | Same, but an unrelated utterance in the same window (twice) | both **answered** (stub received both), 0 echo warnings |

Dev database at the end: 8 meetings, all COMPLETED, every recording VERIFIED with stored = committed (run 3 had two
recordings), intelligence state `verified`.

## Findings this run produced (all fixed on the branch, each with a test)

1. **A bare question word was called a question.** "What your country can do for you, ask what ..." (no question
   mark from the recognizer) was an inferred question. Unmarked questions now need an auxiliary first or a question
   word followed by one.
2. **A recording that heard nothing ended as a green "Saved 0 lines ... complete and verified".** True (0 of 0) and
   useless. It now says "No speech was transcribed ... check that the microphone is not muted, or that the shared tab
   was playing sound", with a warning tone and an "Ended, no speech" chip.
3. **The echo guard's window was too short and never fired.** With 1.5 s the guard did nothing in the real pipeline:
   the input ignores sound for a settle pause after a reply and the state has to sync, so the earliest a capture can
   begin is about 2 s after the speech ended. The window is now 3 s (docs/voice-self-echo.md).

## Not verified

A real microphone; the browser's real share picker and system-audio capture; real text-to-speech through speakers
and a real room; the user's voice; the AI provider with a real model (the stub returned the notes JSON); long
meetings. Raw run outputs are kept with the session, not committed.
