# Screenshot Intelligence

Take a screenshot in the NUMZ AI **desktop app** and ask about it. The picture is looked at by the vision model, and what it saw becomes part of
the ordinary conversation you already have open, so follow-up questions just work. Branch `feature/screenshot-intelligence`; **not merged,
not deployed**. The desktop layer is described in [`desktop/README.md`](../desktop/README.md).

## What a person does

1. Press the capture button next to the attach button, and choose **Full screen**, **Choose an area** or **A window…**.
2. A preview appears in a panel above the message box. For an area, drag on the preview. Optionally type a question.
3. **Analyse.** The analysis runs in the background: keep chatting, or **Cancel** it. When it is done, the question and the reading join the
   conversation, with a *Screenshot* chip on the question.
4. Ask follow-ups in the panel (they look at the picture again, while the server still holds it) or in the normal message box (they use the
   analysis that is already in the conversation).
5. **Retry** after a failure. **Delete screenshot** (in the panel, or the × on the chip) removes the picture and its messages everywhere.

In a plain browser the button explains that screenshots are taken by the desktop app. Nothing is captured by the page itself.

## What it reads

One vision prompt (`server/screenshots/screenshotPrompts.js`) covers: what the screen shows, **exact visible text (OCR)** where the text is the
point, **error diagnosis** (meaning, likely cause, first fix), **code interpretation** (what it does, bugs), **interface recognition** (controls,
state, next action), **document / table / form extraction**, and a plain explanation of anything else. Text *inside* the screenshot is treated as
content to report, never as an instruction to the model. The reply is Markdown and goes straight into the conversation.

## How it fits the existing code (nothing is duplicated)

| Piece | Reused |
|---|---|
| Conversations | the assistant's own sessions and saved history (`sessionService`, `conversationRepository`); a screenshot is two ordinary messages |
| Vision model | the Smart Camera's provider and settings (`CAMERA_VISION_*`, `server/camera/vision.js`); no second configuration |
| Access, limits | the assistant access gate (`chat` capability), per-person ownership, the usage meter (`vision_read` / `vision_answer`, so a screenshot counts as a picture in the daily allowance) |
| Chat thread | `chatController` / `chatView` (the Screenshot chip is an attachment chip), `attachments.js` (`splitMessage` reads the marker) |

New: `server/screenshots/*`, `server/routes/screenshots.js`, `src/interfaces/screenshot/*`, `desktop/*`.

## Server API (all behind the assistant's gate, nothing cacheable)

| Route | Notes |
|---|---|
| `POST /api/v1/assistant/screenshots?conversation=<id>` | body = the picture (`image/png`, `jpeg`, `webp`); optional `X-Screenshot-Question` (percent-encoded) and `X-Screenshot-Id` (a UUID the page chooses). `202 { id, status: 'analyzing' }` |
| `GET /:id` | `analyzing \| ready \| failed \| cancelled`, `analysis`, `error`, `retryable`, `pictureKept` |
| `POST /:id/cancel`, `/retry` | cancel writes nothing to the conversation; retry reruns on the picture still held (`410 picture-expired` once dropped) |
| `POST /:id/ask { question }` | a follow-up that looks at the picture again (`410` once dropped) |
| `DELETE /:id[?conversation=<id>]` | idempotent; removes the picture and the screenshot's messages; works for an id the server no longer knows when the conversation is named |

Error codes the page acts on: `invalid-image`, `image-too-large`, `invalid-question`, `invalid-id`, `duplicate-id`, `conversation-not-found`,
`vision-not-configured`, `screenshot-busy` (+ `Retry-After`), `picture-expired`, `too-many-attempts`, `too-many-questions`, `not-analysed`,
`screenshot-not-found`, and, in a failed analysis: `timeout`, `vision-busy`, `vision-unavailable`, `vision-unreachable`, `vision-refused`,
`vision-rejected`, `empty-analysis`, `conversation-gone`. The provider's own words never reach the page.

## Privacy and retention (the Smart Camera's rule, applied to screenshots)

* **The picture** is held in server memory only, for 10 minutes (`pictureKeptMs`), a few per person; it is never written to disk or to the saved
  conversation, and is dropped on delete, when its conversation is deleted, and on restart. The page keeps what it sent in memory until the
  panel is closed or the screenshot deleted; the desktop app holds a capture in memory for at most 5 minutes (two at a time).
* **What the model said** is saved in the conversation like any message, so it is private to its owner, appears in their history, and goes when the
  conversation goes. Another person's screenshot id is "not found".
* **Logs** carry ids, statuses and sizes only: never a picture, a question or an answer.
* **Spend:** each analysis and each follow-up is one metered call; the person's daily allowance and the spending thresholds apply before anything
  is sent. Viewers have 30 pictures a day by default (`AI_QUOTA_OVERRIDES`).

## Failure handling

Invalid or oversize pictures are refused before any model is asked (kind and size are read from the bytes; the desktop layer sends a JPEG of at
most 2048 px on its long side, and the page re-sends smaller by itself if the server still finds it too large). A model that is slow, down,
refusing or reachable no more is reported in plain words with Retry when retrying can help. A lost upload answer is recovered by the id the page
chose. Cancelling aborts the request to the model and writes nothing. A conversation that ends mid-analysis fails the analysis cleanly.

## Tests

`node --test server/screenshots/*.test.js server/api/screenshotRoutes.test.js tests/screenshotController.test.js tests/screenshotChat.test.js`
(or `npm test`). The desktop layer's own checks (Rust unit tests, the real-X11 capture check and the real-app end-to-end run) are in
[`desktop/README.md`](../desktop/README.md).
