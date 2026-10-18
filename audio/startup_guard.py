"""
A deadline for the sidecar's start-up work.

The sidecar only listens once the speech model is loaded. On 2026-10-15 that load stalled on one network
request at boot and never finished: the process sat idle for three days, nothing listened on the port, and
the service manager still called it "running". A stalled call cannot be interrupted from inside the thread
that is stuck in it, so a watchdog thread ends the process instead: it logs why, dumps every thread's stack
and exits with a non-zero status, which the service manager (`Restart=on-failure`) answers with a restart.
"""

import faulthandler
import logging
import os
import sys
import threading
import time

logger = logging.getLogger(__name__)

# EX_TEMPFAIL: "try again later". Distinct from 1 so a log or `systemctl status` shows this was the deadline.
EXIT_CODE = 75


def seconds_from_env(name, default, environ=None):
    """A non-negative number of seconds from the environment. Unset, empty, negative or not a number: the
    default (with a warning for the last two). 0 is allowed and means "no deadline"."""
    raw = (environ if environ is not None else os.environ).get(name, "")
    if raw is None or not str(raw).strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        value = -1.0
    if value != value or value < 0:  # NaN or negative
        logger.warning("%s=%r is not a number of seconds (0 or more); using %s", name, raw, default)
        return default
    return value


def _dump_all_stacks():
    try:
        faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
    except Exception:  # stderr without a file descriptor (a test runner): the log line above still says it
        logger.exception("could not dump the thread stacks")


class StartupDeadline:
    """`with StartupDeadline(180, "loading the speech model"): ...`

    If the block has not finished after `seconds`, the process is ended (see the module doc). `extend()`
    re-arms the deadline from now, for work known to take longer (a first download). `seconds` of 0 or
    less turns the deadline off. `exit_fn`, `dump_stacks` and `timer_factory` exist for tests.
    """

    def __init__(
        self,
        seconds,
        what,
        *,
        setting="AUDIO_WARMUP_TIMEOUT_S",
        exit_fn=os._exit,
        dump_stacks=_dump_all_stacks,
        timer_factory=threading.Timer,
        clock=time.monotonic,
    ):
        self.seconds = seconds
        self.what = what
        self.setting = setting
        self._exit_fn = exit_fn
        self._dump_stacks = dump_stacks
        self._timer_factory = timer_factory
        self._clock = clock
        self._lock = threading.Lock()
        self._timer = None
        self._generation = 0
        self._finished = False
        self._started_at = None

    def __enter__(self):
        self._started_at = self._clock()
        self._arm(self.seconds)
        return self

    def __exit__(self, *exc):
        with self._lock:
            self._finished = True
            self._cancel_locked()
        return False

    def extend(self, seconds, setting=None):
        """Allow `seconds` more from now (replacing the time that was left)."""
        if setting is not None:
            self.setting = setting
        logger.info("%s: allowing %s s from now", self.what, _plain(seconds))
        self._arm(seconds)

    def _cancel_locked(self):
        self._generation += 1
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _arm(self, seconds):
        with self._lock:
            self._cancel_locked()
            if self._finished or not seconds or seconds <= 0:
                return
            generation = self._generation
            timer = self._timer_factory(seconds, self._expire, args=(generation, seconds))
            timer.daemon = True
            self._timer = timer
            timer.start()

    def _expire(self, generation, seconds):
        with self._lock:
            # Finished, or re-armed, between the timer firing and getting here: nothing to do.
            if self._finished or generation != self._generation:
                return
            self._finished = True
        elapsed = self._clock() - self._started_at
        logger.critical(
            "STARTUP FAILED: %s did not finish within %s s (%.0f s since start-up began). Exiting with status "
            "%d so the service manager restarts the sidecar instead of leaving it up but never listening. "
            "A stalled network call is the usual cause. Every thread's stack follows on stderr. "
            "Set %s to change the limit (0 turns it off).",
            self.what,
            _plain(seconds),
            elapsed,
            EXIT_CODE,
            self.setting,
        )
        self._dump_stacks()
        for handler in logging.getLogger().handlers:
            try:
                handler.flush()
            except Exception:
                pass
        try:
            sys.stderr.flush()
        except Exception:
            pass
        self._exit_fn(EXIT_CODE)


def _plain(seconds):
    return int(seconds) if float(seconds).is_integer() else seconds
