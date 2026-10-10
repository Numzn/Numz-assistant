# Home screen (NUMZ Presence)

One static page (`index.html` + `style.css` + `src/main.js`, vanilla ES modules, no framework). There is no router and
no other screen: Home is the only one. It shows a header (NUMZ, New chat, Meeting, Settings), "What can I help with?",
the current conversation, and a composer fixed at the bottom. No dashboard, recent list or transcript preview.

## How the pieces fit

| Piece | File | Role |
|---|---|---|
| Conversation state | `src/interfaces/chat/chatController.js` | The thread and sending. No DOM. Draws the thread from the events the request path already emits, so typed and spoken turns land in one thread. |
| Conversation view + composer | `src/interfaces/chat/chatView.js` | DOM only. Enter sends, Shift+Enter is a new line (not during IME composition), Escape cancels, text is set with `textContent`. |
| Typed message | `assistantController.submitText()` | The same `requestReply` path as a spoken turn (stream first, JSON fallback, same session). The reply is not spoken; the turn never enters SPEAKING and the state returns to IDLE. |
| New conversation | `assistantClient.createSession()` | A new server session (the server keeps context per session), then an empty thread. |
| Voice mode | `main.js` + `voiceOrchestrator` | Enter from the composer's microphone; the orb, one status word, Stop and End. `startConversation()` returns `{ ok }` or `{ ok:false, reason }`. `interrupt()` stops speech and the stream. |
| Orb | `src/animation/animator.js`, `core/core.js` | Reads the real assistant state machine; while LISTENING also the real microphone level (`voiceInputLocal.getInputLevel`). Drawn only in voice mode. |
| Meeting commands | `src/interfaces/commands/meetingCommands.js` | One router for typed and spoken input. |

## What is real and what is not

- The orb follows the **real state machine**. While listening it also follows the **real microphone level**. While the
  assistant speaks it follows the state only: browser speech synthesis exposes no playback level, so none is shown.
- Nothing in the UI says a meeting or transcript was saved or verified unless the meeting controller's own state says so
  (`integrity.verified` from the backend). Command replies repeat that state; they never add a claim.
- An attachment control is not offered: there is no upload endpoint.
- Replies are plain text (`white-space: pre-wrap`); markdown is not rendered.

## Meeting commands

Matched only as the **whole message** (after politeness words like "please", "can you", "let's"):

- start: "start / begin / open / launch / create / record (a|the|my|new) meeting", optionally "called|named|titled X".
- stop: "stop / end / finish / close / complete / wrap up / save (the|this) meeting", also "...and save".
- "stop recording" counts only while a meeting is recording.

"How do I start a meeting with a customer?" is a question and goes to the assistant.

- **Start** only opens the meeting panel (and fills the title). The launch code is typed by a person there; nothing here
  holds or sends it, and the meeting ticket stays inside the meeting controller.
- **Stop** asks for confirmation ("yes" / "no", valid for 60 s) and then calls `meetingController.stop()`.
- While a meeting is open the assistant stands down (it owns the microphone), so ordinary messages and voice mode are
  refused with a stated reason, and **stopping is done by typing** "stop meeting": a spoken stop would be recorded
  into the meeting.

## Manual browser checks

1. Allow the microphone in voice mode, speak, and watch the orb brighten with your voice (Listening).
2. Block the microphone in the browser and press the voice button: the composer must say access is blocked.
3. Start voice mode, ask something long, press Stop (and Esc): speech and the stream stop and it listens again.
4. Open a real meeting (with the launch code), type "stop meeting", answer "yes", and read the result: it must be the
   controller's message (verified, or not verified), never a bare "saved".
5. Turn on "reduce motion" in the operating system: the orb must not move.
6. Look at a phone-width window and at keyboard-only navigation (Tab order, visible focus rings).
