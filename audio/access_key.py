"""Who may use the speech service: only callers that know its shared key.

The speech service listens on a port the NUMZ AI server reaches over the Docker network, but that port is also reachable from anything else on
this machine's networks. Firewalls narrow that; they are not the control. With AUDIO_SERVICE_KEY set (in .env.secrets, which the NUMZ AI
server also reads), every route, including the WebSocket handshake, answers 401 to a request without it in `X-Audio-Key`. The comparison is
constant-time and no answer says whether a key is configured or how long it is.

    AUDIO_SERVICE_KEY=<24+ random characters>   the shared key (not set: open, with a loud warning at start-up)
    AUDIO_REQUIRE_KEY=1                          refuse to start without a key (use this once the key is deployed)
"""
import hmac
import logging

from flask import jsonify, request

MIN_KEY_LENGTH = 24


class KeyConfigError(RuntimeError):
    """The key is missing where it is required, or too short to mean anything."""


def check_configuration(key: str, required: bool) -> None:
    key = (key or "").strip()
    if required and not key:
        raise KeyConfigError("AUDIO_REQUIRE_KEY is on but AUDIO_SERVICE_KEY is not set")
    if key and len(key) < MIN_KEY_LENGTH:
        raise KeyConfigError(f"AUDIO_SERVICE_KEY must be at least {MIN_KEY_LENGTH} characters")


def install(app, key: str, logger: logging.Logger = None) -> bool:
    """Require the key on every route. Returns True when the key is enforced, False when none is configured (open)."""
    key = (key or "").strip()
    log = logger or logging.getLogger(__name__)
    if not key:
        log.warning("AUDIO_SERVICE_KEY is not set: the speech service answers anyone who can reach this port")
        return False
    expected = key.encode()

    @app.before_request
    def require_key():
        supplied = request.headers.get("X-Audio-Key", "").encode()
        if not hmac.compare_digest(supplied, expected):
            return jsonify({"error": "audio key required", "text": ""}), 401
        return None

    log.info("the speech service requires its key (X-Audio-Key) on every request")
    return True
