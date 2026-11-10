"""Disposable controller/gateway for real account browser tests; no host agent."""
import json
import os
import secrets
import signal
import sys
import threading
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from canaveral.api import server as api_server
from canaveral.client import Client
from canaveral.dashboard import server as dashboard_server
from canaveral.files import save_json
from canaveral.store import Store


class TestAssets:
    def __init__(self, directory):
        self.directory = Path(directory).resolve(strict=True)

    def joinpath(self, name):
        if name != "web":
            raise ValueError("Only the built web bundle can be substituted")
        return self.directory


root = Path(os.environ["CANAVERAL_ACCOUNT_FIXTURE_DIR"]).resolve(strict=True)
if (root / "controller.sqlite3").exists():
    raise RuntimeError("Choose a fresh disposable fixture directory")
admin, enrollment = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
store = Store(root / "controller.sqlite3")
host = str(uuid.uuid4())
store.enroll({"id": host, "credential": secrets.token_urlsafe(32), "offer": {
    "name": "Fixture host; no runner", "provider": "libvirt",
    "capacity": {"cpu": 16, "memoryMiB": 16384, "diskGiB": 256},
    "templates": [{"id": "linux", "revision": "1", "os": "linux", "arch": "amd64", "mode": "headless",
                   "minimum": {"cpu": 1, "memoryMiB": 1024, "diskGiB": 4}}],
}})
legacy = store.create({"id": str(uuid.uuid4()), "name": "Admin private machine", "templateId": "linux", "resources": {}})
api = api_server(store, ("127.0.0.1", 18767), admin, enrollment)
threading.Thread(target=api.serve_forever, daemon=True).start()
claim = Client("http://127.0.0.1:18767", admin).request("POST", "/v1/auth/bootstrap", {})
save_json(root / "bootstrap.json", {"token": claim["token"], "legacyMachine": legacy["id"]})
stop = threading.Event()
for signum in (signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, lambda *_: stop.set())
try:
    with patch("canaveral.dashboard.files", return_value=TestAssets(os.environ["CANAVERAL_TEST_ASSETS"])):
        gateway = dashboard_server(("127.0.0.1", 18768), "http://127.0.0.1:18767")
        try:
            threading.Thread(target=gateway.serve_forever, daemon=True).start()
            stop.wait()
        finally:
            gateway.shutdown()
            gateway.server_close()
finally:
    api.shutdown()
    api.server_close()
