"""
Replay a recording through the live speech path and score it. Operator tool; nothing here is part of the
running service.

  python replay_cli.py AUDIO [--reference TEXT_FILE] [--pace 0|1|N] [--language en] [--json OUT]

AUDIO is a WAV (16 kHz mono 16-bit streams straight from disk; anything else is decoded by ffmpeg and held in
memory). A session recorded by the sidecar (LIVE_RECORDINGS_DIR, see docs/speech-pipeline.md) is exactly that.

It feeds the audio in 100 ms frames to the same LiveSpeechSession the sidecar uses (the same gate, endpointing
and Whisper settings), so the result is what the live path makes of that audio. It writes nothing to the
outbox and talks to no meeting API.

  --pace 0   as fast as possible (default): measures how much faster than real time the recognizer decodes
  --pace 1   real time: audio arrives at the speed a microphone delivers it, so the lag and the commit
             latency are what a person in the room would see (takes as long as the recording)
  --pace N   N times real time

--reference is a plain-text transcript of the recording. Write numbers as Whisper does ("42", not "forty
two"): the scorer compares words, it does not convert numbers. The same scorer is used by the opt-in
real-audio tests (speech/scoring.py), so the numbers are comparable.

Cost: this loads a SECOND copy of the Whisper model (about 1.2 GB) next to the running sidecar, and
the host has little memory. It refuses to start when less than MIN_AVAILABLE_MB is available (--force
overrides) and runs at low priority. Do not run it while a meeting is being recorded.

Exit code: 0 done, 2 bad input, 3 refused for lack of memory.
"""

import argparse
import json
import os
import sys
import time
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

from speech import scoring  # noqa: E402
from speech.live.events import TranscriptStage  # noqa: E402
from speech.live.session import LiveSpeechSession  # noqa: E402

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1600  # 100 ms, the browser worklet's frame size
MIN_AVAILABLE_MB = 1800


