# Home screen (NUMZ Presence)

One static page (`index.html` + `style.css` + `src/main.js`, vanilla ES modules, no framework). There is no router:
Home is the app, and the saved-conversations list has its own page (`history.html`). Home has three parts side by side:
a **sidebar** (brand, New chat, recent conversations), the **workspace** (header with the breadcrumb, Meeting and
Settings; the greeting or the conversation; the composer) and the **meeting panel**, docked on the right while a
meeting is open. The look is described under "Look and layout" below.

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
| Sidebar and header chrome | `src/interfaces/layout/workspace.js` | Recent conversations (a DOM-free list over `historyApi`, opened with the same `chat.open()` as `?conversation=`), the drawer the sidebar becomes on small screens, the online dot, and the model label. |
| Meeting panel | `src/interfaces/meeting/meetingPanel.js` | A view over `meetingController`: recording state, timer, transcript lines, and the summary card from the server's intelligence state. |

## Look and layout

Warm charcoal surfaces, cream text, brass accents, coral for recording, sage for success. Everything is a token at the
top of `style.css` (`--bg`, `--surface*`, `--accent`, `--danger`, `--ok`, `--font*`); nothing below hard-codes a colour.
Fonts are self-hosted Latin subsets (`src/assets/fonts/README.md`): Inter for the interface, Instrument Serif (italic)
for the greeting, JetBrains Mono for timers, timestamps, the model label and code. They load on use with
`font-display: swap`, so text shows at once in the system font.

| Width | Layout |
|---|---|
| over 1100 px | sidebar 272 px, workspace, meeting panel 360 px docked on the right (the conversation narrows) |
| 901 to 1100 px | sidebar stays; the meeting panel (340 px) lies over the right edge |
| 900 px and under | the sidebar is a drawer opened from the header (scrim, Escape and a pick all close it); the panel is full width |
| 600 px and under | one column of quick actions, no model label, compact paddings |

Voice mode hides the sidebar, conversation and composer; the orb's backdrop is tuned (`settings.colors.background`) to
render exactly the page colour, so the screen has no seam.

Contrast: the reference palette's muted text (`#81796f`) is 4.3:1 on the page and 3.7:1 on raised surfaces. The faint
text token here is `#968e84`, which is 4.97:1 on raised surfaces and higher elsewhere (WCAG AA is 4.5:1).

## What is real and what is not

- **No profile, user name, account switching or sign-out menu.** The app has one shared access code, not accounts, so the
  greeting is time-of-day generic ("Good evening."). `createChatView({ userName })` takes a name for when accounts exist.
  The sign-out equivalent is "Lock the assistant" in Settings, shown only when a code is set.
- **The model label** beside the composer shows what `/api/v1/health` reports (`aiModel`) and only when `aiConfigured`.
- **Quick actions** put their words in the composer; nothing is sent until you send it. "Summarize meeting" uses the
  real command "Show me the notes so far".
- **The waveform and the recording dot** follow the meeting controller: they appear only while recording, and the bars
  move only while a capture source reports sound (`sources[].state === "active"`, the same state the "sound heard" chip
  uses); otherwise they sit low and dim. The timer counts from the meeting's real start (`startedAt`).
- **Transcript lines have no speaker names** (the live transcript carries none), so there is no active-speaker
  highlight. The line being recognised right now is highlighted, and each saved line shows its time and whether the
  server stored it.
- **The summary card** renders the server's findings with their status labels. Action items show the owner and the due
  date as spoken, or "owner not stated" and "no deadline stated". There are **no checkboxes**: completion is not stored
  anywhere, and a control that does nothing would claim otherwise.
- Replies to meeting commands are drawn as a card labelled "Meeting"; other replies are ordinary messages.
- The orb keeps its steel-blue colours (see `settings.assistantVisual`); only its backdrop matches the new page.


- The orb follows the **real state machine**. While listening it also follows the **real microphone level**. While the
  assistant speaks it follows the state only: browser speech synthesis exposes no playback level, so none is shown.
- Nothing in the UI says a meeting or transcript was saved or verified unless the meeting controller's own state says so
  (`integrity.verified` from the backend). Command replies repeat that state; they never add a claim.
- Attachments are **text files only** (see below): the model behind the assistant takes plain text, so images, audio,
  PDFs and binary files are refused with a reason. There is no upload endpoint and nothing is stored but the
  conversation itself.
- Replies are drawn as Markdown (see below). Replies that are spoken in voice mode are not stripped of Markdown
  characters first; that is unchanged.

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

