# Real-meeting recordings for measuring recognition

Audio and reference transcripts in this directory are **private and never committed** (see `.gitignore`:
everything here except this file is ignored). They are the only honest benchmark for this host, microphone
and room: `jfk.wav` is one voice, studio quality, 11 seconds.

## Layout

```
audio/tests/fixtures/meetings/
  standup-2026-10-11.wav          16 kHz mono 16-bit (what a capture produces)
  standup-2026-10-11.ref.txt      what was actually said, in plain text
```

## Getting a clip

1. Operator: add `LIVE_RECORDINGS_DIR=/srv/projects/Numz-assistant/audio/recordings` to `.env` and restart the
   audio sidecar (it takes its settings from `.env`). Recording is still off until the browser asks.
2. Browser: open the app with `?saveAudio=1` and record a short meeting (three to five minutes is plenty; read
   from a script if you want an exact reference). The meeting message and `ready.recording` say it is on.
3. The file appears as `audio/recordings/<speech-session-id>.wav` (mode 0600). Copy it here, delete the original
   and remove `LIVE_RECORDINGS_DIR` when done: 115 MB per hour of recording.

## The reference

Plain text, one paragraph is fine. Case and punctuation do not matter. Write numbers as digits ("unit 42", not
"unit forty two"): the scorer compares words and does not convert numbers. Write what was *said*, not what was
meant: a stumble that Whisper transcribes is correct to keep.

## Scoring

```
npm run speech:replay -- audio/tests/fixtures/meetings/standup.wav \
    --reference audio/tests/fixtures/meetings/standup.ref.txt --pace 1 --json /tmp/standup.json
```

`--pace 1` takes as long as the recording and shows the lag a person would see; `--pace 0` is quick and
shows throughput. Run one replay at a time and never while a meeting is being recorded: it loads a second
copy of the model.
