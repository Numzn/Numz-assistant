"""
Numz Study Mode — Lecture Engine (Phase 0 proof of concept).

Transcribes a recorded lecture audio file into a timestamped transcript,
reusing the same faster-whisper model and VAD settings as the live voice
sidecar (transcribe.py). This is an offline batch CLI, not a Flask route:
lecture files can run far longer than the live /transcribe endpoint's
timeout budget is designed for.

Usage:
    python lecture_cli.py path/to/lecture.mp3
    python lecture_cli.py path/to/lecture.mp3 --lang en --out lectures/week3.transcript.json
"""

import argparse
import json
import os
import sys
import time

from transcribe import SAMPLE_RATE, decode_audio_file, health_info, transcribe_pcm_with_timestamps


def transcribe_lecture_file(path: str, language: str = "", prompt: str = "") -> dict:
    t0 = time.perf_counter()
    pcm = decode_audio_file(path)
    segments, full_text = transcribe_pcm_with_timestamps(pcm, language=language, prompt=prompt)
    elapsed_s = round(time.perf_counter() - t0, 2)

    return {
        "source": os.path.abspath(path),
        "model": health_info(),
        "durationS": round(len(pcm) / SAMPLE_RATE, 2) if pcm.size else 0,
        "elapsedS": elapsed_s,
        "segments": segments,
        "text": full_text,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Transcribe a recorded lecture into a timestamped transcript (Numz Study Mode, Phase 0)."
    )
    parser.add_argument("audio_file", help="Path to the recorded lecture audio file")
    parser.add_argument("--lang", default="", help="Language hint, e.g. en (default: auto-detect)")
    parser.add_argument("--prompt", default="", help="Extra domain vocabulary hint for Whisper")
    parser.add_argument(
        "--out", default="", help="Output transcript JSON path (default: <audio_file>.transcript.json)"
    )
    args = parser.parse_args()

    if not os.path.isfile(args.audio_file):
        print(f"error: file not found: {args.audio_file}", file=sys.stderr)
        sys.exit(1)

    result = transcribe_lecture_file(args.audio_file, language=args.lang, prompt=args.prompt)

    out_path = args.out or f"{args.audio_file}.transcript.json"
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(
        f"Transcribed {result['durationS']}s of audio in {result['elapsedS']}s "
        f"({len(result['segments'])} segments) -> {out_path}"
    )


if __name__ == "__main__":
    main()
