# Speech Intelligence pipeline

One engine, two execution modes, one canonical transcript format.
Production foundation for Otter-class lecture/meeting processing, kept
local-first and separate from the live conversational voice path. See
[architecture.md](architecture.md) for the live assistant pipeline this
does not touch.

```
Batch:  audio file -> VAD -> ASR (+ word timestamps) -> alignment ->
        diarization -> reconciliation -> canonical transcript -> AI notes

Live:   audio frames -> frame VAD -> endpointing -> streaming ASR ->
        partial/stabilizing/final events -> LiveSpeechSession ->
        canonical transcript (same schema) -> optional reprocessing pass
```

Both converge on the identical, unmodified `audio/speech/schema.py` —
`npm run speech:notes` (and any future search/Q&A/summary capability)
works the same on either source without knowing which one produced it.

## Relationship to the live STT path

`audio/server.py` + `audio/transcribe.py` (the Flask sidecar the live voice
assistant talks to via `/api/v1/assistant/stt`) are unmodified in behavior.
`transcribe.py` gained one internal refactor — the whisper call was
extracted into `_transcribe_segments()` — so `transcribe_pcm_with_timestamps`
and `speech/asr.py` reuse the same decode parameters instead of keeping
copies; `transcribe_pcm()` and `transcribe_blob()` (what the live path
calls) return byte-identical results to before.

Everything else lives in `audio/speech/` and is only reachable through the
batch CLIs below — the state machine, controller, voice orchestrator,
assistant orchestrator, and `/api/v1/assistant/stt` route are untouched.

## Stages and interfaces

| Stage | File | Default backend | Swappable? |
|---|---|---|---|
| VAD | `audio/speech/vad.py` | Silero VAD bundled with faster-whisper | Yes — `LectureVadOptions` + `detect_speech_regions()` |
| ASR | `audio/speech/asr.py` | `FasterWhisperAsr` (word_timestamps=True) | Yes — anything exposing `.transcribe(pcm, sample_rate, language, prompt) -> AsrResult` |
| Alignment | `audio/speech/alignment.py` | `WhisperNativeAlignment` (pass-through) | Yes — seam for a future forced-aligner (e.g. wav2vec2/CTC) |
| Diarization | `audio/speech/diarization.py` | `NullDiarizer` (single implicit speaker) | Yes — `PyannoteDiarizer` real backend, opt-in |
| Reconciliation | `audio/speech/reconcile.py` | — | Merges ASR words + diarization turns into canonical segments |
| Orchestration | `audio/speech/pipeline.py` | — | `process_lecture_file()` (file in) and `process_pcm()` (in-memory PCM in — also used by live post-meeting reprocessing) |

**Why not WhisperX/forced alignment by default:** faster-whisper 1.2.1
(already installed) supports `word_timestamps=True` natively — real
per-word timestamps with zero new dependencies. The `alignment.py`
interface exists so a real forced-aligner can replace
`WhisperNativeAlignment` later if cross-attention timestamps prove too
imprecise for a specific feature, without touching `asr.py`/`reconcile.py`.

**Why VAD doesn't drive decoding directly:** faster-whisper's manually
supplied `clip_timestamps` silently transcribes only the first 30s of any
single region longer than that. `asr.py` instead passes tuned
`VadOptions` into faster-whisper's own `vad_filter=True`, whose internal
chunker already splits long speech safely. `vad.py`'s standalone
`detect_speech_regions()` is used for metadata (pause structure,
diarization windowing), not for slicing decode boundaries.

## Canonical transcript schema

`audio/speech/schema.py`, versioned via `schemaVersion` (currently `"1.0"`).
Segments carry `id`, `start`/`end`, `text`, `words[]` (each with its own
`start`/`end`/`confidence`), `speaker`, `speakerConfidence`, `confidence`,
`language`, and `uncertain`.

`speaker` is one of: a real label (`"speaker_00"`), `"overlap"` (two
diarization turns claim the same timestamp — genuine simultaneous speech),
or `null` (no diarization turn covers that timestamp). Both of the latter
set `uncertain: true` — reconcile.py never guesses an attribution.

## Diarization: enabling pyannote

Off by default (`NullDiarizer`) — no extra download, no auth, no heavy
dependency. To enable real speaker diarization:

```bash
# 1. Create/accept the gated model's terms:
#    https://huggingface.co/pyannote/speaker-diarization-3.1
# 2. Create a token: https://huggingface.co/settings/tokens
# 3. Install the optional extra:
audio/.venv/bin/pip install -r audio/requirements.diarization.txt
# 4. Set the token (in .env.secrets or your shell):
export HF_TOKEN=hf_...

npm run speech:process -- lecture.mp3 --diarize
```