## Replies as Markdown

`src/interfaces/chat/markdown.js` parses a reply into a plain data tree and `markdownView.js` builds elements from it
with `createElement`/`createTextNode` only: nothing in a reply is ever parsed as HTML, so a reply containing
`<script>` shows that text. Supported: paragraphs, headings, nested lists, fenced code (with a Copy button), block
quotes, rules, simple tables, `code`, **bold**, *italic*, and links. Links must be http, https or mailto and open with
`noopener noreferrer`; any other target (`javascript:`, `data:`, relative) is not a link. A reply that is still arriving
renders sensibly (an unclosed code fence is a block that grows; an unfinished `**bol` stays text).

## Attaching text files

The attach button (and drag-and-drop) takes up to 3 text files, **60,000 characters in total** per message. Files are
read in the browser as strict UTF-8 (binary, NUL bytes, empty files and non-text types are refused). The assistant is
sent the typed text followed by each file under `[Attached file: name]` in a code fence longer than any run of
backticks in the file; the thread shows only the typed text and a chip with the name and size. **Cost to know about:** a
session re-sends its whole history to the model on every turn, so an attached file is re-sent each turn.

## Conversation history

Conversations are saved in the existing SQLite database (migration 4: `assistant_conversations`,
`assistant_messages`) as plain text, and **are kept until deleted**. The sidebar lists the 15 most recent (and opens
one in place, with the same `chat.open()`); the History screen (`/history.html`, linked from the sidebar when history is
on) lists them all, reopens one (`/?conversation=<id>`; the assistant continues with its context, even after a server
restart), and deletes one (a second click confirms) or all (an explicit confirmation naming the count). With history
off, the sidebar's list and the link are hidden.

- A conversation is created by its first message; sessions that never receive one (a page load, New chat) are not stored.
- A saving failure is logged and never breaks a chat.
- `ASSISTANT_HISTORY=off` (in `.env`) keeps conversations in memory only; the screen then says history is off.
- Routes (under `/api/v1/assistant`): `GET /conversations`, `GET|DELETE /conversations/:id`,
  `DELETE /conversations?confirm=all`.
- Privacy: what people type, and the contents of attached files, are stored in clear text in the database volume
  (`speech-database` in production). There is no automatic expiry.

## Access code

`ASSISTANT_ACCESS_CODE` protects `/api/v1/assistant/*` (including history), its WebSocket and `/api/v1/health/deepseek`.
`/api/v1/health` stays public.

- **Unset** (the default): nothing changes; the assistant is open to anyone who can reach the server, and the log says so.
- **12 or more characters**: people type it once on a card; the server answers with a signed, expiring session
  cookie (HttpOnly, SameSite=Strict, Secure over HTTPS, 12 h by default, `ASSISTANT_SESSION_TTL_S`). The browser never
  stores the code. Changing the code signs everyone out. Wrong codes are throttled (10 a minute, counted across callers).
  If a login expires mid-session, the card comes back. "Lock the assistant" in Settings signs out.
- **Set but shorter than 12**: the assistant is **locked** (503 everywhere) until fixed; it never falls back to open.

To switch it on: add `ASSISTANT_ACCESS_CODE=<a long random string>` to `.env.secrets` and restart. For the production
container, `.env.secrets` is read when the container is created, so recreate it:
`docker compose -f docker-compose.production.yml up -d --force-recreate --no-build`.
`scripts/verify-deployment.sh` logs in when `ASSISTANT_ACCESS_CODE` is in its environment (sent from stdin, never on a
command line) and otherwise skips the checks that need it. This is one shared code, not user accounts: everyone who has
it can read every saved conversation.

## Manual browser checks

1. Allow the microphone in voice mode, speak, and watch the orb brighten with your voice (Listening).
2. Block the microphone in the browser and press the voice button: the composer must say access is blocked.
3. Start voice mode, ask something long, press Stop (and Esc): speech and the stream stop and it listens again.
4. Open a real meeting (with the launch code), type "stop meeting", answer "yes", and read the result: it must be the
   controller's message (verified, or not verified), never a bare "saved".
5. Turn on "reduce motion" in the operating system: the orb must not move.
6. Look at a phone-width window (the drawer, the full-width meeting panel) and at keyboard-only navigation (Tab order,
   visible focus rings, Escape closing the drawer).
7. With a code set: the card appears on a fresh browser, a wrong code is refused, the right one loads the app, history
   needs it too, and Settings > Lock signs out.
8. Attach a real text file (and try a PDF and an image: both must be refused with a reason).
