"""Serve the production gateway for browser tests; browser routes supply fixtures."""
import sys
import os
import contextlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from canaveral.dashboard import server

class TestAssets:
    def __init__(self, directory):
        self.directory = Path(directory).resolve(strict=True)

    def joinpath(self, name):
        if name != "web":
            raise ValueError("Browser fixtures only override the web bundle")
        return self.directory


assets = os.environ.get("CANAVERAL_TEST_ASSETS")
override = patch("canaveral.dashboard.files", return_value=TestAssets(assets)) if assets else contextlib.nullcontext()
with override:
    server(("127.0.0.1", 18766), "http://127.0.0.1:18765").serve_forever()