Not installed or verified live in this environment (no HF token, and this
machine runs tight on RAM — see the pipeline's own error message if you
hit either issue).

## CLI usage

```bash
# New: full pipeline, canonical schema, optional diarization
npm run speech:process -- lecture.mp3 [--diarize] [--lang en] [--out transcript.json]
npm run speech:notes -- lecture.transcript.json [out.json]

# Phase 0 (still supported, untouched): plain timestamped transcript, no
# speakers, and free-text Markdown notes instead of grounded/cited JSON.
npm run lecture:transcribe -- lecture.mp3
npm run lecture:notes -- lecture.mp3.transcript.json
```

`speech:process` writes both `<out>.json` (canonical schema) and
`<out>.txt` (human-readable `[HH:MM:SS] Speaker N` blocks). `speech:notes`
writes one JSON object — `{ summary, keyTopics[], importantConcepts[],
questions[], studyNotes[] }` — where every item's `source` cites the real
`segmentIds`/timestamps it was drawn from, for future jump-to-source /
grounded Q&A. Falls back to `{ notes: null, raw, parseError }` if the
configured model doesn't return valid JSON.

## Live mode

`audio/speech/live/` — a separate subpackage from batch, importing *from*
`speech/*.py` (reuses `FasterWhisperAsr`, `schema.py`) but never the other
way around; batch has zero knowledge of live.

| Concern | File | Approach |
|---|---|---|
| Frame VAD | `live/frame_vad.py` | Adaptive noise-floor RMS gate with hysteresis that decides only where an utterance **starts and ends**: every frame in between, quiet ones included, plus 0.3 s of lead-in before the start, goes to the recognizer (`live/session.py`). It opens at 2.5x the learned floor and stays open down to 1.6x (hysteresis), never opens below an absolute minimum (`LIVE_GATE_MIN_DBFS`, default -56 dBFS, an **experimental** starting value measured on one recording), seeds the floor from the first second only when that second is steady (speech at the start must not be learned as noise), treats a frame 20 dB under the speaker's recent level as a pause that teaches the floor quickly (otherwise a pause noisier than the first second's floor never ends an utterance), and re-learns the floor when an open run stays within 3.5 dB for 3 s (a fan or hum). Until 2026-10-09 it was an absolute floor (-34, then -42 dBFS): on the JFK clip through real Whisper the word error rate was 4.5% at -40 dBFS, 27% at -44, 73% at -48 and 100% at -52. Not Silero. Silero's state-handling across separate incremental live-frame calls isn't verified by this pass; getting that subtly wrong would be worse than a well-understood energy gate. Swappable — the session only needs a bool per frame. |
| Endpointing | `live/endpointing.py` | Distinct from VAD: "has this turn probably ended?" not "is this speech?". Configurable tiers (`EndpointerConfig`) rather than one threshold — `CONVERSATION_PROFILE` (tight, turn-taking) and `LECTURE_PROFILE` (loose, continuous speech) presets. Fires `FORCED_END` past `max_utterance_ms` even with zero silence, so unbroken lecture speech still gets endpointed. |
| Streaming ASR | `live/streaming_asr.py` | `LocalAgreementStreamingAsr`: re-decodes a growing buffer on each tick (reusing `FasterWhisperAsr` — no second model), greedy for ticks (beam 1, one temperature, no word timings), beam 5 with temperature fallback and word timings once on `flush()`. Ticks are **paced**: a decode costs about 1.7 s on this server however short the audio (Whisper always encodes a 30 s window), so the next preview waits until previews use at most a third of real time; FINAL decodes never wait. Measured on real speech (2026-10-09): 0.6-0.7x real time, against 4.4x for the old every-second, beam-5 ticks. Meetings get **no prompt** (Whisper imitates its prompt; the old comma-separated keyword list produced loops like "NUMZ, NUMZ, ..."), and any loop that survives the fallback is collapsed (`speech/repetition.py`). Text that stays an exact prefix match across two consecutive ticks is STABILIZING; new tail text is PARTIAL; `flush()` (endpointing-triggered) emits FINAL. This is the standard whisper_streaming-style approach, not a novel algorithm. |
| Live speaker handling | `live/diarization_live.py` | `SingleSpeakerLiveDiarizer` (default): one honest anonymous speaker. Real-time diarization needs an incremental embedding+clustering model kept resident for the whole session — a second always-loaded model, which this machine's resource constraints rule out. Running batch pyannote (whole-file global clustering) on tiny live chunks would not produce stable labels either, so it isn't attempted. `LiveDiarizer` stays a real interface for a future streaming-embedding backend. |
| Session | `live/session.py` | `LiveSpeechSession` — ties the above together, accumulates FINAL events into canonical segments (`schema.make_segment`, same schema batch uses), exposes `snapshot()` (current partial state) and `finalize()`. |

