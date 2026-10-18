"""
The speech model is read from the local cache without contacting the Hugging Face hub; only a model that is
not cached is downloaded. (2026-10-15: the sidecar's start-up asked the hub whether its cached model was
current, that request stalled at boot, and the service sat for three days without ever listening.)
"""

import socket
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import transcribe


class HubContractTests(unittest.TestCase):
    """What the fix relies on in faster-whisper / huggingface_hub, checked on the installed versions."""

    def test_a_populated_cache_resolves_with_no_network_and_an_empty_one_raises_file_not_found(self):
        from faster_whisper.utils import download_model

        def no_network(*args, **kwargs):
            raise AssertionError("the network was used")

        with tempfile.TemporaryDirectory() as cache:
            repo = Path(cache) / "models--Systran--faster-whisper-small"
            snapshot = repo / "snapshots" / ("a" * 40)
            snapshot.mkdir(parents=True)
            (repo / "refs").mkdir()
            (repo / "refs" / "main").write_text("a" * 40)
            for name in ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt"):
                (snapshot / name).write_text("x")
            with mock.patch.object(socket.socket, "connect", no_network), mock.patch.object(
                socket, "create_connection", no_network
            ):
                self.assertEqual(Path(download_model("small", local_files_only=True, cache_dir=cache)), snapshot)
                with self.assertRaises(FileNotFoundError):
                    download_model("tiny", local_files_only=True, cache_dir=cache)

    def test_a_bad_model_name_is_a_value_error_not_a_missing_cache(self):
        from faster_whisper.utils import download_model

        with self.assertRaises(ValueError):
            download_model("no-such-size", local_files_only=True)


class ResolveModelPathTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(transcribe, "WHISPER_MODEL", "small")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_cached_model_is_found_without_going_online(self):
        calls = []

        def fake(name, **kwargs):
            calls.append((name, kwargs))
            return "/cache/small"

        downloads = []
        with mock.patch.object(transcribe, "_download_model", fake):
            self.assertEqual(transcribe._resolve_model_path(on_download=lambda: downloads.append(1)), "/cache/small")
        self.assertEqual(calls, [("small", {"local_files_only": True})], "one lookup, local only")
        self.assertEqual(downloads, [])

    def test_an_uncached_model_is_downloaded_after_the_caller_is_told(self):
        order = []

        def fake(name, **kwargs):
            order.append(("local" if kwargs.get("local_files_only") else "online", name))
            if kwargs.get("local_files_only"):
                raise FileNotFoundError("nothing cached")
            return "/cache/small"

        with mock.patch.object(transcribe, "_download_model", fake):
            with self.assertLogs("transcribe", level="WARNING") as logs:
                path = transcribe._resolve_model_path(on_download=lambda: order.append(("told", None)))
        self.assertEqual(path, "/cache/small")
        self.assertEqual(order, [("local", "small"), ("told", None), ("online", "small")])
        self.assertIn("not in the local cache", " ".join(logs.output))

    def test_a_folder_given_as_the_model_is_used_as_it_is(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(transcribe, "WHISPER_MODEL", folder):
            with mock.patch.object(transcribe, "_download_model", side_effect=AssertionError("no lookup")):
                self.assertEqual(transcribe._resolve_model_path(), folder)

    def test_a_bad_model_name_is_not_answered_with_a_download(self):
        calls = []

        def fake(name, **kwargs):
            calls.append(kwargs)
            raise ValueError("Invalid model size")

        with mock.patch.object(transcribe, "_download_model", fake):
            with self.assertRaises(ValueError):
                transcribe._resolve_model_path()
        self.assertEqual(len(calls), 1, "no second, online attempt")

    def test_a_failed_download_is_raised_not_hidden(self):
        def fake(name, **kwargs):
            if kwargs.get("local_files_only"):
                raise FileNotFoundError("nothing cached")
            raise ConnectionError("no route to host")

        with mock.patch.object(transcribe, "_download_model", fake):
            with self.assertLogs("transcribe", level="WARNING"):
                with self.assertRaises(ConnectionError):
                    transcribe._resolve_model_path()


class LoadWhisperTests(unittest.TestCase):
    def setUp(self):
        saved = transcribe._whisper_model
        transcribe._whisper_model = None
        self.addCleanup(setattr, transcribe, "_whisper_model", saved)

    def test_the_model_is_loaded_from_the_resolved_folder_once(self):
        loaded = []

        class FakeWhisper:
            def __init__(self, path, **kwargs):
                loaded.append((path, kwargs))

        with mock.patch("faster_whisper.WhisperModel", FakeWhisper), mock.patch.object(
            transcribe, "_download_model", return_value="/cache/small"
        ) as lookup:
            first = transcribe._load_whisper()
            second = transcribe._load_whisper()
        self.assertIs(first, second)
        self.assertEqual(len(loaded), 1)
        path, kwargs = loaded[0]
        self.assertEqual(path, "/cache/small", "the folder, so the loader never asks the hub itself")
        self.assertEqual(kwargs["device"], transcribe.WHISPER_DEVICE)
        self.assertEqual(kwargs["compute_type"], transcribe.WHISPER_COMPUTE_TYPE)
        self.assertEqual(lookup.call_count, 1)
        self.assertEqual(lookup.call_args.kwargs, {"local_files_only": True})

    def test_warmup_passes_the_download_hook_on(self):
        told = []

        def fake(name, **kwargs):
            if kwargs.get("local_files_only"):
                raise FileNotFoundError("nothing cached")
            return "/cache/small"

        with mock.patch("faster_whisper.WhisperModel", lambda path, **kw: object()), mock.patch.object(
            transcribe, "_download_model", fake
        ), self.assertLogs("transcribe", level="WARNING"):
            transcribe.warmup(on_download=lambda: told.append(True))
        self.assertEqual(told, [True])


if __name__ == "__main__":
    unittest.main()
