import contextlib
import http.client
import json
import secrets
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from canaveral.api import server as api_server
from canaveral.cli import parser
from canaveral.dashboard import server
from canaveral.model import Error
from canaveral.store import Store
from test_orchestration import host_offer, request


class DashboardFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.admin, self.enrollment = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.now = 1000
        self.store = Store(Path(self.temp.name) / "db", clock=lambda: self.now)
        self.api = api_server(self.store, ("127.0.0.1", 0), self.admin, self.enrollment)
        self.start(self.api)
        self.upstream = "http://127.0.0.1:" + str(self.api.server_port)
        self.service = server(("127.0.0.1", 0), self.upstream, bootstrap_token=self.admin)
        self.start(self.service)
        self.url = "http://127.0.0.1:" + str(self.service.server_port)

    def start(self, service):
        threading.Thread(target=service.serve_forever, daemon=True).start()
        self.addCleanup(service.server_close)
        self.addCleanup(service.shutdown)

    def fetch(self, path, value=None, token=None, headers=None, raw=None):
        data = raw if raw is not None else json.dumps(value).encode() if value is not None else None
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if token is not None:
            request_headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(self.url + path, data=data, headers=request_headers)
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, error.read()

    def enroll(self):
        host, credential, offered = str(uuid.uuid4()), secrets.token_urlsafe(32), host_offer()
        self.store.enroll({"id": host, "credential": credential, "offer": offered})
        return host, credential, offered