**Partial text is never canonical.** Only a FINAL `TranscriptEvent` ever
becomes a canonical segment (`session._commit_final`) — `PARTIAL`/
`STABILIZING` only ever reach `session.partial_transcript` /
`on_transcript_event()` subscribers.

**Post-meeting processing** (`LiveSpeechSession.finalize()`): if the
session retained raw audio (`keep_audio_for_reprocessing=True`), `finalize()`
re-runs the *batch* pipeline (`pipeline.process_pcm()` — full-quality ASR,
optional real `PyannoteDiarizer`, `reconcile.py`) on the complete
recording, superseding the live-provisional segments — `meta.finalization`
is `"reprocessed"` vs `"live-only"` so a consumer knows which it got. This
is the "final offline pass may improve speaker attribution" behavior,
and it's how real (pyannote) diarization ever applies to a live
session — never on tiny live chunks, only on the full recording afterward.

**Rolling meeting intelligence** (`server/services/rollingIntelligenceService.js`):
`createRollingIntelligenceTracker()` — `ingest(newSegments)` buffers
finalized canonical segments as they arrive; `snapshot()` asks the
existing AI provider (`generateResponse`, unmodified) to merge them into a
running `{ currentTopics, decisions, openQuestions, actionItems,
importantPoints }` view, each item citing real segment IDs/timestamps.
It's a merge (carries forward + updates), not a restart each time. Not
connected to the live transport (Planned) — this is the backend seam,
verified directly with fabricated finalized segments.

**Latency vs. accuracy are genuinely different configurations**, not one
setting: live ticks use fast/greedy decoding and loose energy-based VAD;
`flush()`'s FINAL decode is already higher-quality than ticks; and
`finalize(reprocess=True)` goes further still, using the full batch
pipeline's beam search + real diarization. Nothing forces live and batch
onto the same knobs.

**Not built (as directed):** no speaker embedding/enrollment, no meeting
UI. `LiveSpeechSession` is complete and tested via direct frame-feeding
(synthetic and fake-ASR-scripted). A real audio source is now wired to it
— see "Connecting real audio (transport)" below.

## Connecting real audio (transport)

`audio/live_speech_ws.py` — a WebSocket bridge between a real audio source
and `LiveSpeechSession`. Lives on the **audio sidecar** (`audio/server.py`,
via `flask-sock` — a tiny, single-purpose Flask WS extension, not a
parallel asyncio server), not the Node API: the session/ASR machinery is
Python, and this reuses that already-warm process rather than building a
new Node↔Python real-time bridge. The existing Node WebSocket
(`server/websocket/socketServer.js`, `/api/v1/assistant/ws`) is untouched
— it's a text-chat protocol, a different concern.

**Why not the existing MediaRecorder-based capture** (`voiceInputLocal.js`
/ `voiceInputRecorderServer.js`): both intentionally buffer a whole
utterance client-side before ever sending anything (right for batch STT
over HTTP, since the server needs a complete container to decode) — which
would mean no PARTIAL text could ever appear while the person is still
speaking. Live capture needs a different mechanism: raw PCM streamed
continuously as it's captured.

**Audio format contract (strict, validated at `start`, never silently
coerced):**

| | |
|---|---|
| Sample rate | 16000 Hz |
| Channels | 1 (mono) |
| Sample format | 32-bit float, little-endian, raw (no container/codec) |
| Frame/chunk duration | Client's choice (any length that's a multiple of 4 bytes); default capture chunk is 100ms (1600 samples) |

Chosen to match exactly what `LiveSpeechSession` already expects
internally — zero server-side format conversion, unlike the batch HTTP
path (which uses ffmpeg to decode arbitrary containers, fine for a
one-shot file but too slow to run per live chunk).

