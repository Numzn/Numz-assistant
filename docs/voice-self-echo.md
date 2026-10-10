# The assistant hearing itself

Hands-free voice mode listens through the microphone while the assistant speaks through the speakers. The
assistant's own voice reaches the microphone, and was being taken for the user.

## What was wrong (reproduced in `tests/voiceInputLocal.test.js` against the unmodified code)

| Mechanism | What happened |
|---|---|
| Interruption by its own voice | While it spoke, any sound above a fixed level (0.04 RMS) for 600 ms counted as the user interrupting. A laptop's speakers are louder than that in their own microphone: **6 interruption events in 4 s** of the assistant talking. |
| Listening again at once | When speech ended, listening restarted in the same instant. The tail of its last words (speaker, room, output buffer) was captured as an utterance and answered. |
| Cooldown re-opened mid-turn | A timer re-enabled speech detection 1.2 s after the user finished, while the request was still in flight. A capture started then was still recording when the assistant began to speak, and was transcribed: the assistant's own reply became a command. |
| Late and empty results | An empty capture arriving mid-reply reset the turn (busy, speaking, listening). A reply that returned after an interruption could be spoken, and the next command was turned away as "busy". |

## What it does now

- **Interruption** must exceed the assistant's own loudness in this microphone by `vadBargeInEchoRatio`
  (default 1.8). That loudness is measured during the first `vadBargeInGuardMs` (500 ms) of audible speech and
  followed slowly upwards; nothing counts as an interruption while it is being measured. One interruption is
  reported per reply.
- **After the assistant stops**, the microphone is ignored for `vadPostSpeechSettleMs` (700 ms); after an
  interruption only `vadBargeInSettleMs` (150 ms), because the person is already talking.
- **Detection stays off for the whole turn.** A capture that overlaps the assistant's speech is thrown away
  (`onRejected({ reason: 'overlapped-playback' })`), never transcribed, never reported as an error.
- **A turn that is interrupted, stopped, or overtaken by a meeting is over.** Its late reply is not spoken and it
  no longer holds the next command off. The next command is held (not dropped) until the abandoned request has
  settled, for at most `interruptSettleMs` (6 s), because the server keeps generating an interrupted reply and
  sends it on the same connection.
- **A capture is answered once**, by its identity (`captureId`), never by its words: saying the same thing twice
  is two commands. A final that began before the last interruption or stop is dropped.
- **Speech that never reports its end** is cut after a generous watchdog (`ttsWatchdogMs`, otherwise 15 s plus
  150 ms per character) and listening resumes.

Unchanged: the microphone constraints (echo cancellation and noise suppression on, gain off; the meeting recorder
shares them), the meeting live path and its persistence, and the buffered `/stt` path.

## What it cannot do

- **Energy cannot tell two voices apart.** The ratio test is a conservative fallback, not echo cancellation.
  With speakers, a user has to be clearly louder than the assistant (or press interrupt) to cut it off; a voice
  that is present from the very first moment of a reply is taken to be the assistant's own.
- **Browser echo cancellation is not guaranteed for speech synthesis.** Whether it removes the assistant's voice
  depends on the browser, the operating system and the voice. Headphones remove the problem.
- **The server does not stop an interrupted reply.** It keeps generating and sends the rest on the same
  connection. The held next command (above) keeps that tail out of the new reply in the usual case; fixing the
  server (abort the stream, tag events with a turn id) is the real answer and is not part of this change.
- **The defaults are conservative starting points, not measured values.**

## Manual test (needs a real browser and microphone)

Use Chrome with the laptop's own speakers at a normal volume. Open the app, start voice mode, and open the
console (`?debug` shows the voice timings).

1. **No self-interruption.** Ask something that gets a long answer ("explain how a car engine works"). Do not
   speak while it answers. It should speak to the end without cutting itself off, and then listen again.
2. **No echo turn.** After it finishes, stay silent for 10 s. It must not start a new turn or answer itself.
3. **Normal command after speech.** About a second after it finishes, say a short command. It should be heard
   and answered once.
4. **Interruption.** Ask for a long answer, then talk over it clearly, louder than it is (close to the
   microphone). It should stop within about a second and listen. Say a new command: it should be answered,
   after a pause of a few seconds at most.
5. **Interrupt button.** Press interrupt while it speaks: it stops at once and listens.
6. **Headphones.** Repeat 4 with headphones on: the interruption should now work at normal speaking volume.
7. **Meeting.** Start a meeting while it speaks: it must fall silent, and nothing it said is recorded.

If step 1 or 2 fails, raise `vadBargeInEchoRatio` (2.2) or `vadPostSpeechSettleMs` (1000) in
`src/config/settings.js`. If step 4 is hard to do, lower `vadBargeInEchoRatio` (1.5), or use headphones.
Record what you change.
