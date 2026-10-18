"""
A stall in start-up work ends the sidecar loudly with a non-zero status instead of leaving it running without
ever listening (the sidecar that did not start after the 2026-10-15 reboot). See startup_guard.py.
"""

import os
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from startup_guard import EXIT_CODE, StartupDeadline, seconds_from_env

AUDIO_DIR = Path(__file__).resolve().parent.parent


class FakeTimer:
    """threading.Timer that never runs by itself: the test fires it."""

    def __init__(self, interval, function, args=()):
        self.interval = interval
        self.function = function
        self.args = args
        self.daemon = False
        self.started = False
        self.cancelled = False

    def start(self):
        self.started = True

    def cancel(self):
        self.cancelled = True

    def fire(self):
        self.function(*self.args)


class Harness:
    def __init__(self, seconds, what="loading the speech model"):
        self.timers = []
        self.exits = []
        self.dumps = []
        self.now = 1000.0

        def factory(interval, function, args=()):
            timer = FakeTimer(interval, function, args)
            self.timers.append(timer)
            return timer

        self.deadline = StartupDeadline(
            seconds,
            what,
            exit_fn=self.exits.append,
            dump_stacks=lambda: self.dumps.append(True),
            timer_factory=factory,
            clock=lambda: self.now,
        )


class StartupDeadlineTests(unittest.TestCase):
    def test_a_stalled_block_is_logged_dumped_and_ends_the_process(self):
        h = Harness(180)
        with self.assertLogs("startup_guard", level="CRITICAL") as logs:
            with h.deadline:
                self.assertEqual([t.interval for t in h.timers], [180])
                self.assertTrue(h.timers[0].started)
                self.assertTrue(h.timers[0].daemon, "a daemon timer cannot keep a finished process alive")
                h.now += 181
                h.timers[0].fire()
        self.assertEqual(h.exits, [EXIT_CODE])
        self.assertEqual(h.dumps, [True], "every thread's stack is written out before exiting")
        message = " ".join(logs.output)
        for needle in ("STARTUP FAILED", "loading the speech model", "180 s", "181 s since", "AUDIO_WARMUP_TIMEOUT_S"):
            self.assertIn(needle, message)
        self.assertNotEqual(EXIT_CODE, 0)
        self.assertNotEqual(EXIT_CODE, 1, "distinct from a plain crash")

    def test_finishing_in_time_cancels_the_timer_and_a_late_fire_does_nothing(self):
        h = Harness(180)
        with h.deadline:
            pass
        self.assertTrue(h.timers[0].cancelled)
        h.timers[0].fire()  # the timer had already been released when it was cancelled
        self.assertEqual(h.exits, [])
        self.assertEqual(h.dumps, [])

    def test_an_error_in_the_block_still_cancels_the_timer_and_is_not_swallowed(self):
        h = Harness(180)
        with self.assertRaises(RuntimeError):
            with h.deadline:
                raise RuntimeError("model files are corrupt")
        self.assertTrue(h.timers[0].cancelled)
        self.assertEqual(h.exits, [])

    def test_extend_replaces_the_deadline_and_the_old_timer_is_ignored(self):
        h = Harness(180)
        with self.assertLogs("startup_guard", level="CRITICAL") as logs:
            with h.deadline:
                h.deadline.extend(900, setting="AUDIO_DOWNLOAD_TIMEOUT_S")
                self.assertEqual([t.interval for t in h.timers], [180, 900])
                self.assertTrue(h.timers[0].cancelled)
                h.timers[0].fire()  # the first timer was already running when it was replaced
                self.assertEqual(h.exits, [], "a replaced deadline must not end the process")
                h.timers[1].fire()
        self.assertEqual(h.exits, [EXIT_CODE])
        message = " ".join(logs.output)
        self.assertIn("900 s", message)
        self.assertIn("AUDIO_DOWNLOAD_TIMEOUT_S", message)
        self.assertNotIn("AUDIO_WARMUP_TIMEOUT_S", message)

    def test_it_ends_the_process_only_once(self):
        h = Harness(10)
        with self.assertLogs("startup_guard", level="CRITICAL"):
            with h.deadline:
                h.timers[0].fire()
                h.timers[0].fire()
        self.assertEqual(h.exits, [EXIT_CODE])

    def test_zero_or_no_seconds_means_no_deadline(self):
        for seconds in (0, 0.0, None, -5):
            with self.subTest(seconds=seconds):
                h = Harness(seconds)
                with h.deadline:
                    h.deadline.extend(0)
                self.assertEqual(h.timers, [])
                self.assertEqual(h.exits, [])

    def test_a_real_timer_fires_while_the_block_is_stuck(self):
        fired = threading.Event()
        deadline = StartupDeadline(0.05, "a stuck call", exit_fn=lambda code: fired.set(), dump_stacks=lambda: None)
        with self.assertLogs("startup_guard", level="CRITICAL"):
            with deadline:
                self.assertTrue(fired.wait(5), "the watchdog thread acts although the block never returns")

    def test_a_real_timer_stays_quiet_when_the_block_finishes(self):
        fired = threading.Event()
        deadline = StartupDeadline(0.2, "a quick call", exit_fn=lambda code: fired.set(), dump_stacks=lambda: None)
        with deadline:
            pass
        self.assertFalse(fired.wait(0.5))