**Browser capture** (`src/interfaces/voice/liveSpeechClient.js` +
`public/worklets/pcm-capture-processor.js`): `AudioContext({sampleRate:
16000})` + `AudioWorkletNode` (not the deprecated `ScriptProcessorNode`,
not `MediaRecorder` — see above). The worklet batches the Web Audio API's
fixed 128-sample blocks into 1600-sample (100ms) frames before posting to
the main thread, which forwards each one as a WebSocket binary message.
**Not wired into the existing mic button / voice orchestrator.** The Meeting
panel (`src/interfaces/meeting/`, see [meeting-lifecycle.md](meeting-lifecycle.md))
uses it to record and save meetings, connecting through the server's
authenticated relay so it works from an HTTPS page. `public/live-speech-test.html`
remains a bare manual test page (Start/Stop/Pause/Resume + a live transcript
dump) for real-microphone validation. Dev-only (`npm run dev`) — imports
`/src/...` directly, which only Vite's dev server resolves, not a production build.

**Wire protocol, session lifecycle and persistence:** the authoritative description is in
[speech-architecture.md](speech-architecture.md) (persistence path, per-segment outcomes) and
[meeting-lifecycle.md](meeting-lifecycle.md) (meeting and session states, completion integrity). In
short: the client sends `start` (optionally with `meetingId` and `meetingTicket`), binary PCM frames,
then `stop`. The server answers `ready`, `PARTIAL`/`STABILIZING` text, `FINAL` segments with their
`persisted` outcome, `error`, and `stopped`. Without a meeting the session is standalone and a final
segment reports `NOT_PERSISTED`. With one, every committed segment goes to the durable outbox and then
to the meeting API, and `stopped` carries the persistence summary.

**Session lifecycle:** `start` creates a `LiveSpeechSession`; `pause`/`resume` are handled entirely at
the transport layer (a flag gating whether incoming frames reach the session). `stop`, a client
disconnect, or an idle timeout all end through one `finish()` path, exactly once: flush the last
utterance, persist every committed segment, retry what is waiting, report the session's committed count
to the meeting API, then build the summary transcript. A failure in a later step can never discard a
segment that was already committed.

**Recording:** audio is never written by default. Passing `saveRecording: true` in `start` opts in to a
WAV of the full session *and* requires the operator to set `LIVE_RECORDINGS_DIR`; both an explicit
per-session choice and an explicit operator configuration are required before anything touches disk, and
neither alone is enough. The audio is streamed to `<dir>/<speech-session-id>.wav` as the frames arrive (not
held in memory: 115 MB per hour on disk, nothing in RAM), with a header that is valid after every write, so a
crash or a dropped connection still leaves a playable file. The directory is created 0700 and the file 0600.
`ready.recording` says whether this session is being saved. A problem with the recording (no disk space, an
unwritable directory) is logged and carried by `recording: false`; it is never sent as an `error` frame,
because the browser treats every error frame as fatal and stops the microphone. What is recorded is exactly
what the recognizer was given (frames dropped while paused are not recorded), so a replay reproduces the
session.

**Error handling:** malformed audio (frame length not a multiple of 4
bytes) and an unsupported format are rejected with a clear `{"type":
"error"}` and never reach the session. An ASR/session exception on one
frame is caught, reported, and the connection stays open — already-
committed segments are never touched by a later failure. No per-decode
timeout/cancellation is implemented (Python can't cleanly interrupt a
synchronous faster-whisper call mid-decode without process-level
machinery, which is out of scope for this pass) — a 30s idle-timeout
bounds an abandoned connection instead.

**Tested:** `audio/tests/test_live_ws_integration.py` drives the real WebSocket handler as a real
client against the real Node meeting API and a real SQLite file, with only the speech model replaced by a
deterministic stand-in. It covers two sessions of one meeting, an API outage and recovery, a segment the API
refuses, and misconfigured starts. `test_live_transport_unit.py` covers finalization and decoder failures.
**Not tested automatically:** real speech content and real conversational timing (natural pause lengths,
whether `end_silence_ms` "feels right"), and the real Whisper model on this transport. No microphone can
be exercised in this environment. **Requires manual validation**: open `public/live-speech-test.html` via
`npm run dev`, speak into a real microphone, and confirm partial/stabilizing/final text reflects what was said.

## Known limitations (by design, not oversights)

- Notes generation is single-shot (no chunking/map-reduce) — fine for
  typical lecture lengths, may hit context limits on very long recordings.
- Tested with generated audio (VAD/decode plumbing) and hand-built
  transcripts with mocked diarization turns (reconciliation logic) — no
  real multi-speaker recording was available on this machine. Do not treat
  transcription/diarization *accuracy* as validated until run against a
  real recording.