class DashboardTests(DashboardFixture):
    def test_html_style_nonce_is_fresh_and_matches_the_policy(self):
        import re
        nonces = []
        for _ in range(2):
            _, headers, body = self.fetch("/")
            nonce = re.search(rb'name="csp-nonce" content="([^"]+)"', body).group(1).decode()
            self.assertNotEqual(nonce, "CANAVERAL_CSP_NONCE")
            policy = headers["Content-Security-Policy"]
            self.assertIn("'nonce-" + nonce + "'", policy)
            self.assertIn("script-src 'self';", policy)
            self.assertIn("style-src-attr 'unsafe-inline'", policy)
            nonces.append(nonce)
        self.assertNotEqual(*nonces)

    def test_static_assets_are_exact_and_do_not_embed_credentials_or_expose_files(self):
        for path, kind in [("/", "text/html"), ("/app.js", "text/javascript"), ("/style.css", "text/css"), ("/favicon.svg", "image/svg+xml"), ("/launch.jpg", "image/jpeg"), ("/geist-mono.woff2", "font/woff2"), ("/licenses.txt", "text/plain")]:
            status, headers, body = self.fetch(path)
            self.assertEqual(status, 200)
            self.assertIn(kind, headers["Content-Type"])
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertNotIn(self.admin.encode(), body)
            self.assertIsNone(headers["Set-Cookie"])
        for path in ("/../pyproject.toml", "/%2e%2e/pyproject.toml", "/api/v1/hosts/enroll", "/api/v1/machines/00000000-0000-0000-0000-000000000000/prepared"):
            self.assertEqual(self.fetch(path, token=self.admin)[0], 404)
        for path in ("/api/v1/hosts/enroll", "/api/v1/hosts/00000000-0000-0000-0000-000000000000/heartbeat", "/api/v1/machines/00000000-0000-0000-0000-000000000000/prepared"):
            self.assertEqual(self.fetch(path, {}, self.admin)[0], 404)
        self.assertEqual(self.fetch("/api/v1/hosts?url=https://example.com", token=self.admin)[0], 400)

    def test_gateway_preserves_role_separation_and_cross_origin_rejection(self):
        for token in (None, self.enrollment, "bad", secrets.token_urlsafe(32)):
            self.assertEqual(self.fetch("/api/v1/hosts", token=token)[0], 401)
        self.assertEqual(self.fetch("/api/v1/hosts", token=self.admin)[0], 200)
        for origin in ("https://example.com", "null", self.url + ".example.com"):
            status, headers, _ = self.fetch("/api/v1/hosts", token=self.admin, headers={"Origin": origin})
            self.assertEqual(status, 403)
            self.assertIsNone(headers["Access-Control-Allow-Origin"])
        self.assertEqual(self.fetch("/api/v1/hosts", token=self.admin, headers={"Origin": self.url, "Sec-Fetch-Site": "same-origin"})[0], 200)
        self.assertEqual(self.fetch("/api/v1/hosts", token=self.admin, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        direct = urllib.request.Request(self.upstream + "/v1/hosts", headers={"Authorization": "Bearer " + self.admin, "Origin": self.url})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(direct)
        self.assertEqual(error.exception.code, 403)
        error.exception.close()

    def test_real_gateway_creation_retry_and_reported_lifecycle(self):
        host, credential, offered = self.enroll()
        value = request(templateRevision="1", arch="amd64", hostId=host)
        status, _, body = self.fetch("/api/v1/machines", value, self.admin, {"Origin": self.url})
        self.assertEqual(status, 200)
        machine = json.loads(body)
        self.assertEqual(machine["observed"], "pending")
        self.assertFalse(machine["ready"])
        self.assertEqual(self.fetch("/api/v1/machines", value, self.admin)[0], 200)
        self.assertEqual(len(self.store.machines()), 1)
        self.assertEqual(self.fetch("/api/v1/machines", {**value, "name": "changed"}, self.admin)[0], 409)
        self.store.heartbeat(host, credential, {"offer": offered, "reports": {machine["id"]: {"state": "running"}}})
        machines = json.loads(self.fetch("/api/v1/machines", token=self.admin)[2])["machines"]
        self.assertTrue(machines[0]["ready"])
        path = "/api/v1/machines/" + machine["id"] + "/desired"
        stopped = json.loads(self.fetch(path, {"state": "stopped"}, self.admin, {"Origin": self.url})[2])
        self.assertEqual(stopped["desired"], "stopped")
        self.assertEqual(stopped["observed"], "running")
        self.assertEqual(self.fetch("/api/v1/hosts/" + host + "/accepting", {"enabled": False}, self.admin)[0], 200)
        self.assertFalse(self.store.hosts()[0]["enabled"])
        self.assertEqual(self.fetch(path, {"state": "running"}, self.admin)[0], 409)

    def test_reservations_remain_exact_after_shutdown_and_an_offline_lease(self):
        host, credential, offered = self.enroll()
        machine = self.store.create(request())
        self.store.desired(machine["id"], "stopped")
        self.assertEqual(self.store.hosts()[0]["reserved"], {"cpu": 2, "memoryMiB": 2048, "diskGiB": 10})
        self.store.heartbeat(host, credential, {"offer": offered, "reports": {machine["id"]: {"state": "stopped"}}})
        self.now += 31
        host = json.loads(self.fetch("/api/v1/hosts", token=self.admin)[2])["hosts"][0]
        self.assertFalse(host["online"])
        self.assertEqual(host["reserved"], {"cpu": 0, "memoryMiB": 0, "diskGiB": 10})
        self.assertEqual(self.store.machines()[0]["observed"], "unknown")

    def test_gateway_rejects_malformed_bodies_before_mutation(self):
        self.enroll()
        for raw in (b"[]", b"null", b"{broken"):
            self.assertEqual(self.fetch("/api/v1/machines", token=self.admin, raw=raw)[0], 400)
        self.assertEqual(self.fetch("/api/v1/machines", request(), self.admin, {"Content-Type": "text/plain"})[0], 415)
        # Send an oversized length without streaming a rejected body into a
        # closed socket, so the test observes the server's actual response.
        with contextlib.closing(http.client.HTTPConnection("127.0.0.1", self.service.server_port)) as connection:
            connection.putrequest("POST", "/api/v1/machines")
            connection.putheader("Authorization", "Bearer " + self.admin)
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Content-Length", "1048577")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            response.read()
        self.assertEqual(self.store.machines(), [])

    def test_optional_command_and_upstream_configuration(self):
        args = parser().parse_args(["--url", self.upstream, "dashboard"])
        self.assertEqual((args.command, args.bind, args.port), ("dashboard", "127.0.0.1", 8766))
        self.assertNotIn("database", vars(args))
        for origin in ("http://remote-host:8765", "https://user:pass@example.com", "https://example.com/path"):
            with self.assertRaises(Error):
                server(("127.0.0.1", 0), origin)
        self.assertEqual(self.fetch("/healthz")[0], 200)


if __name__ == "__main__":
    unittest.main()
