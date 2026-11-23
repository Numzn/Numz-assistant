# The Home layout: sidebar, conversation and the dock

Written 2026-11-23, after the Study panel and the conversation were found fighting for the same space. This is what the layout does now,
why, and what has and has not been checked.

## What was wrong (measured in a real browser, on `main` 38d9a58)

- The **Study** panel was `position: fixed` over the right edge at every width. The **Meeting** panel was a grid column (an overlay under
  1100px). Nothing kept them apart.
- At the desktop app's default 1280px, Study covered the right 430px of the conversation, the composer's text box and the header's Meeting and
  Study buttons (so the button that could close it was under it). Open together, Study hid Meeting completely.
- Under 900px (the desktop app's smallest window is 720px) Study covered the whole conversation, which is where its answers are written.
- The workspace's implicit grid column grew to the header's width, so the conversation spilled under a docked panel, and was 31px wider than a
  390px phone.
- The composer's grid had three columns for four controls (the screenshot button had no column), so the text box was squeezed into a narrow
  right-hand column and the send controls sat on a second row. Already so on `main`, at every width.

## What it does now

One `#dock` (index.html) holds whichever panel is open; `src/interfaces/layout/dock.js` keeps it to one and sets `body[data-dock]` /
`body[data-dock-open]`. The panels still open and close by their own `hidden` attribute (their buttons, the voice command that opens Meeting, an
unfinished meeting reopening itself): the dock only watches it. `style.css` is the only place that says where the dock goes.

| Window | Layout |
|---|---|
| wider than 1100px | sidebar, conversation, dock (a column, `clamp(340px, 30vw, 420px)`). Nothing lies over the conversation. |
| 901 to 1100px | with a panel open the sidebar steps aside as the drawer it already is on a phone, so the conversation keeps 560 to 760px |
| 900px and under | the dock takes the conversation's place **under the header**; the header (sidebar button, Meeting, Study) is never covered, and pressing the open panel's button again is the way back. The conversation stays in the page, hidden, so its scroll position is there when the dock closes |

Also: the header button of the open panel reads as pressed; the model's name label is not drawn below 1400px while a panel is docked;
"Workspace /" is dropped from the breadcrumb while a panel is docked; the dock is not drawn in voice mode (like the rest of the page chrome); the
conversation stays on the newest message when it is narrowed by a panel (if it was there).

**Study answers are brought to the middle.** Whenever a study answer arrives, the conversation scrolls to put it in the middle of what is visible,
wherever the person was reading (and even while the panel covers the conversation, so it is there when the panel is put away). One taller than the
view starts at the top, to be read from its first line. The newest message has nothing below it, so some blank room is added under the conversation to let
it reach the middle; the next ordinary message gives the room back and the conversation follows replies as before. A resize keeps the answer in the
middle, but a person who scrolled away is left where they are. The arithmetic is `src/interfaces/chat/scrollPlan.js`.

**Long answers use width before height.** A study answer taller than the visible conversation is made to take less height, only as far as it needs: first
wider (up to 1180px instead of the 760px reading column, when the window has the room), then in smaller type (14.5px, then 13px, the floor). One that
already fits is left alone. If even the smallest does not fit it starts at the top, to be read from its first line. (`FIT_TIERS`/`pickFit` in
`scrollPlan.js`, `fitToView` in `chatView.js`, `.msg[data-fit]` in `style.css`.) This is for study answers, which arrive whole; ordinary replies stream in
and are not resized as they go.

**Show in chat.** A study answer is written into the conversation. Each answered card in the Study panel has a "Show in chat" button: where the
dock covers the conversation it is put away first, then the answer is brought to the middle and the exchange outlined for 1.8s (an outline, not an animation, so it
also shows with reduced motion). On a wide window the panel stays open beside it.

## What was checked

- `node --test tests/dock.test.js tests/studyController.test.js`, and `npm test` (1250 on the day).
- `node scripts/ui-layout-e2e/run.mjs`: real server, real broker, real **Chromium**, at 1600/1280/1200/1101/1100/1000/901/900/800/720/390px.
  It measures where things are and asks `document.elementFromPoint` whether the composer, the last answer, the header buttons and the panel's own
  controls would really be hit by a click (not a guess from the CSS).
- `node desktop/e2e/layout.mjs`: the same measurements (one shared function, `scripts/ui-layout-e2e/measure.mjs`) in the **real desktop app**
  (Tauri + WebKitGTK 2.52), in a real X window that a real window manager resizes, at 1280/1000/800/720px.
- `scripts/academic-e2e/run.mjs` (the Study panel's own flows) still passes; `scripts/ai-e2e/run.mjs`'s meeting checks pass.

## What was not checked

- Windows (WebView2) and macOS (WKWebView): the same CSS, not run there.
- A real phone and a real finger; 390px was run in desktop Chromium only. The desktop app cannot be narrower than 720px.
- The orb / voice mode with a panel open (the dock is hidden there by a CSS rule that was not exercised).
- A real model, and a study session that is really reading the screen next to this layout (desktop/e2e/study.mjs was not re-run).
- Keyboard focus order when the dock replaces the conversation on a narrow window (the conversation is `visibility: hidden`, so it is out of
  the tab order; not tested with a screen reader).
