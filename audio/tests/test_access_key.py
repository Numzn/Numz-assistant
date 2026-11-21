"""The speech service's shared key: every route refuses a caller without it, nothing reveals whether a key exists, and a bad
configuration stops the start instead of opening the door."""
import os
import re
import unittest

from flask import Flask, jsonify

import access_key

KEY = "k" * 32


def app_with(key):
    app = Flask(__name__)
    access_key.install(app, key)

    @app.route("/health")
    def health():
        return jsonify({"ok": True})

    @app.route("/transcribe", methods=["POST"])
    def transcribe():
        return jsonify({"text": "heard"})

    return app


class SharedKey(unittest.TestCase):
    def test_every_route_refuses_a_caller_without_the_key(self):
        client = app_with(KEY).test_client()
        for method, path in (("GET", "/health"), ("POST", "/transcribe"), ("GET", "/live-speech"), ("GET", "/nothing")):
            for headers in ({}, {"X-Audio-Key": ""}, {"X-Audio-Key": "wrong"}, {"X-Audio-Key": KEY + "x"}, {"X-Audio-Key": KEY[:-1]}, {"x-audio-key": KEY.upper()}):
                res = client.open(path, method=method, headers=headers)
                self.assertEqual(res.status_code, 401, (method, path, headers))
                self.assertEqual(res.get_json(), {"error": "audio key required", "text": ""}, "one answer, whatever was wrong")

    def test_with_the_key_the_service_answers(self):
        client = app_with(KEY).test_client()
        self.assertEqual(client.get("/health", headers={"X-Audio-Key": KEY}).get_json(), {"ok": True})
        self.assertEqual(client.post("/transcribe", headers={"X-Audio-Key": KEY}, data=b"audio").get_json(), {"text": "heard"})
        self.assertEqual(client.get("/nothing", headers={"X-Audio-Key": KEY}).status_code, 404, "past the key, ordinary behaviour")

    def test_the_key_is_not_accepted_in_a_query_string_or_a_cookie(self):
        client = app_with(KEY).test_client()
        self.assertEqual(client.get(f"/health?key={KEY}").status_code, 401)
        client.set_cookie("X-Audio-Key", KEY)
        self.assertEqual(client.get("/health").status_code, 401)

    def test_with_no_key_configured_it_is_open_and_says_so(self):
        app = Flask(__name__)
        with self.assertLogs(level="WARNING") as logs:
            self.assertFalse(access_key.install(app, ""))
        self.assertTrue(any("answers anyone" in line for line in logs.output))

    def test_a_bad_configuration_stops_the_start(self):
        with self.assertRaises(access_key.KeyConfigError):
            access_key.check_configuration("", required=True)
        with self.assertRaises(access_key.KeyConfigError):
            access_key.check_configuration("short", required=False)
        access_key.check_configuration("", required=False)
        access_key.check_configuration(KEY, required=True)

    def test_the_real_server_installs_it_first_and_the_websocket_goes_through_the_same_door(self):
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(here, "server.py")) as f:
            source = f.read()
        self.assertLess(source.index("access_key.install(app"), source.index("register_live_speech_route(app)"), "before any route exists")
        self.assertLess(source.index("access_key.install(app"), source.index('@app.route("/health"'))
        self.assertTrue(re.search(r"check_configuration\(AUDIO_SERVICE_KEY", source))
        # a WebSocket handshake is an ordinary GET first, so before_request covers it; prove it with a real upgrade-shaped request
        client = app_with(KEY).test_client()
        handshake = {"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="}
        self.assertEqual(client.get("/live-speech", headers=handshake).status_code, 401)


if __name__ == "__main__":
    unittest.main()
