"""
Critical-path tests: the real WebSocket handler (audio/live_speech_ws.py) persisting through
the real Node meeting API (server/server.js, real SQLite file). Only the speech model is
replaced (deterministic ASR and VAD) - everything between the socket and the database is real.
"""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from flask import Flask
from simple_websocket import Client as WsClient
from werkzeug.serving import make_server

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.abspath(os.path.join(HERE, ".."))
REPO_DIR = os.path.abspath(os.path.join(AUDIO_DIR, ".."))

import sys  # noqa: E402

sys.path.insert(0, AUDIO_DIR)

import live_speech_ws  # noqa: E402
from speech.live.outbox import Outbox  # noqa: E402
from tests.fakes_live import fake_session_factory, silence_frames, speech_frames  # noqa: E402

ADMIN = "integration-admin-token-".ljust(40, "k")
TICKET_SECRET = "integration-ticket-secret-".ljust(40, "m")
NODE = shutil.which("node") or "node"


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class NodeApi:
    """The real server/server.js in a child process, with its database in a file that survives restarts."""

    def __init__(self, db_file):
        self.db_file = db_file
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}/api/v1"
        self.process = None
        self.log = tempfile.TemporaryFile(mode="w+")

    def start(self):
        env = {
            **os.environ,
            "PORT": str(self.port),
            "NODE_ENV": "development",
            "AI_PROVIDER": "placeholder",
            "SPEECH_DATABASE_PATH": self.db_file,
            "MEETING_API_TOKEN": ADMIN,
            "MEETING_TICKET_SECRET": TICKET_SECRET,
            "CORS_ORIGIN": "http://localhost:5173",
        }
        self.process = subprocess.Popen(
            [NODE, "server/server.js"], cwd=REPO_DIR, env=env, stdout=self.log, stderr=subprocess.STDOUT
        )
        # Startup takes ~4 s on an idle machine and up to ~40 s on the swap-saturated host this suite
        # runs on. The deadline is generous on purpose; a failed startup never leaves the child running.
        deadline = time.time() + 180
        try:
            while time.time() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError(f"meeting API exited during startup:\n{self.output()}")
                try:
                    with urllib.request.urlopen(self.base + "/health", timeout=2):
                        return self
                except OSError:
                    time.sleep(0.2)
            raise RuntimeError(f"meeting API did not start within 180 s:\n{self.output()}")
        except BaseException:
            self.stop()
            raise

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process = None

    def output(self):
        self.log.seek(0)
        return self.log.read()[-3000:]

    def call(self, method, path, token=ADMIN, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")


class SidecarServer:
    """The real live transport (flask-sock route) on a real socket, with a deterministic session factory."""

    def __init__(self, outbox_dir, prefixes):
        app = Flask(__name__)
        live_speech_ws.SESSION_FACTORY = fake_session_factory(iter(prefixes))
        live_speech_ws.register_live_speech_route(app, outbox=Outbox(outbox_dir))
        self.port = free_port()
        self.httpd = make_server("127.0.0.1", self.port, app, threaded=True)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"ws://127.0.0.1:{self.port}/live-speech"

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        live_speech_ws.SESSION_FACTORY = None


class Stream:
    """A client speaking the real wire protocol."""

    def __init__(self, url):
        self.ws = WsClient.connect(url)
        self.seen = []

    def send_json(self, payload):
        self.ws.send(json.dumps(payload))

    def _pump(self, timeout):
        """Reads one frame (None on timeout) and records it."""
        raw = self.ws.receive(timeout=timeout)
        if raw is None:
            return None
        message = json.loads(raw) if isinstance(raw, str) else {"type": "binary"}
        self.seen.append(message)
        return message

    def read_until(self, predicate, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = self._pump(0.5)
            if message is not None and predicate(message):
                return message
        raise AssertionError(f"timed out; frames seen: {self.seen[-8:]}")

    def finals(self):
        return [m for m in self.seen if m.get("type") == "transcript" and m.get("state") == "FINAL"]

    def start(self, **control):
        self.send_json({"type": "start", "sampleRate": 16000, "channels": 1, "format": "f32le", "language": "en", **control})
        return self.read_until(lambda m: m.get("type") in ("ready", "error"))

    def utterance(self):
        for frame in speech_frames(10) + silence_frames(8):
            self.ws.send(frame.tobytes())

    def wait_finals(self, count, timeout=30):
        deadline = time.time() + timeout
        while len(self.finals()) < count:
            if time.time() > deadline:
                raise AssertionError(f"expected {count} FINAL frames; saw {len(self.finals())}: {self.seen[-8:]}")
            self._pump(0.5)
        return self.finals()

    def stop(self):
        self.send_json({"type": "stop"})
        return self.read_until(lambda m: m.get("type") == "stopped")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


class LiveMeetingPathTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.api = NodeApi(os.path.join(self._tmp.name, "speech.sqlite")).start()
        self.sidecar = SidecarServer(os.path.join(self._tmp.name, "outbox"), ["session A", "session B", "session C", "standalone"])
        self._saved_api_url = live_speech_ws.MEETING_API_URL
        live_speech_ws.MEETING_API_URL = f"http://127.0.0.1:{self.api.port}"  # the origin, not /api/v1
        self.streams = []

    def tearDown(self):
        for stream in self.streams:
            stream.close()
        live_speech_ws.MEETING_API_URL = self._saved_api_url
        self.sidecar.stop()
        self.api.stop()
        self.api.log.close()
        self._tmp.cleanup()

    def connect(self):
        stream = Stream(self.sidecar.url)
        self.streams.append(stream)
        return stream

    def new_meeting(self):
        status, meeting = self.api.call("POST", "/meetings", body={"metadata": {"title": "integration"}})
        self.assertEqual(status, 201)
        self.assertEqual(self.api.call("POST", f"/meetings/{meeting['meetingId']}/start")[0], 200)
        return meeting["meetingId"], meeting["ticket"]["token"]

    def test_two_sessions_of_one_meeting_persist_through_the_real_api(self):
        meeting_id, ticket = self.new_meeting()

        a = self.connect()
        ready = a.start(meetingId=meeting_id, meetingTicket=ticket)
        self.assertEqual(ready["persistence"], "meeting")
        a.utterance()
        a.utterance()
        finals = a.wait_finals(2)
        self.assertEqual([f["persisted"] for f in finals], ["INSERTED", "INSERTED"])
        stopped_a = a.stop()
        self.assertEqual(stopped_a["persistence"]["committed"], 2)
        self.assertEqual(stopped_a["persistence"]["inserted"], 2)
        self.assertEqual(stopped_a["persistence"]["failed"], 0)

        b = self.connect()
        self.assertEqual(b.start(meetingId=meeting_id, meetingTicket=ticket)["persistence"], "meeting")
        b.utterance()
        b.wait_finals(1)
        self.assertEqual(b.stop()["persistence"]["inserted"], 1)

        status, ended = self.api.call("POST", f"/meetings/{meeting_id}/end")
        self.assertEqual(status, 200)
        self.assertTrue(ended["integrity"]["verified"], "every session reported what it committed, and all of it is stored")
        _, transcript = self.api.call("GET", f"/meetings/{meeting_id}/transcript")
        segments = transcript["segments"]
        self.assertEqual([s["text"] for s in segments], ["session A 1", "session A 2", "session B 1"])
        self.assertEqual(len({s["id"] for s in segments}), 3, "no duplicate segment ids across sessions")
        for previous, current in zip(segments, segments[1:]):
            self.assertGreaterEqual(current["start"], previous["end"] - 1e-9, "meeting timeline never goes backwards")
        # This test feeds audio faster than real time, so the wall-clock term of the offset is smaller
        # than A's end and B starts exactly where A ended. Touching is correct: time never goes backwards.
        self.assertGreaterEqual(segments[2]["start"], segments[1]["end"], "session B sits after session A")

        _, sessions = self.api.call("GET", f"/meetings/{meeting_id}/sessions")
        # The session opened by /start is superseded by A; A and B each end when their stream stops.
        self.assertEqual(sorted(s["endReason"] for s in sessions["speechSessions"]), ["stopped", "stopped", "superseded"])
        reported = [(s["committedSegments"], s["storedSegments"]) for s in sessions["speechSessions"] if s["endReason"] == "stopped"]
        self.assertEqual(sorted(reported), [(1, 1), (2, 2)], "each transport reported its count and the API stored exactly that many")

    def test_an_api_outage_is_visible_and_the_segment_is_delivered_exactly_once_after_recovery(self):
        meeting_id, ticket = self.new_meeting()
        a = self.connect()
        a.start(meetingId=meeting_id, meetingTicket=ticket)
        a.utterance()
        self.assertEqual(a.wait_finals(1)[0]["persisted"], "INSERTED")

        self.api.stop()  # the meeting API goes away mid-session
        a.utterance()
        second = a.wait_finals(2)[1]
        self.assertEqual(second["persisted"], "FAILED", "an undelivered segment must never be reported as saved")
        # The FINAL frame goes out first; the explanation follows it. Wait for the explanation too.
        a.read_until(
            lambda m: m.get("type") == "error" and m.get("code") == "persistence-failure" and m.get("segmentId") == second["segment"]["id"]
        )
        stopped = a.stop()
        self.assertGreaterEqual(stopped["persistence"]["failed"], 1)
        self.assertTrue(stopped["persistence"]["durable"], "the outbox is on disk, so the pending segment survives")

        self.api.start()  # same database file; interrupted meeting is now RECOVERING
        _, meeting = self.api.call("GET", f"/meetings/{meeting_id}")
        self.assertEqual(meeting["status"], "RECOVERING")

        b = self.connect()
        ready = b.start(meetingId=meeting_id, meetingTicket=ticket)
        self.assertEqual(ready["persistence"], "meeting")
        _, after_start = self.api.call("GET", f"/meetings/{meeting_id}/transcript")
        self.assertEqual(
            [s["text"] for s in after_start["segments"]],
            ["session A 1", "session A 2"],
            "the pending segment from the outage is delivered on the next session start, in order",
        )

        b.utterance()
        b.wait_finals(1)
        b.stop()
        status, ended = self.api.call("POST", f"/meetings/{meeting_id}/end")
        self.assertEqual(status, 200)
        # Session A could not report its count (the API was down when it stopped), so it cannot be verified.
        # Nothing is known to be missing, but the meeting does not claim more than it knows.
        self.assertTrue(ended["integrity"]["complete"])
        self.assertFalse(ended["integrity"]["verified"])
        self.assertEqual(ended["integrity"]["unverifiedSessions"], 1)
        _, transcript = self.api.call("GET", f"/meetings/{meeting_id}/transcript")
        self.assertEqual([s["text"] for s in transcript["segments"]], ["session A 1", "session A 2", "session B 1"])

    def test_a_segment_the_api_rejects_stops_the_meeting_from_ending_as_if_nothing_was_lost(self):
        meeting_id, ticket = self.new_meeting()
        # Session A speaks normally. Session B produces text the API refuses (over the 8000 character limit).
        live_speech_ws.SESSION_FACTORY = fake_session_factory(iter(["good", "x" * 8100]))

        a = self.connect()
        a.start(meetingId=meeting_id, meetingTicket=ticket)
        a.utterance()
        self.assertEqual(a.wait_finals(1)[0]["persisted"], "INSERTED")
        a.stop()

        b = self.connect()
        b.start(meetingId=meeting_id, meetingTicket=ticket)
        b.utterance()
        rejected = b.wait_finals(1)[0]
        self.assertEqual(rejected["persisted"], "REJECTED", "a refused segment is never reported as saved")
        b.read_until(lambda m: m.get("type") == "error" and m.get("code") == "segment-rejected")
        summary = b.stop()["persistence"]
        self.assertEqual((summary["committed"], summary["inserted"], summary["rejected"]), (1, 0, 1))

        quarantined = Outbox(os.path.join(self._tmp.name, "outbox")).rejected(meeting_id)
        self.assertEqual(len(quarantined), 1, "the refused segment is kept for inspection, not dropped")
        self.assertEqual(quarantined[0]["reason"], "invalid-segment")

        # The API knows a segment is missing, so the meeting cannot be ended as if the transcript were whole.
        status, refused = self.api.call("POST", f"/meetings/{meeting_id}/end")
        self.assertEqual(status, 409)
        self.assertEqual(refused["code"], "transcript-incomplete")
        self.assertEqual(refused["details"]["missingSegments"], 1)
        self.assertEqual(self.api.call("GET", f"/meetings/{meeting_id}")[1]["status"], "LIVE")

        # The operator's honest options: mark it failed, with a reason. The stored transcript stays readable.
        status, failed = self.api.call("POST", f"/meetings/{meeting_id}/fail", body={"reason": "one segment was refused"})
        self.assertEqual((status, failed["status"]), (200, "FAILED"))
        _, transcript = self.api.call("GET", f"/meetings/{meeting_id}/transcript")
        self.assertEqual([s["text"] for s in transcript["segments"]], ["good 1"])
        self.assertFalse(transcript["integrity"]["complete"])

    def test_standalone_and_misconfigured_starts_are_explicit(self):
        standalone = self.connect()
        ready = standalone.start()
        self.assertEqual(ready["persistence"], "standalone")
        standalone.utterance()
        final = standalone.wait_finals(1)[0]
        self.assertEqual(final["persisted"], "NOT_PERSISTED", "standalone mode never claims a save")
        self.assertEqual(standalone.stop()["persistence"]["meetingBound"], False)

        meeting_id, ticket = self.new_meeting()
        saved = live_speech_ws.MEETING_API_URL
        try:
            live_speech_ws.MEETING_API_URL = ""
            unconfigured = self.connect()
            self.assertEqual(unconfigured.start(meetingId=meeting_id, meetingTicket=ticket)["code"], "persistence-unconfigured")

            live_speech_ws.MEETING_API_URL = saved
            no_ticket = self.connect()
            self.assertEqual(no_ticket.start(meetingId=meeting_id)["code"], "persistence-unauthorized")

            forged = self.connect()
            refused = forged.start(meetingId=meeting_id, meetingTicket=ticket[:-4] + "AAAA")
            self.assertEqual(refused["code"], "persistence-unavailable")
        finally:
            live_speech_ws.MEETING_API_URL = saved


if __name__ == "__main__":
    unittest.main()
