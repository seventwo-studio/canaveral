import concurrent.futures
import copy
import json
import secrets
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from canaveral.api import server
from canaveral.client import Client
from canaveral.host import Agent
from canaveral.model import Error
from canaveral.store import Store


def image(mode="headless", arch="amd64"):
    return {"id": "linux", "revision": "1", "os": "linux", "arch": arch, "mode": mode,
            "minimum": {"cpu": 1, "memoryMiB": 1024, "diskGiB": 4}}


def host_offer(capacity=None):
    return {"name": "host", "provider": "libvirt", "capacity": capacity or {"cpu": 4, "memoryMiB": 4096, "diskGiB": 40}, "templates": [image()]}


def request(**overrides):
    return {"id": str(uuid.uuid4()), "name": "general-purpose-computer", "templateId": "linux",
            "resources": {"cpu": 2, "memoryMiB": 2048, "diskGiB": 10}, **overrides}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1000
        self.path = Path(self.temp.name) / "state.sqlite3"
        self.store = Store(self.path, clock=lambda: self.now)
        self.host = str(uuid.uuid4())
        self.token = secrets.token_urlsafe(32)
        self.offer = host_offer()
        self.store.enroll({"id": self.host, "credential": self.token, "offer": self.offer})

    def report(self, reports):
        return self.store.heartbeat(self.host, self.token, {"offer": self.offer, "reports": reports})

    def test_concurrent_creation_never_overcommits_and_restart_preserves_reservations(self):
        def attempt(_):
            try:
                return self.store.create(request())["id"]
            except Error:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            successful = [value for value in pool.map(attempt, range(10)) if value]
        self.assertEqual(len(successful), 2)
        self.store = Store(self.path, clock=lambda: self.now)
        with self.assertRaises(Error):
            self.store.create(request())
        self.assertEqual(len(self.store.machines()), 2)

    def test_lost_creation_response_is_idempotent_and_conflicting_request_is_rejected(self):
        value = request()
        first = self.store.create(value)
        self.assertEqual(self.store.create(value)["id"], first["id"])
        with self.assertRaises(Error):
            self.store.create({**value, "name": "changed"})

    def test_offline_host_is_not_rescheduled_and_its_capacity_is_not_released(self):
        vm = self.store.create(request())
        self.now += 31
        self.assertFalse(self.store.hosts()[0]["online"])
        self.assertEqual(self.store.machines()[0]["observed"], "unknown")
        second = str(uuid.uuid4())
        self.store.enroll({"id": second, "credential": secrets.token_urlsafe(32), "offer": self.offer})
        self.assertEqual(self.store.machines()[0]["hostId"], vm["hostId"])

    def test_shutdown_frees_compute_only_after_confirmation_and_keeps_disk(self):
        a, b = self.store.create(request()), self.store.create(request())
        self.store.desired(a["id"], "stopped")
        with self.assertRaises(Error):
            self.store.create(request())
        self.report({a["id"]: {"state": "stopped"}})
        c = self.store.create(request())
        self.assertTrue(c)
        with self.assertRaises(Error):
            self.store.desired(a["id"], "running")
        self.report({b["id"]: {"state": "stopped"}, c["id"]: {"state": "stopped"}})
        self.store.desired(b["id"], "stopped")
        self.store.desired(c["id"], "stopped")
        # Three stopped disks occupy 30/40 GiB: a 20 GiB request cannot fit.
        with self.assertRaises(Error):
            self.store.create(request(resources={"cpu": 1, "memoryMiB": 1024, "diskGiB": 20}))

    def test_credentials_cannot_take_over_an_identity_or_report_other_hosts(self):
        self.assertEqual(self.store.enroll({"id": self.host, "credential": self.token, "offer": self.offer})["id"], self.host)
        with self.assertRaises(Error):
            self.store.enroll({"id": self.host, "credential": secrets.token_urlsafe(32), "offer": self.offer})
        other, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        self.store.enroll({"id": other, "credential": token, "offer": self.offer})
        vm = self.store.create(request(hostId=self.host))
        with self.assertRaises(Error):
            self.store.heartbeat(other, token, {"offer": self.offer, "reports": {vm["id"]: {"state": "stopped"}}})
        with self.assertRaises(Error):
            self.store.heartbeat(self.host, "wrong", {"offer": self.offer})
        self.assertNotIn("credential", self.store.hosts()[0])

    def test_template_architecture_minimums_and_drain_control_placement(self):
        with self.assertRaises(Error):
            self.store.create(request(arch="arm64"))
        with self.assertRaises(Error):
            self.store.create(request(resources={"cpu": 1, "memoryMiB": 512, "diskGiB": 10}))
        self.store.enable(self.host, False)
        with self.assertRaises(Error):
            self.store.create(request())
        self.store.enable(self.host, True)
        self.assertEqual(self.store.create(request())["template"]["revision"], "1")

    def test_invalid_numbers_and_partial_heartbeats_do_not_mutate_the_store(self):
        for bad in (True, -1, 0, 1.5, "2", 2 ** 100):
            with self.assertRaises(Error):
                self.store.create(request(resources={"cpu": bad, "memoryMiB": 1024, "diskGiB": 10}))
        vm = self.store.create(request())
        with self.assertRaises(Error):
            self.report({vm["id"]: {"state": "stopped"}, str(uuid.uuid4()): {"state": "stopped"}})
        self.assertEqual(self.store.machines()[0]["observed"], "pending")


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.admin, self.enroll = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.service = server(Store(Path(self.temp.name) / "db"), ("127.0.0.1", 0), self.admin, self.enroll)
        self.thread = threading.Thread(target=self.service.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.service.server_port)
        self.addCleanup(self.service.server_close)
        self.addCleanup(self.service.shutdown)
        self.client = Client(self.url, self.admin)

    def test_real_http_enrollment_assignment_heartbeat_shutdown_and_reconnect(self):
        host, credential = str(uuid.uuid4()), secrets.token_urlsafe(32)
        offered = host_offer()
        enrolled = Client(self.url, self.enroll).request("POST", "/v1/hosts/enroll", {"id": host, "credential": credential, "offer": offered})
        vm = self.client.request("POST", "/v1/machines", request())
        worker = Client(self.url, credential)
        response = worker.request("POST", "/v1/hosts/" + enrolled["id"] + "/heartbeat", {"offer": offered, "reports": {vm["id"]: {"state": "running"}}})
        self.assertEqual(response["machines"][0]["desired"], "running")
        self.client.request("POST", "/v1/machines/" + vm["id"] + "/desired", {"state": "stopped"})
        response = worker.request("POST", "/v1/hosts/" + host + "/heartbeat", {"offer": offered, "reports": {vm["id"]: {"state": "stopped"}}})
        self.assertEqual(response["machines"][0]["desired"], "stopped")
        self.assertEqual(self.client.request("GET", "/v1/machines")["machines"][0]["observed"], "stopped")

    def test_role_separation_and_browser_origin_rejection(self):
        import urllib.request
        import urllib.error
        for token in (self.enroll, "invalid"):
            with self.assertRaises(Error):
                Client(self.url, token).request("GET", "/v1/machines")
        req = urllib.request.Request(self.url + "/v1/hosts", headers={"Authorization": "Bearer " + self.admin, "Origin": "https://example.com"})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(req)
        self.assertEqual(error.exception.code, 403)
        error.exception.close()

    def test_client_rejects_remote_cleartext_and_credentials_in_url(self):
        for url in ("http://other-host:8765", "https://user:pass@example.com", "https://example.com/subpath"):
            with self.assertRaises(Error):
                Client(url, self.admin)

    def test_installed_cli_flow_reuses_the_api_and_rejects_reinitializing_credentials(self):
        import subprocess
        import sys
        credentials = Path(self.temp.name) / "credentials"
        subprocess.run([sys.executable, "-m", "canaveral", "init", str(credentials)], check=True, capture_output=True)
        original = (credentials / "admin.token").read_bytes()
        duplicate = subprocess.run([sys.executable, "-m", "canaveral", "init", str(credentials)], capture_output=True)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertEqual((credentials / "admin.token").read_bytes(), original)
        # Use the running test server's credential, rather than creating another server.
        (credentials / "admin.token").write_text(self.admin)
        output = subprocess.check_output([sys.executable, "-m", "canaveral", "--url", self.url, "--token-file", str(credentials / "admin.token"), "hosts"])
        self.assertEqual(json.loads(output), {"hosts": []})

    def test_agent_uses_real_api_and_retains_identity_without_enrollment_secret(self):
        with patch("canaveral.host.provider_for") as factory:
            agent = Agent(host_offer(), self.url, Path(self.temp.name) / "host")
            agent.connect(self.enroll)
            agent.poll()
            vm = self.client.request("POST", "/v1/machines", request())
            agent.poll()
            self.assertEqual(agent.assignments[0]["id"], vm["id"])
            factory.return_value.reconcile.return_value = {"state": "running"}
            with agent.lock:
                agent.reports[vm["id"]] = agent.reconcile(agent.assignments[0])
            agent.poll()
            self.assertEqual(self.client.request("GET", "/v1/machines")["machines"][0]["observed"], "running")
            recovered = Agent(host_offer(), self.url, Path(self.temp.name) / "host")
            recovered.connect(None)
            recovered.poll()
            self.assertEqual(recovered.identity, agent.identity)
            changed = copy.deepcopy(agent.assignments[0])
            changed["template"]["revision"] = "uninstalled"
            with self.assertRaises(Error):
                agent.reconcile(changed)


if __name__ == "__main__":
    unittest.main()
