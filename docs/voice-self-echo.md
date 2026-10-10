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

## Addendum (2026-10-10, same day): the first fix was not enough

The notes above describe the first fix. It missed a second, bigger cause, found when the assistant was observed
transcribing its own replies ("Want me to look something up?...") after that fix was live.

**The assistant declared itself done as it began to speak.** A reply reaches the speech output a chunk (sentence)
at a time, and each chunk waits for the one before it to finish. `endStream()` only knows about chunks already
handed to the browser, so when the reply finished streaming, usually before the first word was audible, there was
nothing to wait for and the turn ended. Listening restarted over its own voice, and after the settle pause it
captured and transcribed it. Measured in a real browser: state "Listening" at the same instant the first sentence
started; a capture 0.7 s later (the settle pause ending) while it was still talking; and only the first sentence
of the reply spoken (the later ones were dropped by an invalid SPEAKING-after-LISTENING state change).

The earlier tests missed it because their fake speech output covered the whole reply in one promise. The test
that reproduces it uses the real output module over a browser-like speech queue (`tests/voiceSpeechEnd.test.js`).

**Fix:** a reply is over only when the pending chunks have all been handed over and spoken *and* the output has
ended (`waitUntilSpoken` in the orchestrator). The tail of a reply goes through the same queue, so it is spoken
after everything before it.

**Also found: a quiet microphone.** The assistant asks the browser for the microphone with gain control off. On the
laptop it runs on (Realtek array), a normal speaking voice peaked at about 0.01 to 0.03 RMS against the fixed 0.02
detection floor: most speech never started a capture, and what did start lost its beginning. With gain control on,
as meetings record, the same voice was about three times louder. `settings.voice.autoGainControl` (default true)
now asks for it. Turn it off if a very loud room makes the assistant start on noise.

## Addendum (2026-10-10): a transcript-level guard, and what it was measured to do

The levels above work on sound. What still gets through is transcribed like any other speech, and by then only the
text is left to compare. The orchestrator keeps what it handed to the speech output (`src/interfaces/voice/selfEchoGuard.js`)
and asks one question of each transcript: *is this the assistant's own words coming back?*

A transcript is dropped (and listening carries on, exactly as for an empty capture) only when **all** hold:

1. its capture began while the assistant was speaking, or within `windowMs` (1.5 s) after it stopped;
2. it has at least 3 words;
3. at least 70 % of its words sit inside runs of 3+ consecutive words the assistant just said (a one-letter
   recognition slip in a word of 5+ letters, and a single slipped word between two echoed runs, are tolerated;
   common two-word phrases do not count);
4. it carries no interruption word the assistant did not say ("stop", "cancel", "wait", …).

Switch off with `settings.voice.selfEchoGuard = false`. A dropped transcript emits `voice:echo-suppressed` on the
event bus and a console warning with the text.

### Measured (deterministic corpus in `tests/selfEchoGuard.test.js`; re-run with `node --test tests/selfEchoGuard.test.js`)

| What | Result |
|---|---|
| The assistant's own speech caught (72 cases: 12 replies × exact, prefix, suffix, middle, noisy, noisy fragment) | **68 / 72 (94 %)**; exact, prefix, suffix and middle 12/12 each; noisy (15 % of words changed or lost) 9/12; noisy fragment 11/12 |
| Unrelated user speech dropped (36 cases) | **0 / 36** |
| User speech that overlaps the reply or quotes it, kept (36 cases, including talking over a reply with "wait no actually …") | **0 / 36 dropped** |
| User repeating the assistant's instructions word for word, 1 s after it stopped (3 cases) | **3 / 3 dropped** — the known cost |

Threshold sweep on the same corpus (echo caught / unrelated dropped): 0.4 → 72/72 / 0; 0.5, 0.6 → 71/72 / 0;
**0.7 (chosen) → 68/72 / 0**; 0.8 → 66/72 / 0; 0.9 → 63/72 / 0. The corpus cannot tell 0.4 from 0.7 on false
suppression, so the conservative end was kept: ignoring a person is a worse failure than answering an echo.

### What this does not tell you

- **The corpus is written text with simulated recognition slips.** It is not recordings of a real speaker in a real
  room. Real recognition errors, a different TTS voice and reverberation will move the numbers; nothing here
  replaces the manual test above.
- **The cost is real.** A person who says three or more of the assistant's words in order within 1.5 s of it
  stopping ("open the settings page", after it said "open the settings page, choose security …") is not heard and
  has to say it again. A capture that began later than the window is never judged.
- **Overlap is kept whole, not cleaned.** "…exactly noon what about tomorrow" is passed on with the echoed words in
  it; the guard never edits a transcript, it only drops or keeps it.
- **It sees only what this page spoke.** Another tab, another device, or a speaker playing other audio is outside
  it. In a meeting the assistant does not speak at all (it is suspended), so the guard has nothing to compare there.
