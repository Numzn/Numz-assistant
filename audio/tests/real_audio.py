"""
Helpers for the tests that run REAL audio through the REAL Whisper model (test_real_audio_gate.py).

The fixture, tests/fixtures/jfk.wav, is the standard 11-second Whisper test clip: an excerpt of President
Kennedy's 1961 inaugural address (US government work, public domain), 16 kHz mono 16-bit. It is the only
real speech recording in the repository, so results from it alone say little about other voices, rooms or
microphones; the tests vary its level, its alignment to the 100 ms frames and the noise around it.
"""

import os
import time
import wave

import numpy as np

from speech import scoring

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1600  # 100 ms, the browser worklet's frame size
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "jfk.wav")
JFK_REFERENCE = "and so my fellow americans ask not what your country can do for you ask what you can do for your country"


def load_clip(path=FIXTURE):
    with wave.open(path) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (SAMPLE_RATE, 1, 2)
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0


def rms(x):
    return float(np.sqrt(np.mean(np.square(x))))


def dbfs(x):
    return 20 * float(np.log10(max(rms(x), 1e-9)))


def scale_to_dbfs(pcm, target_dbfs):
    """Scale so the whole clip's RMS is target_dbfs."""
    return (pcm * (10 ** (target_dbfs / 20) / rms(pcm))).astype(np.float32)


def white_noise(samples, level_dbfs, seed=7):
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(samples) * 10 ** (level_dbfs / 20)).astype(np.float32)


def room_tone(samples, level_dbfs, seed=7):
    """Low-frequency-heavy noise (air conditioning, traffic rumble): white noise smoothed over ~1 ms."""
    kernel = np.ones(16) / 16
    smooth = np.convolve(white_noise(samples + 15, 0, seed), kernel, mode="valid")
    return (smooth * (10 ** (level_dbfs / 20) / rms(smooth))).astype(np.float32)


def mains_hum(samples, hum_dbfs, hiss_dbfs, hz=50, seed=7):
    t = np.arange(samples) / SAMPLE_RATE
    hum = np.sin(2 * np.pi * hz * t) * 10 ** (hum_dbfs / 20) * np.sqrt(2)
    return (hum + white_noise(samples, hiss_dbfs, seed)).astype(np.float32)


def words(text):
    return scoring.words(text)


def word_errors(hypothesis, reference=JFK_REFERENCE):
    """Word error rate with its parts (substitutions, deletions, insertions); see speech/scoring.py."""
    return scoring.word_errors(hypothesis, reference)


def excess_repeats(hypothesis, reference=JFK_REFERENCE, size=3):
    """Phrases the hypothesis says more often than the reference does: the symptom of a decoding loop."""
    return scoring.excess_repeats(hypothesis, reference, size)


def run_stream(stream, clip_start_s=None, clip_end_s=None, language="en", **session_args):
    """Feed a stream through the real LiveSpeechSession (real gate, endpointing, Whisper) in 100 ms frames.

    Returns what reached the recognizer and what came out. With clip_start_s/clip_end_s (where the speech
    sits in the stream) it also counts the clip's frames that were never forwarded to Whisper ("dropped").
    """
    from speech.live.frame_vad import FrameVad
    from speech.live.session import LiveSpeechSession
    from speech.live.streaming_asr import LocalAgreementStreamingAsr

    frames = [stream[i : i + FRAME_SAMPLES] for i in range(0, len(stream) - FRAME_SAMPLES + 1, FRAME_SAMPLES)]

    forwarded_at = []
    asr = LocalAgreementStreamingAsr(sample_rate=SAMPLE_RATE, language=language)
    push = asr.push_audio

    def counting_push(frame, timestamp_s):
        forwarded_at.append(round(timestamp_s, 3))
        return push(frame, timestamp_s)

    asr.push_audio = counting_push
    session = LiveSpeechSession(language=language, streaming_asr=asr, **session_args)

    started = time.perf_counter()
    for i, frame in enumerate(frames, start=1):
        session.ingest_audio_frame(frame, timestamp_s=i * FRAME_SAMPLES / SAMPLE_RATE)
    session.end()
    elapsed = time.perf_counter() - started

    gate = FrameVad()
    gate_open = sum(1 for frame in frames if gate.is_speech(frame))
    lines = [segment["text"] for segment in session.finalized_segments]
    result = {
        "lines": lines,
        "segments": [(segment["start"], segment["end"]) for segment in session.finalized_segments],
        "frames": len(frames),
        "gate_open_frames": gate_open,
        "forwarded_frames": len(forwarded_at),
        "forwarded_at": forwarded_at,
        "forwarded_share": round(len(forwarded_at) / len(frames), 3),
        "seconds": round(elapsed, 1),
        "stream_seconds": round(len(frames) * FRAME_SAMPLES / SAMPLE_RATE, 1),
    }
    if clip_start_s is not None:
        forwarded = set(forwarded_at)
        first = int(clip_start_s * SAMPLE_RATE // FRAME_SAMPLES)
        last = int(np.ceil(clip_end_s * SAMPLE_RATE / FRAME_SAMPLES))
        clip_frames = [i for i in range(first, last) if i < len(frames)]
        dropped = [i for i in clip_frames if round((i + 1) * FRAME_SAMPLES / SAMPLE_RATE, 3) not in forwarded]
        result["clip_frames"] = len(clip_frames)
        result["clip_frames_dropped"] = len(dropped)
        result["clip_frames_dropped_share"] = round(len(dropped) / len(clip_frames), 3)
    return result


def clip_in_noise(clip_dbfs, offset_samples=0, lead_s=1.0, tail_s=2.5, noise_dbfs=-63, seed=7):
    """The JFK clip scaled to clip_dbfs, surrounded by room noise, starting offset_samples into a frame."""
    clip = scale_to_dbfs(load_clip(), clip_dbfs)
    lead = int(lead_s * SAMPLE_RATE) + offset_samples
    tail = int(tail_s * SAMPLE_RATE)
    stream = np.concatenate([white_noise(lead, noise_dbfs, seed), clip, white_noise(tail, noise_dbfs, seed + 1)])
    return stream, lead / SAMPLE_RATE, (lead + len(clip)) / SAMPLE_RATE


def continuous_fast_speech(repeats=3, speed=1.25):
    """The clip with its pauses and room tone removed, sped up, and repeated: speech with no pause to end an
    utterance in and no free place for a cut to land. Returns (samples, reference text)."""
    clip = load_clip()
    frames = [clip[i : i + FRAME_SAMPLES] for i in range(0, len(clip) - FRAME_SAMPLES + 1, FRAME_SAMPLES)]
    speech = np.concatenate([f for f in frames if 20 * np.log10(max(rms(f), 1e-9)) > -36])
    fast = np.interp(np.arange(0, len(speech) - 1, speed), np.arange(len(speech)), speech).astype(np.float32)
    return np.concatenate([fast] * repeats), " ".join([JFK_REFERENCE] * repeats)
