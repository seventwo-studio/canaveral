import contextlib
import io
import json
import unittest
import uuid
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit

from canaveral.cli import main
from canaveral.client import Client
from canaveral.model import Error
from test_dashboard import DashboardFixture
from test_orchestration import request


class AccountCLIIntegrationTests(DashboardFixture):
    password = "separate-integration-password"

    def setUp(self):
        super().setUp()
        self.operator_file = self.private("operator", self.admin)
        self.operator = Client(self.upstream, self.admin)

    def private(self, name, content):
        path = Path(self.temp.name) / name
        path.write_text(content)
        path.chmod(0o600)
        return path

    def cli(self, credential, args):
        output = io.StringIO()
        argv = ["--url", self.upstream]
        if credential:
            argv += ["--token-file", str(credential)]
        with contextlib.redirect_stdout(output):
            main(argv + args)
        return output.getvalue()

    def administrator(self):
        return self.operator.request("POST", "/v1/auth/setup", {"username": "admin", "password": self.password})

    def activate(self, name):
        user = self.operator.request("POST", "/v1/users", {"id": str(uuid.uuid4()), "username": name})
        invitation = self.operator.request("POST", "/v1/users/" + user["id"] + "/invite", {})
        Client(self.upstream, "").request("POST", "/v1/auth/claim", {"token": invitation["token"], "password": self.password})
        destination = Path(self.temp.name) / (name + ".session")
        password = self.private(name + ".password", self.password)
        output = self.cli(None, ["login", "--username", name, "--password-file", str(password), "--output-file", str(destination)])
        self.assertNotIn(self.password, output)
        self.assertNotIn(destination.read_text().strip(), output)
        return user, destination, Client(self.upstream, destination.read_text().strip())

    def mint(self, session_file, name="inventory"):
        token_id = str(uuid.uuid4())
        destination = Path(self.temp.name) / (name + ".token")
        output = self.cli(session_file, ["tokens", "create", "--name", name, "--scope", "machines:read",
                                        "--request-id", token_id, "--output-file", str(destination)])
        self.assertNotIn(destination.read_text().strip(), output)
        return token_id, destination, Client(self.upstream, destination.read_text().strip())

    def test_cli_owned_inventory_scopes_and_revocation(self):
        self.administrator()
        user, session_file, alice = self.activate("alice")
        self.enroll()
        foreign = self.operator.request("POST", "/v1/machines", request(name="admin-private"))
        own = alice.request("POST", "/v1/machines", request(name="alice-private"))
        token_id, _, readonly = self.mint(session_file)
        machines = readonly.request("GET", "/v1/machines")["machines"]
        self.assertEqual([m["id"] for m in machines], [own["id"]])
        self.assertEqual(machines[0]["ownerId"], user["id"])
        for method, path, value, expected in [
            ("GET", "/v1/machines/" + foreign["id"], None, 404),
            ("POST", "/v1/machines", request(), 403),
            ("GET", "/v1/users", None, 403),
        ]:
            with self.assertRaises(Error) as failure:
                readonly.request(method, path, value)
            self.assertEqual(failure.exception.status, expected)
        listed = json.loads(self.cli(session_file, ["tokens", "list"]))["tokens"]
        self.assertEqual(listed[0]["id"], token_id)
        self.assertNotIn("token", listed[0])
        self.cli(session_file, ["tokens", "revoke", token_id])
        with self.assertRaises(Error) as failure:
            readonly.request("GET", "/v1/machines")
        self.assertEqual(failure.exception.status, 401)

    def test_cli_invitation_is_redeemed_through_the_real_cookie_gateway(self):
        self.administrator()
        user_id = str(uuid.uuid4())
        self.cli(self.operator_file, ["users", "create", "--username", "alice", "--request-id", user_id])
        link = Path(self.temp.name) / "alice.link"
        output = self.cli(self.operator_file, ["users", "invite", user_id, "--dashboard-url", self.url, "--output-file", str(link)])
        claim = urlsplit(link.read_text().strip()).fragment.removeprefix("claim=")
        self.assertNotIn(claim, output)
        status, headers, body = self.fetch("/api/v1/auth/claim", {"token": claim, "password": self.password}, headers={"Origin": self.url})
        self.assertEqual(status, 200, body)
        result = json.loads(body)
        self.assertEqual(result["user"]["id"], user_id)
        self.assertNotIn("token", result)
        cookie = SimpleCookie(headers["Set-Cookie"])["canaveral_session"].value
        status, _, body = self.fetch("/api/v1/auth/session", headers={"Cookie": "canaveral_session=" + cookie})
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["user"]["id"], user_id)
        self.assertNotEqual(self.fetch("/api/v1/auth/claim", {"token": claim, "password": self.password}, headers={"Origin": self.url})[0], 200)

    def test_password_change_revokes_old_credentials_and_preserves_owned_machines(self):
        self.administrator()
        user, session_file, alice = self.activate("alice")
        self.enroll()
        own = alice.request("POST", "/v1/machines", request())
        _, _, readonly = self.mint(session_file)
        current = self.private("current.password", self.password)
        new = self.private("new.password", "another-separate-integration-password")
        output = self.cli(session_file, ["account", "password", "--current-password-file", str(current), "--password-file", str(new)])
        self.assertNotIn(new.read_text(), output)
        self.assertFalse(session_file.exists())
        for client in (alice, readonly):
            with self.assertRaises(Error) as failure:
                client.request("GET", "/v1/machines")
            self.assertEqual(failure.exception.status, 401)
        self.cli(None, ["login", "--username", "alice", "--password-file", str(new), "--output-file", str(session_file)])
        refreshed = Client(self.upstream, session_file.read_text().strip())
        self.assertEqual(refreshed.request("GET", "/v1/auth/session")["user"]["id"], user["id"])
        self.assertEqual(refreshed.request("GET", "/v1/machines")["machines"][0]["id"], own["id"])
        self.cli(session_file, ["logout"])
        self.assertFalse(session_file.exists())

    def test_remote_bootstrap_claim_assigns_existing_unowned_machine(self):
        self.enroll()
        machine = self.operator.request("POST", "/v1/machines", request())
        self.assertIsNone(machine["ownerId"])
        link = Path(self.temp.name) / "bootstrap.link"
        output = self.cli(self.operator_file, ["admin", "setup-link", "--dashboard-url", self.url, "--output-file", str(link)])
        claim = urlsplit(link.read_text().strip()).fragment.removeprefix("claim=")
        self.assertNotIn(claim, output)
        status, _, body = self.fetch("/api/v1/auth/claim", {"token": claim, "username": "admin", "password": self.password}, headers={"Origin": self.url})
        self.assertEqual(status, 200, body)
        admin_id = json.loads(body)["user"]["id"]
        visible = self.operator.request("GET", "/v1/machines")["machines"]
        self.assertEqual(visible[0]["ownerId"], admin_id)
        self.assertFalse(self.operator.request("GET", "/v1/auth/status")["setupRequired"])


if __name__ == "__main__":
    unittest.main()
