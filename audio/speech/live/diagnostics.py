"""
Per-session numbers about what the live path heard and how it coped, written to the log.

Until 2026-10-09 a meeting that lost words could not be explained afterwards: nothing recorded how loud the
microphone was, how much audio the gate kept from the recognizer, how long decoding took or how far behind
real time the service fell. This records exactly that, as one log line per minute of stream and one at the
end of the session.

Deliberately small and safe for a memory-constrained host:
  - fixed memory: counters and a 50-bin histogram (2 dB per bin) instead of stored levels;
  - numbers only: no audio and no transcript text ever reach the log (segment CONFIDENCE is recorded, not
    segment text);
  - it can never break the audio path: every public method swallows its own errors (logging the first one).
"""

import functools
import json
import logging
import time
from typing import Callable, Optional

import numpy as np

logger = logging.getLogger(__name__)

LEVEL_FLOOR_DBFS = -100.0
LEVEL_STEP_DB = 2.0
LEVEL_BINS = 50  # -100 .. 0 dBFS

# Whisper's own cut-offs: a segment below the first is a poor decode, above the second probably not speech.
LOW_LOGPROB = -1.0
LIKELY_NON_SPEECH = 0.6
# A decode this slow (a normal final takes 2-5 s) is logged on its own, so a long lag can be explained.
SLOW_DECODE_S = 10.0
MAX_SLOW_LOGS = 20  # per session


def _never_raises(method):
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        try:
            return method(self, *args, **kwargs)
        except Exception:
            if not self._reported_failure:
                self._reported_failure = True
                logger.exception("live-speech-diag: diagnostics failed; the audio path is unaffected")
            return None

    return wrapper


class _Decodes:
    def __init__(self):
        self.count = 0
        self.seconds = 0.0
        self.longest_s = 0.0
        self.audio_s = 0.0

    def add(self, seconds: float, audio_s: float):
        self.count += 1
        self.seconds += seconds
        self.longest_s = max(self.longest_s, seconds)
        self.audio_s += audio_s

    def as_dict(self) -> dict:
        return {
            "count": self.count,
            "seconds": round(self.seconds, 2),
            "longestS": round(self.longest_s, 2),
            "audioS": round(self.audio_s, 2),
            # How many seconds of decoding each second of audio decoded cost; above 1 the recognizer cannot keep up.
            "secondsPerAudioSecond": round(self.seconds / self.audio_s, 2) if self.audio_s else None,
        }