- `PyannoteDiarizer` is implemented against pyannote.audio's documented
  3.x API but not exercised live (no HF token in this environment).
- Live mode has a real transport (`audio/live_speech_ws.py` +
  `liveSpeechClient.js`), verified end-to-end with a deterministic speech
  model (see "Connecting real audio" above). Real microphone content and
  real conversational timing have not been exercised; that requires the
  manual test page and a human.
- No per-connection decode timeout/cancellation on the live transport —
  documented as a known gap, not solved (see "Connecting real audio").

## Loops and the 20-second cut

**Repetition guard** (`speech/repetition.py`, applied in `speech/asr.py` and `transcribe.py`): Whisper sometimes
loops ("What's up? What's up? ..."), and emits the loop as many short segments, so the guard looks at the words of
the WHOLE decode, not one segment. It cuts a run of 4 or more repeats of a word or phrase of up to 8 words down to
one; three in a row ("no, no, no", "I like that, I like that, I like that") is speech people say and is kept.
Checked against 800+ real saved lines it changes nothing but genuine loops.

**The cut at the length limit**: continuous talk never gives the endpointer the 0.7 s of quiet it needs, so an
utterance is cut at 20 s. The cut is made at the quietest 100 ms frame of the last 3 s (`FORCED_CUT_WINDOW_S` in
`live/session.py`; 0 restores a cut at exactly 20 s). Everything up to it is finalized, everything after it is kept
as the start of the next utterance (`LocalAgreementStreamingAsr.flush_at`), so no audio is lost or decoded twice and
the segments stay contiguous. A cut at the clock lands mid-word: in real meetings 28% and 43% of lines ended this way
and words were lost or doubled at the join.

## Live diagnostics

