import concurrent.futures
import contextlib
import io
import json
import secrets
import unittest
from http.cookies import SimpleCookie
from pathlib import Path
from unittest.mock import patch

from canaveral.accounts import Accounts, ITERATIONS, SESSION_SECONDS
from canaveral.cli import main
from canaveral.client import Client
from canaveral.dashboard import server
from canaveral.model import Error
from canaveral.store import Store
from test_dashboard import DashboardFixture


class AccountTests(DashboardFixture):
    password = "disposable-test-password-123"

    def setup_account(self, username="admin", password=None):
        status, headers, body = self.fetch("/api/v1/auth/setup", {"username": username, "password": password or self.password})
        self.assertEqual(status, 200, body)
        result = json.loads(body)
        result["token"] = SimpleCookie(headers["Set-Cookie"])["canaveral_session"].value
        return result

    def test_first_run_is_atomic_and_never_replaces_an_existing_admin(self):
        status = json.loads(self.fetch("/api/v1/auth/status")[2])
        self.assertEqual(status, {"setupRequired": True, "setupAllowed": True})
        first = self.setup_account()
        self.assertEqual(first["user"]["username"], "admin")
        self.assertEqual(first["expiresAt"], self.now + SESSION_SECONDS)
        self.assertFalse(json.loads(self.fetch("/api/v1/auth/status")[2])["setupRequired"])
        self.assertEqual(self.fetch("/api/v1/auth/setup", {"username": "replacement", "password": self.password})[0], 409)
        recovered = Accounts(Store(self.store.path, clock=lambda: self.now))
        self.assertFalse(recovered.status()["setupRequired"])
        self.assertTrue(recovered.authorized(first["token"]))
        self.assertEqual(recovered.login({"username": "ADMIN", "password": self.password})["user"]["username"], "admin")

    def test_session_authorizes_inventory_but_cannot_enroll_a_host(self):
        first = self.setup_account()
        session = Client(self.upstream, first["token"])
        self.assertEqual(session.request("GET", "/v1/machines"), {"machines": []})
        with self.assertRaises(Error) as error:
            session.request("POST", "/v1/hosts/enroll", {})
        self.assertEqual(error.exception.status, 401)
        self.assertEqual(self.fetch("/api/v1/auth/logout", {}, first["token"])[0], 200)
        self.assertEqual(self.fetch("/api/v1/machines", token=first["token"])[0], 401)
        self.assertEqual(self.fetch("/api/v1/machines", token=self.admin)[0], 200)
        _, headers, _ = self.fetch("/api/v1/auth/login", {"username": "admin", "password": self.password})
        session = {"token": SimpleCookie(headers["Set-Cookie"])["canaveral_session"].value}
        self.now += SESSION_SECONDS
        self.assertEqual(self.fetch("/api/v1/hosts", token=session["token"])[0], 401)

    def test_persistent_cookie_restores_identity_and_logout_revokes_it(self):
        self.setup_account()
        status, headers, body = self.fetch("/api/v1/auth/login", {"username": "admin", "password": self.password})
        self.assertEqual(status, 200)
        self.assertNotIn("token", json.loads(body))
        cookie = SimpleCookie(headers["Set-Cookie"])["canaveral_session"]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Strict")
        self.assertEqual(int(cookie["max-age"]), SESSION_SECONDS)
        auth = {"Cookie": "canaveral_session=" + cookie.value, "Origin": self.url}
        self.assertEqual(self.fetch("/api/v1/hosts", headers=auth)[0], 200)
        # A stateless gateway restart keeps the controller-backed session.
        restarted = server(("127.0.0.1", 0), self.upstream)
        self.start(restarted)
        self.url = "http://127.0.0.1:" + str(restarted.server_port)
        auth["Origin"] = self.url
        status, _, body = self.fetch("/api/v1/auth/status", headers=auth)
        self.assertEqual(json.loads(body)["user"]["username"], "admin")
        for origin in ("https://attacker.example", "null"):
            self.assertEqual(self.fetch("/api/v1/auth/logout", {}, headers={**auth, "Origin": origin})[0], 403)
        self.assertEqual(self.fetch("/api/v1/auth/logout", {}, headers={"Cookie": auth["Cookie"]})[0], 403)
        status, headers, _ = self.fetch("/api/v1/auth/logout", {}, headers=auth)
        self.assertEqual(status, 200)
        self.assertEqual(SimpleCookie(headers["Set-Cookie"])["canaveral_session"]["max-age"], "0")
        self.assertEqual(self.fetch("/api/v1/hosts", headers=auth)[0], 401)
        self.assertNotIn("user", json.loads(self.fetch("/api/v1/auth/status", headers=auth)[2]))

    def test_cookie_is_secure_for_remote_hosts_and_expires(self):
        first = self.setup_account()
        _, headers, body = self.fetch("/api/v1/auth/login", {"username": "admin", "password": self.password}, headers={"Host": "private.example.internal"})
        self.assertTrue(SimpleCookie(headers["Set-Cookie"])["canaveral_session"]["secure"])
        auth = {"Cookie": "canaveral_session=" + first["token"]}
        self.now += SESSION_SECONDS
        status, headers, body = self.fetch("/api/v1/auth/status", headers=auth)
        self.assertEqual(status, 200)
        self.assertNotIn("user", json.loads(body))
        self.assertIn("Max-Age=0", headers["Set-Cookie"])

    def test_setup_requires_operator_proof_and_loopback_host(self):
        empty = Client(self.upstream, "")
        for credential in ("", self.enrollment, secrets.token_urlsafe(32)):
            with self.assertRaises(Error) as error:
                Client(self.upstream, credential).request("POST", "/v1/auth/setup", {"username": "admin", "password": self.password})
            self.assertEqual(error.exception.status, 401)
        self.assertTrue(empty.request("GET", "/v1/auth/status")["setupRequired"])
        status, _, body = self.fetch("/api/v1/auth/status", headers={"Host": "private.example.internal"})
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)["setupAllowed"])
        self.assertEqual(self.fetch("/api/v1/auth/setup", {"username": "admin", "password": self.password}, headers={"Host": "private.example.internal"})[0], 403)
        self.assertEqual(self.fetch("/api/v1/auth/setup", {"username": "admin", "password": self.password}, headers={"Origin": "https://attacker.example"})[0], 403)
        with patch("canaveral.dashboard.ipaddress.ip_address") as address:
            address.return_value.is_loopback = False
            self.assertEqual(self.fetch("/api/v1/auth/setup", {"username": "admin", "password": self.password}, headers={"Host": "localhost"})[0], 403)
        no_bootstrap = server(("127.0.0.1", 0), self.upstream)
        self.start(no_bootstrap)
        self.url = "http://127.0.0.1:" + str(no_bootstrap.server_port)
        self.assertFalse(json.loads(self.fetch("/api/v1/auth/status")[2])["setupAllowed"])
        self.assertEqual(self.fetch("/api/v1/auth/setup", {"username": "admin", "password": self.password})[0], 403)

    def test_passwords_and_sessions_are_hashed_and_credential_failures_are_generic(self):
        first = self.setup_account()
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM users").fetchone()
            self.assertEqual(row["iterations"], ITERATIONS)
            self.assertEqual(len(row["salt"]), 64)
            self.assertNotEqual(row["password_hash"], self.password)
            session = db.execute("SELECT token_hash FROM user_sessions").fetchone()[0]
            self.assertNotEqual(session, first["token"])
        unknown = self.fetch("/api/v1/auth/login", {"username": "unknown", "password": self.password})
        wrong = self.fetch("/api/v1/auth/login", {"username": "admin", "password": "wrong-test-password"})
        self.assertEqual((unknown[0], unknown[2]), (wrong[0], wrong[2]))
        self.assertEqual(unknown[0], 401)
        self.assertNotIn(self.password.encode(), self.fetch("/")[2])

    def test_login_budget_survives_restarts_and_allows_later_recovery(self):
        self.setup_account()
        account = Accounts(self.store)
        for index in range(10):
            with self.assertRaises(Error) as error:
                account.login({"username": "unknown" + str(index), "password": ""})
            self.assertEqual(error.exception.status, 401)
        response = self.fetch("/api/v1/auth/login", {"username": "admin", "password": self.password})
        self.assertEqual(response[0], 429)
        self.assertEqual(response[1]["Retry-After"], "60")
        restored = Accounts(Store(self.store.path, clock=lambda: self.now))
        with self.assertRaises(Error) as error:
            restored.login({"username": "admin", "password": self.password})
        self.assertEqual(error.exception.status, 429)
        self.now += 61
        self.assertTrue(restored.login({"username": "admin", "password": self.password})["token"])

    def test_concurrent_setup_can_only_create_one_account(self):
        def attempt(index):
            try:
                return Client(self.upstream, self.admin).request("POST", "/v1/auth/setup", {"username": "admin" + str(index), "password": self.password})
            except Error as error:
                self.assertEqual(error.status, 409)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = [item for item in pool.map(attempt, range(4)) if item]
        self.assertEqual(len(results), 1)
        with self.store.transaction() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM users").fetchone()[0], 1)

    def test_cli_creation_is_idempotent_and_does_not_print_session_or_password(self):
        path = Path(self.temp.name) / "admin.token"
        path.write_text(self.admin)
        password = Path(self.temp.name) / "password"
        password.write_text(self.password + "\n")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            main(["--url", self.upstream, "--token-file", str(path), "admin", "create", "--password-file", str(password)])
            # Existing admin is checked before reading any new password file.
            main(["--url", self.upstream, "--token-file", str(path), "admin", "create", "--username", "replacement", "--password-file", "/missing/password"])
        self.assertIn("Created administrator admin.", output.getvalue())
        self.assertIn("already exists; no changes made", output.getvalue())
        self.assertNotIn(self.password, output.getvalue())
        with self.store.transaction() as db:
            self.assertEqual(db.execute("SELECT username FROM users").fetchone()[0], "admin")
            self.assertEqual(db.execute("SELECT count(*) FROM user_sessions").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