class SessionDiagnostics:
    def __init__(
        self,
        session_id: str,
        sample_rate: int = 16000,
        clock: Callable[[], float] = time.monotonic,
        log_every_s: float = 60.0,
        log: Optional[logging.Logger] = None,
        meeting_id: Optional[str] = None,
    ):
        self.session_id = session_id
        # Only so a log line or a stopped frame can be matched to its meeting; nothing here reads or sends it.
        self.meeting_id = meeting_id
        self.sample_rate = sample_rate
        self._clock = clock
        self._log_every_s = log_every_s
        self._log = log or logger
        self._reported_failure = False

        self.frames_received = 0
        self.frames_gate_open = 0
        self.frames_forwarded = 0
        self.stream_s = 0.0
        self._levels = np.zeros(LEVEL_BINS, dtype=np.int64)
        self._quiet_run_s = 0.0
        self._quiet_run_in_utterance_s = 0.0
        self.longest_quiet_s = 0.0
        self.longest_quiet_in_utterance_s = 0.0
        self.noise_floor_dbfs: Optional[float] = None

        self.previews = _Decodes()
        self.finals = _Decodes()
        self.final_segments = 0
        self._logprob_sum = 0.0
        self._logprob_count = 0
        self.min_logprob: Optional[float] = None
        self.max_no_speech_prob: Optional[float] = None
        self.low_logprob_segments = 0
        self.likely_non_speech_segments = 0
        self.max_temperature: Optional[float] = None
        self.max_compression_ratio: Optional[float] = None
        self.slow_decodes = 0
        self.forced_cuts = 0

        self._wall_at_first_frame: Optional[float] = None
        self._stream_at_first_frame = 0.0
        self.lag_max_s = 0.0
        self.lag_last_s = 0.0
        self._last_logged_stream_s = 0.0

    # ---- inputs -------------------------------------------------------------------

    @_never_raises
    def on_frame(self, frame, stream_s: float, gate_open: bool, in_utterance: bool, vad=None):
        """Call once per received frame, BEFORE it is routed. stream_s is the stream position at its end;
        in_utterance is whether an utterance was already in progress; vad, if given, is asked for the
        noise floor it has learned (read here so that a failure cannot escape into the audio path)."""
        rms = float(np.sqrt(np.mean(np.square(frame))))
        dbfs = 20.0 * float(np.log10(max(rms, 1e-9)))
        index = int((dbfs - LEVEL_FLOOR_DBFS) // LEVEL_STEP_DB)
        self._levels[min(max(index, 0), LEVEL_BINS - 1)] += 1

        if self._wall_at_first_frame is None:
            self._wall_at_first_frame = self._clock()
            self._stream_at_first_frame = stream_s
        frame_duration_s = frame.size / self.sample_rate
        self.stream_s = stream_s
        self.frames_received += 1
        floor = getattr(vad, "noise_floor_dbfs", None)
        if floor is not None:
            self.noise_floor_dbfs = floor

        if gate_open:
            self.frames_gate_open += 1
            self._quiet_run_s = 0.0
            self._quiet_run_in_utterance_s = 0.0
        else:
            self._quiet_run_s += frame_duration_s
            self.longest_quiet_s = max(self.longest_quiet_s, self._quiet_run_s)
            if in_utterance:
                self._quiet_run_in_utterance_s += frame_duration_s
                self.longest_quiet_in_utterance_s = max(self.longest_quiet_in_utterance_s, self._quiet_run_in_utterance_s)
            else:
                self._quiet_run_in_utterance_s = 0.0

    @_never_raises
    def on_forced_cut(self):
        """An utterance reached the length limit and was cut (in a gap between words if there was one)."""
        self.forced_cuts += 1

    @_never_raises
    def on_forwarded(self):
        """A frame was handed to the recognizer."""
        self.frames_forwarded += 1

    @_never_raises
    def on_decode(self, kind: str, seconds: float, audio_s: float, segments=()):
        """One Whisper decode: kind 'preview' or 'final', its wall time, the audio it covered, its raw segments."""
        decode_max_temperature = decode_max_compression = None
        for segment in segments or ():
            temperature = getattr(segment, "temperature", None)
            compression = getattr(segment, "compression_ratio", None)
            if isinstance(temperature, (int, float)):
                decode_max_temperature = temperature if decode_max_temperature is None else max(decode_max_temperature, temperature)
            if isinstance(compression, (int, float)):
                decode_max_compression = compression if decode_max_compression is None else max(decode_max_compression, compression)
        if decode_max_temperature is not None:
            self.max_temperature = decode_max_temperature if self.max_temperature is None else max(self.max_temperature, decode_max_temperature)
        if decode_max_compression is not None:
            self.max_compression_ratio = decode_max_compression if self.max_compression_ratio is None else max(self.max_compression_ratio, decode_max_compression)
        if seconds >= SLOW_DECODE_S:
            self.slow_decodes += 1
            if self.slow_decodes <= MAX_SLOW_LOGS:
                # Numbers only. maxTemperature above 0 means Whisper retried the decode; a high compression
                # ratio (above 2.4) means the text was repetitive: the usual reasons a decode takes 30 s.
                self._log.warning(
                    "live-speech-diag slow-decode %s",
                    json.dumps(
                        {
                            "session": self.session_id,
                            "kind": kind,
                            "seconds": round(seconds, 1),
                            "audioS": round(audio_s, 1),
                            "segments": len(segments or ()),
                            "maxTemperature": decode_max_temperature,
                            "maxCompressionRatio": None if decode_max_compression is None else round(decode_max_compression, 2),
                            "streamS": round(self.stream_s, 1),
                        },
                        separators=(",", ":"),
                        sort_keys=True,
                    ),
                )
        if kind == "final":
            self.finals.add(seconds, audio_s)
            for segment in segments or ():
                self.final_segments += 1
                logprob = getattr(segment, "avg_logprob", None)
                no_speech = getattr(segment, "no_speech_prob", None)
                if isinstance(logprob, (int, float)):
                    self._logprob_sum += logprob
                    self._logprob_count += 1
                    self.min_logprob = logprob if self.min_logprob is None else min(self.min_logprob, logprob)
                    if logprob < LOW_LOGPROB:
                        self.low_logprob_segments += 1
                if isinstance(no_speech, (int, float)):
                    self.max_no_speech_prob = no_speech if self.max_no_speech_prob is None else max(self.max_no_speech_prob, no_speech)
                    if no_speech > LIKELY_NON_SPEECH:
                        self.likely_non_speech_segments += 1
        else:
            self.previews.add(seconds, audio_s)

    @_never_raises
    def on_ingest_done(self, stream_s: float):
        """Call after a frame was fully processed (decoding included). Measures how far behind real time
        the service is, assuming the sender paces audio at real time, as the browser does."""
        if self._wall_at_first_frame is None:
            return
        elapsed = self._clock() - self._wall_at_first_frame
        lag = max(0.0, elapsed - (stream_s - self._stream_at_first_frame))
        self.lag_last_s = lag
        self.lag_max_s = max(self.lag_max_s, lag)
        if stream_s - self._last_logged_stream_s >= self._log_every_s:
            self._last_logged_stream_s = stream_s
            self.log_summary(final=False)

    # ---- output -------------------------------------------------------------------

    def _level_percentile(self, q: float) -> Optional[float]:
        total = int(self._levels.sum())
        if total == 0:
            return None
        cumulative = np.cumsum(self._levels)
        index = int(np.searchsorted(cumulative, q * total))
        return LEVEL_FLOOR_DBFS + (min(index, LEVEL_BINS - 1) + 1) * LEVEL_STEP_DB  # upper edge of the bin

    def summary(self, final: bool = False) -> dict:
        def r(value, digits=2):
            return None if value is None else round(float(value), digits)

        received = self.frames_received
        return {
            "session": self.session_id,
            **({"meeting": self.meeting_id} if self.meeting_id else {}),
            "final": final,
            "streamS": r(self.stream_s),
            "frames": {
                "received": received,
                "gateOpen": self.frames_gate_open,
                "forwarded": self.frames_forwarded,
                "forwardedShare": r(self.frames_forwarded / received, 3) if received else None,
            },
            # Frame levels in dBFS over everything received (upper edge of 2 dB bins).
            "levelDbfs": {
                "p10": self._level_percentile(0.10),
                "p50": self._level_percentile(0.50),
                "p90": self._level_percentile(0.90),
                "p99": self._level_percentile(0.99),
            },
            "noiseFloorDbfs": r(self.noise_floor_dbfs, 1),
            "forcedCuts": self.forced_cuts,
            "longestQuietS": r(self.longest_quiet_s, 1),
            "longestQuietInUtteranceS": r(self.longest_quiet_in_utterance_s, 1),
            "decodes": {
                "preview": self.previews.as_dict(),
                "final": self.finals.as_dict(),
                "slow": self.slow_decodes,
                "maxTemperature": r(self.max_temperature, 2),
                "maxCompressionRatio": r(self.max_compression_ratio, 2),
            },
            "lagS": {"last": r(self.lag_last_s), "max": r(self.lag_max_s)},
            "confidence": {
                "finalSegments": self.final_segments,
                "avgLogprobMean": r(self._logprob_sum / self._logprob_count, 3) if self._logprob_count else None,
                "avgLogprobMin": r(self.min_logprob, 3),
                "lowLogprobSegments": self.low_logprob_segments,
                "noSpeechProbMax": r(self.max_no_speech_prob, 3),
                "likelyNonSpeechSegments": self.likely_non_speech_segments,
            },
        }

    @_never_raises
    def log_summary(self, final: bool = False):
        self._log.info("live-speech-diag %s", json.dumps(self.summary(final), separators=(",", ":"), sort_keys=True))
