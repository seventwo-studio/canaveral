import base64
import copy
import hashlib
import json
import platform
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from canaveral.client import Client
from canaveral.model import Error, digest, template
from canaveral.preparation import notify_python, unix_script, user_data
from canaveral.seed import ensure_seed
from canaveral.store import Store
from canaveral.templates import load_host, prepare_image, recipe
from canaveral.host import Agent
from canaveral.providers.kubevirt import manifest
import test_orchestration as orchestration
from test_orchestration import host_offer, image, request


def configured_template():
    return {**image(), "defaults": {"cpu": 3, "memoryMiB": 3072, "diskGiB": 12},
            "prepare": {"driver": "cloud-init", "commands": ["printf done > /var/lib/task-result"]}}


class TemplateTests(unittest.TestCase):
    def test_recipe_changes_have_a_different_contract_without_exposing_recipe_or_bindings(self):
        value = configured_template()
        value["ssh"] = {"identityFile": "/private/key"}
        public = template(value)
        self.assertNotIn("prepare", public)
        self.assertNotIn("ssh", public)
        self.assertNotIn("/private/key", json.dumps(public))
        self.assertEqual(public["preparationDriver"], "cloud-init")
        changed = copy.deepcopy(value)
        changed["prepare"]["commands"] = ["touch /different"]
        self.assertNotEqual(template(changed)["recipeDigest"], public["recipeDigest"])
        self.assertEqual(template(public), public)

    def test_template_references_cannot_override_the_public_recipe(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "template.json"
            path.write_text(json.dumps(configured_template()))
            config = {**host_offer(), "templates": [{"templateFile": "template.json", "bindings": {"image": "/base.qcow2"}}]}
            loaded = load_host(config, folder)
            self.assertEqual(loaded["templates"][0]["image"], "/base.qcow2")
            config["templates"][0]["bindings"]["prepare"] = {}
            with self.assertRaises(Error):
                load_host(config, folder)

    def test_base_image_preparation_pins_content_and_refuses_corrupt_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "base.raw"
            source.write_bytes(b"base-image")
            spec = {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "format": "raw"}
            target = Path(prepare_image(spec, Path(folder) / "cache"))
            source.write_bytes(b"changed-at-source")
            self.assertEqual(Path(prepare_image(spec, target.parent)).read_bytes(), b"base-image")
            target.write_bytes(b"corrupted-cache")
            with self.assertRaises(Error):
                prepare_image(spec, target.parent)
            self.assertEqual(target.read_bytes(), b"corrupted-cache")

    def test_bad_download_hash_cannot_publish_a_base_image(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "base.raw"
            source.write_bytes(b"unexpected image")
            with self.assertRaises(Error):
                prepare_image({"path": str(source), "sha256": "0" * 64, "format": "raw"}, Path(folder) / "cache")
            self.assertEqual(list((Path(folder) / "cache").iterdir()), [])

    def test_invalid_preparation_is_rejected_before_a_host_can_offer_it(self):
        for change in ({"driver": "cloud-init", "packages": ["-malicious-option"]}, {"driver": "cloud-init", "files": [{"path": "relative", "content": "bad"}]}, {"driver": "cloudbase-init"}):
            with self.assertRaises(Error):
                template({**image(), "prepare": change})
        with self.assertRaises(Error):
            template({**image(), "defaults": {"cpu": 1, "memoryMiB": 512, "diskGiB": 4}})

    def test_source_location_does_not_change_a_checksum_pinned_recipe(self):
        value = configured_template()
        value["source"] = {"path": "/first/base.raw", "format": "raw", "sha256": "a" * 64}
        other = copy.deepcopy(value)
        other["source"]["path"] = "/another-host/base.raw"
        self.assertEqual(template(value)["recipeDigest"], template(other)["recipeDigest"])

    def test_existing_controller_database_keeps_original_request_identity_after_migration(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "old.sqlite3"
            vm, host = request(), str(uuid.uuid4())
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE hosts (id TEXT PRIMARY KEY,credential TEXT NOT NULL,offer TEXT NOT NULL,seen REAL NOT NULL,enabled INTEGER NOT NULL)")
            db.execute("CREATE TABLE machines (id TEXT PRIMARY KEY,request TEXT NOT NULL,host TEXT NOT NULL,template TEXT NOT NULL,desired TEXT NOT NULL,observed TEXT NOT NULL,detail TEXT NOT NULL,updated REAL NOT NULL)")
            db.execute("INSERT INTO hosts VALUES (?,?,?,?,1)", (host, digest(secrets.token_urlsafe(32)), json.dumps(host_offer()), 1000))
            db.execute("INSERT INTO machines VALUES (?,?,?,?,?,?,?,?)", (vm["id"], json.dumps(vm), host, json.dumps(image()), "running", "running", "", 1000))
            db.commit()
            db.close()
            store = Store(path, clock=lambda: 1000)
            self.assertEqual(store.create(vm)["id"], vm["id"])
            self.assertEqual(len(store.machines()), 1)
            self.assertEqual(store.machines()[0]["preparation"]["state"], "notRequired")

    def test_guest_script_runs_once_and_interrupted_commands_are_not_replayed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            vm = request()
            output = root / "output"
            prepared = recipe({"driver": "cloud-init", "files": [{"path": str(root / "file with space"), "content": "literal $(do-not-run)\n"}],
                               "commands": ["printf step >> '" + str(output) + "'"]}, "linux")
            script = unix_script(prepared, vm).replace("/var/lib/canaveral/" + vm["id"], str(root / "state"))
            for _ in range(2):
                subprocess.run(["sh"], input=script.encode(), check=True, capture_output=True)
            self.assertEqual(output.read_text(), "step")
            self.assertEqual((root / "file with space").read_text(), "literal $(do-not-run)\n")
            vm["id"] = str(uuid.uuid4())
            prepared["commands"] = ["exit 7", "touch '" + str(root / "must-not-exist") + "'"]
            script = unix_script(prepared, vm).replace("/var/lib/canaveral/" + vm["id"], str(root / "failed-state"))
            self.assertEqual(subprocess.run(["sh"], input=script.encode(), capture_output=True).returncode, 7)
            self.assertEqual(subprocess.run(["sh"], input=script.encode(), capture_output=True).returncode, 42)
            self.assertFalse((root / "must-not-exist").exists())

    def test_kubevirt_references_preparation_secret_without_embedding_its_credential(self):
        value = configured_template()
        value.update(pvc="base", _userData="private per-machine boot configuration")
        vm = {**request(), "desired": "running"}
        definition = manifest(vm, value, "guests")
        volume = definition["spec"]["template"]["spec"]["volumes"][-1]
        self.assertEqual(volume["cloudInitNoCloud"]["secretRef"]["name"], "cvm-" + vm["id"] + "-preparation")
        self.assertNotIn(value["_userData"], json.dumps(definition))

    def test_cloudbase_script_has_a_completion_guard_and_nocloud_has_per_vm_data(self):
        vm, token = request(), secrets.token_urlsafe(32)
        value = configured_template()
        data = user_data(value, vm, "https://controller.example", token)
        cloud = json.loads(data.split("\n", 1)[1])
        script = base64.b64decode(cloud["write_files"][0]["content"]).decode()
        self.assertIn(vm["id"], script)
        self.assertIn("/prepared", base64.b64decode(script.split("printf '%s' ")[-1].split(" ")[0]).decode())
        value.update(os="windows", prepare={"driver": "cloudbase-init", "commands": ["New-Item -ItemType Directory -Force C:\\Work"]})
        windows = user_data(value, vm, "https://controller.example", token)
        self.assertTrue(windows.startswith("#ps1_sysnative"))
        self.assertIn("Interrupted preparation", windows)
        self.assertIn("MaximumRedirection 0", windows)

    @unittest.skipUnless(platform.system() == "Darwin", "macOS ISO tool integration")
    def test_native_iso_contains_nocloud_files_and_cannot_be_replaced_by_another_recipe(self):
        with tempfile.TemporaryDirectory() as folder:
            value = configured_template()
            vm = request()
            value["_userData"] = "#cloud-config\n{}\n"
            path = ensure_seed(value, vm, folder)
            listing = subprocess.check_output(["bsdtar", "-tf", path]).decode()
            self.assertIn("user-data", listing)
            self.assertIn("meta-data", listing)
            metadata = json.loads(subprocess.check_output(["bsdtar", "-xOf", path, "meta-data"]))
            self.assertEqual(metadata["instance-id"], vm["id"])
            value["_userData"] += "# different recipe\n"
            with self.assertRaises(Error):
                ensure_seed(value, vm, folder)


class TemplateHTTPTests(unittest.TestCase):
    setUp = orchestration.HTTPTests.setUp

    def test_template_defaults_are_pinned_and_ready_requires_a_scoped_guest_receipt(self):
        host, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        offered = {**host_offer(), "templates": [configured_template()]}
        Client(self.url, self.enroll).request("POST", "/v1/hosts/enroll", {"id": host, "credential": token, "offer": offered})
        inventory = self.client.request("GET", "/v1/templates")["templates"]
        self.assertEqual(inventory[0]["defaults"]["cpu"], 3)
        value = request(resources={}, templateRevision="1")
        vm = self.client.request("POST", "/v1/machines", value)
        self.assertEqual(vm["resources"], {"cpu": 3, "memoryMiB": 3072, "diskGiB": 12})
        guest_token = secrets.token_urlsafe(32)
        worker = Client(self.url, token)
        report = {"state": "running", "preparation": {"state": "pending", "tokenHash": digest(guest_token)}}
        worker.request("POST", "/v1/hosts/" + host + "/heartbeat", {"offer": offered, "reports": {vm["id"]: report}})
        self.assertFalse(self.client.request("GET", "/v1/machines")["machines"][0]["ready"])
        with self.assertRaises(Error):
            Client(self.url, secrets.token_urlsafe(32)).request("POST", "/v1/machines/" + vm["id"] + "/prepared", {"state": "ready"})
        subprocess.run([sys.executable, "-c", notify_python(self.url + "/v1/machines/" + vm["id"] + "/prepared", guest_token)], check=True, capture_output=True)
        # A stale pending heartbeat cannot undo the guest's successful preparation.
        worker.request("POST", "/v1/hosts/" + host + "/heartbeat", {"offer": offered, "reports": {vm["id"]: report}})
        machine = self.client.request("GET", "/v1/machines")["machines"][0]
        self.assertTrue(machine["ready"])
        self.assertEqual(machine["preparation"]["state"], "ready")
        self.assertNotIn(guest_token, json.dumps(machine))
        offered["templates"][0]["defaults"]["cpu"] = 4
        with self.assertRaises(Error):
            worker.request("POST", "/v1/hosts/" + host + "/heartbeat", {"offer": offered, "reports": {}})
        offered["templates"][0]["revision"] = "2"
        worker.request("POST", "/v1/hosts/" + host + "/heartbeat", {"offer": offered, "reports": {}})
        self.assertEqual(self.client.request("POST", "/v1/machines", value)["resources"]["cpu"], 3)
        self.assertTrue(Store(Path(self.temp.name) / "db").machines()[0]["ready"])

    def test_a_wrong_template_revision_cannot_be_substituted(self):
        host = str(uuid.uuid4())
        Client(self.url, self.enroll).request("POST", "/v1/hosts/enroll", {"id": host, "credential": secrets.token_urlsafe(32), "offer": host_offer()})
        with self.assertRaises(Error):
            self.client.request("POST", "/v1/machines", request(templateRevision="missing"))

    def test_old_and_new_revisions_coexist_and_ambiguous_requests_are_rejected(self):
        host = str(uuid.uuid4())
        old = image()
        new = {**image(), "revision": "2"}
        offered = {**host_offer(), "templates": [old, new]}
        Client(self.url, self.enroll).request("POST", "/v1/hosts/enroll", {"id": host, "credential": secrets.token_urlsafe(32), "offer": offered})
        with self.assertRaises(Error):
            self.client.request("POST", "/v1/machines", request())
        self.assertEqual(self.client.request("POST", "/v1/machines", request(templateRevision="1"))["template"]["revision"], "1")
        self.assertEqual(self.client.request("POST", "/v1/machines", request(templateRevision="2"))["template"]["revision"], "2")

    def test_ssh_preparation_does_not_report_ready_on_failure_and_runs_once_after_success(self):
        value = configured_template()
        value["prepare"] = {"driver": "ssh", "commands": ["test -d /opt/workspace"]}
        config = {**host_offer(), "templates": [value]}
        with patch("canaveral.host.provider_for") as factory, patch("canaveral.host.prepare_ssh") as prepare:
            factory.return_value.reconcile.return_value = {"state": "running"}
            agent = Agent(config, self.url, Path(self.temp.name) / "ssh-agent")
            agent.connect(self.enroll)
            vm = self.client.request("POST", "/v1/machines", request(resources={}))
            agent.poll()
            assigned = agent.assignments[0]
            prepare.side_effect = RuntimeError("Private guest command failure")
            report = agent.reconcile(assigned)
            self.assertEqual(report["preparation"]["state"], "failed")
            self.assertNotIn("Private guest", report["detail"])
            agent.reports[vm["id"]] = report
            agent.poll()
            self.assertFalse(self.client.request("GET", "/v1/machines")["machines"][0]["ready"])
            prepare.side_effect = None
            agent.reports[vm["id"]] = agent.reconcile(assigned)
            agent.poll()
            self.assertTrue(self.client.request("GET", "/v1/machines")["machines"][0]["ready"])
            agent.reconcile(assigned)
            self.assertEqual(prepare.call_count, 2)
