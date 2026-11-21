# Who said what in a live meeting: "You" and "Others"

A live meeting can be recorded from the microphone and from a shared browser tab or the system's audio at once. The
recognizer hears **one mixed stream** (that has not changed), but the page also measures each source on its own, and
the speech service uses that to tag every finished line.

| Tag | Means | Stored as |
|---|---|---|
| `you` | the microphone was sounding and the shared audio was not: the person who recorded the meeting | `speaker: "you"`, `uncertain: false` |
| `others` | the shared audio was sounding and the microphone was not: the people on the call (possibly several) | `speaker: "others"`, `uncertain: false` |
| `you` / `others`, uncertain | both were sounding, and one was at least about 10 dB (3x) louder | the label, `uncertain: true` |
| none | both about equal, or neither sounding, or no readings for the line | `speaker: null`, `uncertain: true` |

Without both sources (microphone only, tab only, one refused) nothing changes: lines keep the single-speaker label
`speaker_00`, as before.

## How it works

1. **Browser.** With both sources the recorder worklet ([`pcm-capture-processor.js`](../public/worklets/pcm-capture-processor.js))
   gets the mix on input 0, exactly as before, and the microphone and the tab on inputs 1 and 2 to be measured, not
   recorded. Each 100 ms frame is posted with the RMS of each input over exactly that frame's samples.
2. **Wire.** The `start` message names the sources (`"sources": ["microphone", "tab"]`). Once the service's `ready` says
   `"sourceLevels": true`, the client sends `{"type": "levels", "mic": 0.12, "tab": 0.0}` just before each audio frame
   (see the protocol in [`live_speech_ws.py`](../audio/live_speech_ws.py)). It sends none before that: an older service
   answers any unknown message with an error that ends the recording. A frame dropped because the connection is behind
   takes its levels with it.
3. **Sidecar.** [`source_labels.py`](../audio/speech/live/source_labels.py) keeps the last two minutes of levels on the
   stream clock the recognizer's events already use and labels each finished line from the frames inside that line's
   span. "Sounding" is judged against an absolute level (about -50 dBFS) and against each source's own floor learned
   from the meeting so far, because a levelled microphone reads high even in a quiet room.
4. **Server.** Nothing to migrate: `speaker` and `uncertain` were already stored. Two rules use the tag
   ([`speakerLabels.js`](../server/intelligence/speakerLabels.js)): a tag becomes an **owner** of an action only if it names
   one person, which only `you` does (a first-person "I will ..." from a clear `you`); `others` and placeholders such as
   `speaker_00` give "owner not stated". And the final-record and rolling prompts say what the tags mean.
5. **Panel.** Each line shows **You** or **Others** (with a `?` and a dashed outline when uncertain).

## Settings

| Variable (speech service) | Default | What it does |
|---|---|---|
| `LIVE_SOURCE_LABELS` | on | `0`, `false`, `off` or `no` turns the labelling off: `ready` then says `sourceLevels: false` and the page sends no levels |
| `LIVE_SOURCE_SOUND_DBFS` | `-50` | the quietest level a source counts as sounding (-90 to -20) |
| `LIVE_SOURCE_MIN_SHARE` | `0.25` | the share of a line's frames a source must sound in to count as present (0.01 to 1) |
| `LIVE_SOURCE_DOMINANCE_DB` | `9.54` (a ratio of 3) | how much louder one source must be when both sound (1 to 40 dB) |

**Every threshold is an unmeasured default.** None has been tried on real audio from a real call; the tests prove the
shape of the rule, not that the numbers suit a room.

## Limits

- It needs both sources: share a tab or the system's audio (Chrome or Edge; whole-system audio on Windows) as well as the microphone.
- "Others" is everyone else. Several people on the call are all "others"; telling them apart needs speaker
  diarization over kept audio, which is not built (audio is not kept by default, and `reprocessOnStop` is ignored for
  meetings).
- It cannot tell you from a second person in your own room, and cannot separate people talking over each other.
- With loudspeakers instead of headphones the microphone hears the call: lines become uncertain or unlabelled, not
  confidently wrong, as far as the thresholds allow. Use headphones.
- Lines before the service has agreed to levels (the first moment of a meeting) are unlabelled.
- Meetings recorded before this have `speaker_00` on every line, and stay that way.

## Rolling it out

Two parts ship separately and either order is safe; lines are tagged once both are in place.

- The page (the app image) sends `sources` in `start` and, only after the service says `sourceLevels: true`, the
  `levels` messages. Against an older speech service it sends no levels, and that service ignores `sources`.
- The speech service must be restarted to know about levels (`numz-assistant-audio.service`; it runs from the working
  tree, so a restart loads whatever is checked out). Against an older page, which declares no sources, it labels nothing
  and says `sourceLevels: false`. Restart it when no meeting is live.

The server's owner and prompt rules take effect with the app image. They also apply to meetings recorded earlier: their
first-person lines no longer show "owner: speaker_00".

To go back without a release, set `LIVE_SOURCE_LABELS=0` and restart the speech service: the page then sends no levels.