class SecondsFromEnvTests(unittest.TestCase):
    def test_values(self):
        cases = [
            ({}, 180),
            ({"X": ""}, 180),
            ({"X": "   "}, 180),
            ({"X": "60"}, 60.0),
            ({"X": "2.5"}, 2.5),
            ({"X": "0"}, 0.0),
        ]
        for env, expected in cases:
            with self.subTest(env=env):
                self.assertEqual(seconds_from_env("X", 180, environ=env), expected)

    def test_bad_values_fall_back_to_the_default_and_say_so(self):
        for raw in ("soon", "-5", "nan", "1e999x"):
            with self.subTest(raw=raw):
                with self.assertLogs("startup_guard", level="WARNING") as logs:
                    self.assertEqual(seconds_from_env("X", 180, environ={"X": raw}), 180)
                self.assertIn("X", " ".join(logs.output))


# A stand-in for faster-whisper that the real server.py imports instead of the real one, so the whole start-up
# (server.py -> transcribe.py -> startup_guard.py) runs for real while the model "load" is scripted.
STUB_FASTER_WHISPER = {
    "faster_whisper/__init__.py": """
        import os, threading, time

        class WhisperModel:
            def __init__(self, path, **kwargs):
                if os.environ.get("STUB_LOAD") == "hang":
                    threading.Event().wait()  # a call that never returns, like the stalled hub request
        """,
    "faster_whisper/utils.py": """
        import os, threading, time

        def download_model(name, local_files_only=False, **kwargs):
            mode = os.environ.get("STUB_CACHE", "cached")
            if local_files_only:
                if mode == "cached":
                    return "/stub/cache/" + name
                raise FileNotFoundError("nothing cached")
            time.sleep(float(os.environ.get("STUB_DOWNLOAD_S", "0")))
            return "/stub/downloaded/" + name
        """,
    "faster_whisper/vad.py": """
        class VadOptions: ...
        def get_speech_timestamps(*args, **kwargs): return []
        """,
}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ServerStartupTests(unittest.TestCase):
    """server.py run as the service runs it, against the stand-in model."""

    def setUp(self):
        self.stub = tempfile.TemporaryDirectory()
        self.addCleanup(self.stub.cleanup)
        for relative, source in STUB_FASTER_WHISPER.items():
            target = Path(self.stub.name) / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(textwrap.dedent(source))
        self.port = free_port()
        self.procs = []
        self.addCleanup(self.stop_all)

    def stop_all(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=10)
            proc.stdout.close()

    def start(self, **env_overrides):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("AUDIO_", "STUB_", "MEETING_"))}
        env.update(
            PYTHONPATH=os.pathsep.join([self.stub.name, str(AUDIO_DIR)]),
            AUDIO_HOST="127.0.0.1",
            AUDIO_PORT=str(self.port),
            PYTHONUNBUFFERED="1",
        )
        env.update(env_overrides)
        proc = subprocess.Popen(
            [sys.executable, str(AUDIO_DIR / "server.py")],
            cwd=AUDIO_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.procs.append(proc)
        return proc

    def health(self):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=2) as response:
                return response.status
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            return None

    def wait_for_health(self, proc, seconds=30):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if proc.poll() is not None:
                return None
            status = self.health()
            if status is not None:
                return status
            time.sleep(0.2)
        return None

    def test_a_load_that_never_returns_ends_the_process_non_zero_with_a_reason(self):
        proc = self.start(STUB_LOAD="hang", AUDIO_WARMUP_TIMEOUT_S="1")
        try:
            output, _ = proc.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            self.fail("the sidecar is still hung: the deadline did not end it")
        self.assertEqual(proc.returncode, EXIT_CODE, output[-2000:])
        self.assertIn("STARTUP FAILED", output)
        self.assertIn("loading the speech model", output)
        self.assertIn("AUDIO_WARMUP_TIMEOUT_S", output)
        self.assertIn("server.py", output, "the stack dump shows where it was stuck")
        self.assertIsNone(self.health(), "and nothing is listening")

    def test_a_cached_model_starts_listening_and_the_deadline_does_not_fire_afterwards(self):
        proc = self.start(AUDIO_WARMUP_TIMEOUT_S="1")
        self.assertEqual(self.wait_for_health(proc), 200)
        time.sleep(1.8)  # well past the 1 s deadline: it must have been cancelled when the load finished
        self.assertIsNone(proc.poll(), "the sidecar was ended after it had started")
        self.assertEqual(self.health(), 200)

    def test_an_uncached_model_gets_the_download_allowance_not_the_load_deadline(self):
        proc = self.start(
            STUB_CACHE="empty", STUB_DOWNLOAD_S="2", AUDIO_WARMUP_TIMEOUT_S="1", AUDIO_DOWNLOAD_TIMEOUT_S="20"
        )
        self.assertEqual(self.wait_for_health(proc), 200, "a 2 s download inside a 1 s load deadline must be allowed")

    def test_a_download_that_outlasts_its_own_allowance_ends_the_process(self):
        proc = self.start(
            STUB_CACHE="empty", STUB_DOWNLOAD_S="60", AUDIO_WARMUP_TIMEOUT_S="30", AUDIO_DOWNLOAD_TIMEOUT_S="1"
        )
        try:
            output, _ = proc.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            self.fail("the download hung the sidecar past AUDIO_DOWNLOAD_TIMEOUT_S")
        self.assertEqual(proc.returncode, EXIT_CODE, output[-2000:])
        self.assertIn("AUDIO_DOWNLOAD_TIMEOUT_S", output)


if __name__ == "__main__":
    unittest.main()
