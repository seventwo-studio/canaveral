import contextlib
import io
import os
import secrets
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from canaveral.cli import main, parser
from canaveral.client import Client
from canaveral.model import Error


class AccountCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.credential = self.root / "session"
        self.credential.write_text(secrets.token_urlsafe(32))
        self.credential.chmod(0o600)
        self.password = self.root / "password"
        self.password.write_text("separate-fixture-password\n")
        self.password.chmod(0o600)
        self.calls = []
        self.reply = lambda method, path, value: {}
        parent = self

        class FakeClient:
            def __init__(self, url, token, allow_http=False):
                self.url = Client(url, token, allow_http).url
                self.token = token

            def request(self, method, path, value=None):
                parent.calls.append((method, path, value))
                return parent.reply(method, path, value)

        self.addCleanup(patch.stopall)
        patch("canaveral.account_cli.Client", FakeClient).start()

    def invoke(self, args, success=True, credential=True):
        output, errors = io.StringIO(), io.StringIO()
        argv = ["--url", "http://127.0.0.1:8765"]
        if credential:
            argv += ["--token-file", str(self.credential)]
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            if success:
                main(argv + args)
            else:
                with self.assertRaises(SystemExit) as failure:
                    main(argv + args)
                self.assertEqual(failure.exception.code, 1)
        return output.getvalue(), errors.getvalue()

    def token_args(self, destination, request_id=None):
        return ["tokens", "create", "--name", "automation", "--scope", "machines:read",
                "--request-id", request_id or str(uuid.uuid4()), "--output-file", str(destination)]

    def test_collection_commands_default_to_listing(self):
        self.assertEqual(parser().parse_args(["users"]).user_action, "list")
        self.assertEqual(parser().parse_args(["tokens"]).token_action, "list")
        self.invoke(["users"])
        self.invoke(["tokens"])
        self.assertEqual(self.calls, [("GET", "/v1/users", None), ("GET", "/v1/auth/tokens", None)])

    def test_login_saves_secret_privately_without_stdout_disclosure(self):
        token = secrets.token_urlsafe(32)
        self.reply = lambda *args: {"token": token, "user": {"username": "alice"}, "expiresAt": 1000}
        destination = self.root / "alice.session"
        output, errors = self.invoke(["login", "--username", "alice", "--password-file", str(self.password),
                                      "--output-file", str(destination)], credential=False)
        self.assertEqual(destination.read_text(), token + "\n")
        if os.name != "nt":
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(token, output + errors)
        self.assertNotIn(self.password.read_text().strip(), output + errors)
        self.assertEqual(self.calls[0][0:2], ("POST", "/v1/auth/login"))
        self.assertIn("credentialFile", output)

    def test_existing_output_or_symlink_is_rejected_before_authentication(self):
        for destination in (self.credential, self.root / "symlink"):
            if destination != self.credential:
                destination.symlink_to(self.credential)
            before = self.credential.read_text()
            self.invoke(["login", "--username", "alice", "--password-file", str(self.password),
                         "--output-file", str(destination)], success=False, credential=False)
            self.assertEqual(self.credential.read_text(), before)
        self.assertEqual(self.calls, [])

    def test_failed_session_file_write_revokes_issued_session(self):
        token = secrets.token_urlsafe(32)
        self.reply = lambda *args: {"token": token, "user": {"username": "alice"}}
        destination = self.root / "unwritten.session"
        with patch("canaveral.account_cli.os.fsync", side_effect=OSError("disk full")):
            output, errors = self.invoke(["login", "--username", "alice", "--password-file", str(self.password),
                                          "--output-file", str(destination)], success=False, credential=False)
        self.assertFalse(destination.exists())
        self.assertEqual([c[1] for c in self.calls], ["/v1/auth/login", "/v1/auth/logout"])
        self.assertNotIn(token, output + errors)

    def test_token_creation_saves_one_time_secret_and_deduplicates_scopes(self):
        token = secrets.token_urlsafe(32)
        destination = self.root / "automation.token"
        request_id = str(uuid.uuid4())
        self.reply = lambda *args: {"id": request_id, "name": "automation", "token": token}
        args = self.token_args(destination, request_id) + ["--scope", "machines:read", "--scope", "machines:access"]
        output, errors = self.invoke(args)
        self.assertEqual(destination.read_text(), token + "\n")
        self.assertNotIn(token, output + errors)
        self.assertEqual(self.calls[0][2]["scopes"], ["machines:access", "machines:read"])
        self.assertEqual(self.calls[0][2]["expiresInSeconds"], 30 * 24 * 60 * 60)

    def test_replayed_token_mint_never_silently_issues_a_replacement(self):
        destination = self.root / "lost.token"
        request_id = str(uuid.uuid4())
        self.reply = lambda *args: {"id": request_id, "name": "automation"}
        output, errors = self.invoke(self.token_args(destination, request_id), success=False)
        self.assertFalse(destination.exists())
        self.assertIn("already issued", errors)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(output, "")

    def test_token_save_failure_revokes_the_specific_issued_token(self):
        destination = self.root / "unsaved.token"
        request_id = str(uuid.uuid4())
        token = secrets.token_urlsafe(32)
        self.reply = lambda *args: {"id": request_id, "token": token}
        with patch("canaveral.account_cli.os.fsync", side_effect=OSError("disk full")):
            output, errors = self.invoke(self.token_args(destination, request_id), success=False)
        self.assertFalse(destination.exists())
        self.assertEqual(self.calls[-1], ("POST", "/v1/auth/tokens/" + request_id + "/revoke", {}))
        self.assertNotIn(token, output + errors)

    def test_token_expiry_is_validated_before_minting(self):
        self.invoke(self.token_args(self.root / "invalid.token") + ["--expires-in", "0"], success=False)
        self.assertEqual(self.calls, [])

    def test_logout_rejects_non_session_credentials_without_removing_file(self):
        def rejected(method, path, value):
            raise Error("Session credential rejected.", 401)
        self.reply = rejected
        self.invoke(["logout"], success=False)
        self.assertTrue(self.credential.exists())
        self.assertEqual(len(self.calls), 1)

    def test_logout_revokes_server_session_before_removing_file(self):
        self.reply = lambda *args: {"ok": True}
        self.invoke(["logout"])
        self.assertFalse(self.credential.exists())
        self.assertEqual([c[1] for c in self.calls], ["/v1/auth/session", "/v1/auth/logout"])

    def test_password_change_uses_private_inputs_and_removes_revoked_session_file(self):
        new_password = self.root / "new-password"
        new_password.write_text("new-separate-fixture-password")
        new_password.chmod(0o600)
        self.reply = lambda *args: {"ok": True}
        output, errors = self.invoke(["account", "password", "--current-password-file", str(self.password),
                                      "--password-file", str(new_password)])
        self.assertFalse(self.credential.exists())
        self.assertNotIn(new_password.read_text(), output + errors)
        self.assertNotIn(self.password.read_text().strip(), output + errors)
        self.assertEqual(self.calls[0][1], "/v1/auth/password")

    @unittest.skipIf(os.name == "nt", "POSIX permission fixture")
    def test_password_file_requires_private_permissions(self):
        self.password.chmod(0o644)
        self.invoke(["login", "--username", "alice", "--password-file", str(self.password),
                     "--output-file", str(self.root / "session2")], success=False, credential=False)
        self.assertEqual(self.calls, [])

    def test_setup_link_secret_goes_only_to_private_fragment_link_file(self):
        token = secrets.token_urlsafe(32)
        self.reply = lambda *args: {"kind": "bootstrap", "token": token, "expiresAt": 1000}
        destination = self.root / "first-admin.link"
        output, errors = self.invoke(["admin", "setup-link", "--dashboard-url", "https://canaveral.example",
                                      "--output-file", str(destination)])
        self.assertEqual(destination.read_text(), "https://canaveral.example/#claim=" + token + "\n")
        self.assertNotIn(token, output + errors)
        self.assertEqual(self.calls, [("POST", "/v1/auth/bootstrap", {})])

    def test_link_refuses_insecure_remote_origin_before_issuing_claim(self):
        destination = self.root / "unsafe.link"
        self.invoke(["admin", "setup-link", "--dashboard-url", "http://canaveral.example",
                     "--output-file", str(destination)], success=False)
        self.assertFalse(destination.exists())
        self.assertEqual(self.calls, [])

    def test_operator_recovery_targets_user_without_resetting_identity(self):
        user_id = str(uuid.uuid4())
        self.reply = lambda *args: {"kind": "reset", "token": secrets.token_urlsafe(32)}
        self.invoke(["admin", "recover", "--user-id", user_id, "--dashboard-url", "https://canaveral.example",
                     "--output-file", str(self.root / "recovery.link")])
        self.assertEqual(self.calls[0][1], "/v1/users/" + user_id + "/reset-password")

    def test_empty_user_update_has_no_side_effect(self):
        self.invoke(["users", "update", str(uuid.uuid4())], success=False)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
