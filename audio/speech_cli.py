"""
Numz Study Mode — Speech Intelligence pipeline CLI.

Produces the canonical, versioned, speaker-aware transcript
(speech/schema.py) from a recorded lecture/meeting file:
decode -> VAD -> ASR (+ word timestamps) -> alignment -> diarization ->
reconciliation.

Separate from the live conversational STT path (server.py/transcribe.py),
which this does not modify or depend on beyond importing its already-working
decode/model-loading helpers.

Usage:
    python speech_cli.py lecture.mp3
    python speech_cli.py lecture.mp3 --diarize --lang en --out lecture.transcript.json
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from speech.diarization import NullDiarizer, PyannoteDiarizer  # noqa: E402
from speech.pipeline import process_lecture_file, render_speaker_transcript  # noqa: E402


def main():
    parser = argparse.ArgumentParser(
        description="Numz Speech Intelligence: canonical timestamped, speaker-aware transcript."
    )
    parser.add_argument("audio_file", help="Path to the recorded audio file")
    parser.add_argument("--lang", default="", help="Language hint, e.g. en (default: auto-detect)")
    parser.add_argument("--prompt", default="", help="Extra domain vocabulary hint for Whisper")
    parser.add_argument(
        "--diarize",
        action="store_true",
        help="Enable pyannote speaker diarization "
        "(requires: pip install -r audio/requirements.diarization.txt, and HF_TOKEN set)",
    )
    parser.add_argument(
        "--out", default="", help="Output transcript JSON path (default: <audio_file>.transcript.json)"
    )
    args = parser.parse_args()

    if not os.path.isfile(args.audio_file):
        print(f"error: file not found: {args.audio_file}", file=sys.stderr)
        sys.exit(1)

    diarizer = PyannoteDiarizer() if args.diarize else NullDiarizer()

    try:
        transcript = process_lecture_file(
            args.audio_file, language=args.lang, prompt=args.prompt, diarizer=diarizer
        )
    except RuntimeError as err:
        print(f"error: {err}", file=sys.stderr)
        sys.exit(1)

    out_path = args.out or f"{args.audio_file}.transcript.json"
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(transcript, f, indent=2, ensure_ascii=False)

    txt_path = out_path[: -len(".json")] + ".txt" if out_path.endswith(".json") else out_path + ".txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(render_speaker_transcript(transcript))

    diarization_meta = transcript["meta"]["diarization"]
    print(
        f"Processed {transcript['durationS']}s of audio in {transcript['meta']['elapsedS']}s "
        f"({len(transcript['segments'])} segments, {len(transcript['speakers'])} speaker(s), "
        f"diarization={diarization_meta['engine']}) -> {out_path}"
    )
    print(f"Readable transcript -> {txt_path}")


if __name__ == "__main__":
    main()