Each live session logs `live-speech-diag {json}` once per minute of stream and once when it ends (the audio
sidecar's log, `logs/numz-assistant-audio.log`). Numbers only: no audio and no transcript text. The same
numbers arrive in the `stopped` frame as `diagnostics` (labelled with `meeting` when the session is bound to
one), so a meeting's behaviour can be read from the meeting itself instead of from a log file; a failure to
build them yields `null` and never costs the client its `stopped`. Fields:

| Field | Meaning |
|---|---|
| `frames.received / gateOpen / forwarded` | 100 ms frames received, frames the gate opened on, frames handed to Whisper (lead-in and the quiet frames inside an utterance count as forwarded) |
| `levelDbfs.p10/p50/p90/p99` | frame levels over everything received, in dBFS (upper edge of 2 dB bins). A microphone whose p90 is below about -50 is very quiet |
| `noiseFloorDbfs` | the floor the gate has learned |
| `longestQuietS`, `longestQuietInUtteranceS` | longest run of closed-gate frames overall, and inside an utterance (the one that cuts sentences) |
| `decodes.preview / final` | Whisper decodes: count, total and longest seconds, audio covered, `secondsPerAudioSecond` (above 1 the recognizer cannot keep up) |
| `decodes.slow`, `decodes.maxTemperature`, `decodes.maxCompressionRatio` | decodes of 10 s or more (each also logged alone as `live-speech-diag slow-decode {json}`), and the highest retry temperature and text compression ratio Whisper reached. A temperature above 0 with a compression ratio above 2.4 means it retried a repetitive decode, the suspected cause of 30-45 s decodes |
| `forcedCuts` | utterances that reached the 20 s limit with no pause and were cut (in a gap between words if there was one) |
| `lagS.last / max` | seconds behind real time when a frame finished processing (assumes the browser's real-time pacing) |
| `confidence.*` | over final decodes: mean/min `avg_logprob`, max `no_speech_prob`, and counts of segments below Whisper's -1.0 log-probability cut-off or above 0.6 no-speech probability. A line like "Bye." or "You" with a high no-speech probability is a hallucination on non-speech |

To read the gate for a meeting: if `levelDbfs.p90` is low and `frames.forwarded` is a small share of
`received`, the microphone is too quiet for the gate; lower `LIVE_GATE_MIN_DBFS` (restart the audio sidecar
to apply it) or raise the microphone level.

## Real-audio tests

`audio/tests/test_real_audio_gate.py` runs the JFK clip (`audio/tests/fixtures/jfk.wav`) through the real
session and Whisper at several levels and alignments, plus noise-only streams, and prints word error rate with
substitutions/deletions/insertions, dropped speech frames and false detections. It is opt-in because it loads
the model: `cd audio && NUMZ_REAL_ASR=1 .venv/bin/python -m unittest tests.test_real_audio_gate -v`.
It is ONE recording of one voice with synthetic noise; it does not prove the gate for other voices or rooms.

## Measuring real meetings: capture, replay, score

Until now accuracy was measured on ONE recording (the 11 s JFK clip) and speed from log lines. A meeting
that sounded wrong could not be reproduced. This is the loop that makes it reproducible: **capture** a real
session's audio, **replay** it through the live path, **score** it against what was said.

**1. Capture (two opt-ins, off by default).** The operator adds `LIVE_RECORDINGS_DIR=<dir>` to `.env` and
restarts the audio sidecar (it takes its settings from `.env` through its unit's `EnvironmentFile`; use
`audio/recordings`, which is git-ignored). The browser then asks with `?saveAudio=1` on the page address (or
`settings.voice.saveMeetingAudio`). `ready.recording: true` confirms it. Delete the files and unset the
variable when finished: they are meeting audio.

**2. Replay and score.**

```
npm run speech:replay -- audio/recordings/<session>.wav --reference ref.txt --pace 1 --json out.json
```

It feeds the recording to the same `LiveSpeechSession` as the sidecar, in 100 ms frames, and prints lines,
gate levels, decode cost, lag, confidence counts and, with a reference, word error rate with its
substitutions, deletions and insertions. It writes nothing to the outbox or the meeting API. `--pace 0` (the
default) decodes as fast as possible, to measure throughput; `--pace 1` delivers audio at microphone speed,
to measure the lag and the commit latency a person would see. The report also records the host's load, free
memory and the tool's niceness: **a timing is only comparable with another taken under similar conditions**
on this shared host.

It loads a second copy of the model (about 1.2 GB). It refuses to start under 1,800 MB available (`--force`
overrides), runs at low priority, and must not be run while a meeting is being recorded.

**3. Reference transcripts.** Plain text of what was said; case and punctuation do not matter; write numbers
as digits. The scorer is `audio/speech/scoring.py`, shared with the opt-in real-audio tests, so the numbers
compare.

**Baseline (2026-10-10).** One known-answer clip, scored two ways. The clip is LibriSpeech `dev-clean` speaker
2277 (CC BY 4.0, one reader, *Sister Carrie*): the first 34 consecutive utterances of chapters 149896 and 149897,
181.8 s, 528 words, joined with 0.8 s of digital silence. Its reference is LibriSpeech's own transcript.

| | Clean WAV through the live path | The same clip played through speakers, room, microphone and browser |
|---|---|---|
| How | `speech:replay --pace 1`, idle host (load 1.75, 2.4 GB free, niceness 10) | production meeting, browser AGC on |
| Raw WER | **0.025** (11 sub, 2 del, 0 ins) | **0.030** (12 sub, 2 del, 2 ins) |
| Genuine errors* | 5 words (0.9%) | 8 words (1.5%) |
| Lines | 34 (one per source utterance) | 18 |
| Final decodes | 34, 0.44 s per audio s, longest 2.85 s | 51 decodes over 370 s of stream, 0.20 s per audio s, longest 4.1 s |
| Lag behind the audio | max 4.0 s; a line is committed 2.2 s (median), 4.0 s (worst) after it ends | max 4.2 s |
| Fallback retries | none (max temperature 0.0) | none |

\* Raw WER minus differences that are spelling or number format, not recognition: the reference writes "to morrow",
"to day", "materialised", "one thirty" and "rector's"; Whisper writes "tomorrow", "today", "materialized", "1.30"
and "rectors". Both runs get the same rare words wrong (Drouet, Carrie, drearily).

How to read it: **the speaker-to-microphone path cost 3 words out of 528 on this clip**, which is not
distinguishable from run-to-run variation (a one-LSB change in the audio moved a punctuation mark in an earlier
check). The mic run has fewer lines because the clip's 0.8 s gaps sit only 0.1 s above the 0.7 s endpointing
threshold, and room noise and the browser's gain control eat part of a gap: that is a property of this fixture,
not a defect. This is read speech by one person in a quiet recording, so it is a floor, not a prediction for
meetings; and it cannot gate a *speed* change, because on clean audio the recognizer never retries. A baseline
for real meetings still needs a recorded meeting and its reference transcript.

**What it cannot tell you.** It measures this host, this model and the audio you give it. One clip is one
voice in one room: take at least a few, in the conditions meetings really happen in. It does not measure the
browser's microphone processing, the network or the Node relay; capture records what the sidecar received,
which is after all of those.
