"""
Local audio sidecar: faster-whisper with built-in VAD.
Run: python server.py  (default http://127.0.0.1:8765)
"""

import logging
import os

from flask import Flask, jsonify, request

from transcribe import health_info, transcribe_blob, warmup
from live_speech_ws import register_live_speech_route

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

HOST = os.environ.get("AUDIO_HOST", "127.0.0.1")
PORT = int(os.environ.get("AUDIO_PORT", "8765"))
WARMUP_ON_START = os.environ.get("AUDIO_WARMUP", "1") != "0"

app = Flask(__name__)
register_live_speech_route(app)  # ws://<host>:<port>/live-speech — see live_speech_ws.py


@app.route("/health", methods=["GET"])
def health():
    info = health_info()
    # Whether meeting persistence can work (disabled, misconfigured, degraded or ok). No secrets.
    info["persistence"] = app.extensions["live_speech_persistence"].status()
    return jsonify(info)


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if not request.data:
        return jsonify({"error": "Missing audio body", "text": ""}), 400

    mime_type = request.content_type or "audio/webm"
    if ";" in mime_type:
        mime_type = mime_type.split(";")[0].strip()

    language = request.headers.get("X-Stt-Lang", "") or request.args.get("lang", "")
    prompt = request.headers.get("X-Stt-Prompt", "") or request.args.get("prompt", "")

    try:
        result = transcribe_blob(
            request.data,
            mime_type=mime_type,
            language=language,
            prompt=prompt,
        )
        if result.get("error") == "no-speech":
            return jsonify(result), 200
        return jsonify(result)
    except FileNotFoundError as err:
        if "ffmpeg" in str(err).lower():
            return jsonify({"error": "ffmpeg not found on PATH", "text": ""}), 503
        raise
    except Exception as err:
        logger.exception("transcribe failed")
        return jsonify({"error": str(err), "text": ""}), 500


if __name__ == "__main__":
    if WARMUP_ON_START:
        logger.info("Warming up models (set AUDIO_WARMUP=0 to skip)...")
        warmup()
    app.extensions["live_speech_persistence"].log_startup(logger)
    logger.info("Audio service listening on http://%s:%s", HOST, PORT)
    app.run(host=HOST, port=PORT, threaded=True)