class Recording:
    """An audio file as a stream of 100 ms float32 frames. A trailing piece shorter than a frame is dropped
    (the browser only ever sends whole frames) and its length is reported in `tail_s`."""

    def __init__(self, path: str, decoder=None):
        self.path = path
        self.tail_s = 0.0
        self.native = False
        self._decoder = decoder
        try:
            with wave.open(path) as wav:
                self.native = (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, SAMPLE_RATE)
        except (wave.Error, EOFError):
            self.native = False  # not a WAV the standard library reads: ffmpeg decodes it

    def frames(self):
        if self.native:
            yield from self._wav_frames()
        else:
            yield from self._decoded_frames()

    def _wav_frames(self):
        with wave.open(self.path) as wav:
            while True:
                raw = wav.readframes(FRAME_SAMPLES)
                if len(raw) < FRAME_SAMPLES * 2:
                    self.tail_s = len(raw) / 2 / SAMPLE_RATE
                    return
                yield np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

    def _decoded_frames(self):
        decoder = self._decoder
        if decoder is None:
            import transcribe

            decoder = transcribe.decode_audio_file
        pcm = decoder(self.path)
        whole = (len(pcm) // FRAME_SAMPLES) * FRAME_SAMPLES
        self.tail_s = (len(pcm) - whole) / SAMPLE_RATE
        for start in range(0, whole, FRAME_SAMPLES):
            yield pcm[start : start + FRAME_SAMPLES].astype(np.float32)


def _percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def replay(
    frames,
    *,
    language="en",
    streaming_asr=None,
    frame_vad=None,
    pace=0.0,
    clock=time.monotonic,
    sleep=time.sleep,
):
    """Feeds frames through a LiveSpeechSession and returns what came out and how it coped.

    pace 0 does not wait; pace > 0 delivers frame n at n * 0.1 / pace seconds after the start, and a slow
    decode makes later frames late, as it does in the sidecar. Times are wall-clock seconds."""
    session = LiveSpeechSession(language=language, streaming_asr=streaming_asr, frame_vad=frame_vad)
    started = clock()
    commits = []

    def on_event(event):
        if event.stage == TranscriptStage.FINAL:
            commits.append({"end": event.end, "wall": clock() - started})

    session.on_transcript_event(on_event)

    count = 0
    lag_last = lag_max = 0.0
    for frame in frames:
        count += 1
        position = count * FRAME_SAMPLES / SAMPLE_RATE
        if pace > 0:
            wait = started + position / pace - clock()
            if wait > 0:
                sleep(wait)
        session.ingest_audio_frame(frame, timestamp_s=position)
        if pace > 0:
            lag_last = max(0.0, (clock() - started) - position / pace)
            lag_max = max(lag_max, lag_last)
    session.end()
    wall_s = clock() - started

    audio_s = count * FRAME_SAMPLES / SAMPLE_RATE
    segments = session.finalized_segments
    text = " ".join(segment["text"] for segment in segments)
    commit_lags = [max(0.0, c["wall"] - c["end"] / pace) for c in commits] if pace > 0 else []

    diagnostics = session.diagnostics_summary()
    diagnostics.pop("lagS", None)  # measured here against the pace, not against the wall clock

    return {
        "audioS": round(audio_s, 2),
        "wallS": round(wall_s, 2),
        "pace": pace,
        "speedX": round(audio_s / wall_s, 2) if wall_s > 0 else None,
        "lagS": {"max": round(lag_max, 2), "last": round(lag_last, 2)} if pace > 0 else None,
        "commitLagS": (
            {"p50": round(_percentile(commit_lags, 0.5), 2), "max": round(max(commit_lags), 2)} if commit_lags else None
        ),
        "segmentCount": len(segments),
        "wordCount": len(scoring.words(text)),
        "text": text,
        "segments": [
            {
                "index": i,
                "start": segment["start"],
                "end": segment["end"],
                "text": segment["text"],
                "words": len(segment.get("words") or []),
            }
            for i, segment in enumerate(segments)
        ],
        "diagnostics": diagnostics,
    }


def score(result: dict, reference: str) -> dict:
    errors = scoring.word_errors(result["text"], reference)
    errors["excessRepeats"] = scoring.excess_repeats(result["text"], reference)
    return errors


def available_memory_mb(meminfo_path="/proc/meminfo"):
    """MemAvailable in MB, or None where it cannot be read (the check is then skipped)."""
    try:
        with open(meminfo_path) as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def host_conditions(niceness=None):
    """The load the numbers were taken under: a timing is only comparable with another taken under similar
    conditions, and this host is shared (other services, other sessions)."""
    try:
        load1 = round(os.getloadavg()[0], 2)
    except (AttributeError, OSError):
        load1 = None
    if niceness is None:
        try:
            niceness = os.nice(0)
        except (AttributeError, OSError):
            niceness = None
    return {
        "load1": load1,
        "cpus": os.cpu_count(),
        "memAvailableMb": available_memory_mb(),
        "niceness": niceness,
    }


def format_report(result: dict, scored: dict = None) -> str:
    d = result["diagnostics"]
    levels, frames, decodes, conf = d["levelDbfs"], d["frames"], d["decodes"], d["confidence"]
    pace = result["pace"]
    lines = [
        f"audio {result['audioS']} s, replayed in {result['wallS']} s at pace {pace:g}"
        + (f" ({result['speedX']}x real time)" if pace == 0 else ""),
        f"{result['segmentCount']} lines, {result['wordCount']} words, {d['forcedCuts']} forced cuts",
        f"gate: {frames['forwarded']}/{frames['received']} frames forwarded ({frames['forwardedShare']}); "
        f"level p10/p50/p90 {levels['p10']}/{levels['p50']}/{levels['p90']} dBFS; noise floor {d['noiseFloorDbfs']}",
        f"final decodes: {decodes['final']['count']} ({decodes['final']['secondsPerAudioSecond']} s per audio s, "
        f"longest {decodes['final']['longestS']} s); slow (>=10 s): {decodes['slow']}; "
        f"max temperature {decodes['maxTemperature']}; max compression ratio {decodes['maxCompressionRatio']}",
        f"confidence: {conf['lowLogprobSegments']} low-logprob, {conf['likelyNonSpeechSegments']} likely non-speech "
        f"of {conf['finalSegments']} decoded segments",
    ]
    if result["lagS"]:
        lag = result["lagS"]
        commit = result["commitLagS"] or {}
        lines.append(
            f"lag behind the audio: max {lag['max']} s, at the end {lag['last']} s; "
            f"line committed after its end: p50 {commit.get('p50')} s, max {commit.get('max')} s"
        )
    else:
        lines.append("lag: not measured (use --pace 1 to replay at the speed of a microphone)")
    host = result.get("host")
    if host:
        lines.append(
            f"host while replaying: load {host['load1']} on {host['cpus']} cpus, {host['memAvailableMb']} MB available, "
            f"niceness {host['niceness']} (compare timings only with runs under similar conditions)"
        )
    if scored:
        repeats = scored["excessRepeats"]
        lines.append(
            f"WER {scored['wer']} ({scored['substitutions']} substituted, {scored['deletions']} deleted, "
            f"{scored['insertions']} inserted, of {scored['reference_words']} reference words); "
            f"repeated phrases: {', '.join(repeats) if repeats else 'none'}"
        )
    return "\n".join(lines)


def _write_private_json(path: str, payload: dict):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.chmod(path, 0o600)  # O_CREAT honours the mode only for a new file


def run(argv, *, asr_factory=None, vad_factory=None, nice=10, out=None):
    out = out or sys.stdout
    parser = argparse.ArgumentParser(description="Replay a recording through the live speech path and score it.")
    parser.add_argument("audio")
    parser.add_argument("--reference", metavar="TEXT_FILE", help="plain-text transcript of the recording, to score against")
    parser.add_argument("--language", default="en", help="what the product sends for a meeting (default: en)")
    parser.add_argument("--pace", type=float, default=0.0, help="0 = as fast as possible, 1 = real time, N = N times real time")
    parser.add_argument("--json", metavar="FILE", dest="json_out", help="also write every measurement here (mode 0600)")
    parser.add_argument("--force", action="store_true", help=f"run even with under {MIN_AVAILABLE_MB} MB of memory available")
    args = parser.parse_args(argv)

    if args.pace < 0:
        print("--pace must be 0 or more", file=sys.stderr)
        return 2
    if not os.path.isfile(args.audio):
        print(f"no such file: {args.audio}", file=sys.stderr)
        return 2
    reference = None
    if args.reference:
        try:
            with open(args.reference, encoding="utf-8") as handle:
                reference = handle.read()
        except OSError as err:
            print(f"cannot read the reference: {err}", file=sys.stderr)
            return 2
        if not scoring.words(reference):
            print("the reference has no words to score against", file=sys.stderr)
            return 2

    available = available_memory_mb()
    if asr_factory is None and not args.force and available is not None and available < MIN_AVAILABLE_MB:
        print(
            f"refusing to start: {available} MB of memory available, and this loads a second copy of the speech "
            f"model (about 1.2 GB) beside the running service. Free memory, or pass --force.",
            file=sys.stderr,
        )
        return 3

    recording = Recording(args.audio)
    if not recording.native:
        print("(not a 16 kHz mono 16-bit WAV: decoding it with ffmpeg and holding it in memory)", file=out)

    if nice:
        try:
            os.nice(nice)  # the sidecar and the person in the room come first
        except (AttributeError, OSError):
            pass

    model = {}
    if asr_factory is None:
        import transcribe

        started = time.perf_counter()
        transcribe.warmup()
        model = {
            "name": transcribe.WHISPER_MODEL,
            "device": transcribe.WHISPER_DEVICE,
            "computeType": transcribe.WHISPER_COMPUTE_TYPE,
            "loadedInS": round(time.perf_counter() - started, 1),
        }

    result = replay(
        recording.frames(),
        language=args.language,
        streaming_asr=asr_factory() if asr_factory else None,
        frame_vad=vad_factory() if vad_factory else None,
        pace=args.pace,
    )
    result["host"] = host_conditions()
    result["tailDroppedS"] = round(recording.tail_s, 3)
    result["audio"] = os.path.basename(args.audio)
    result["language"] = args.language
    result["model"] = model
    result["gateMinDbfsEnv"] = os.environ.get("LIVE_GATE_MIN_DBFS") or None

    scored = score(result, reference) if reference is not None else None
    if scored is not None:
        result["score"] = scored

    print(format_report(result, scored), file=out)
    if args.json_out:
        _write_private_json(args.json_out, result)
        print(f"wrote {args.json_out}", file=out)
    return 0


def main():
    sys.exit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()
