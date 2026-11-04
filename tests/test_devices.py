import base64
import copy
import http.client
import json
import secrets
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from canaveral.cli import main
from canaveral.client import Client
from canaveral.devices import MAX_RESULT, operation_request
from canaveral.files import save_json
from canaveral.host import Agent
from canaveral.model import Error, digest, offer, template
from canaveral.providers.android import Android
from canaveral.providers.ios import IOS
from canaveral.providers.mobile import Mobile
from canaveral.store import Store
import test_orchestration


def mobile(system="android"):
    device = {"systemImage": "system-images;android-35;google_apis;arm64-v8a", "profile": "pixel_8"} if system == "android" else {
        "runtime": "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
        "deviceType": "com.apple.CoreSimulator.SimDeviceType.iPhone-17"}
    return {"id": system + "-phone", "revision": "1", "os": system, "mode": "device", "arch": "arm64",
            "device": device, "minimum": {"cpu": 2, "memoryMiB": 2048, "diskGiB": 8}}


def config(system="android", **extra):
    return {"name": "mobile-host", "provider": system, "capacity": {"cpu": 4, "memoryMiB": 8192, "diskGiB": 64},
            "templates": [mobile(system)], **extra}


def create(store, system="android"):
    return store.create({"id": str(uuid.uuid4()), "name": "phone", "templateId": system + "-phone"})


def operation(action="screenshot", **args):
    return {"id": str(uuid.uuid4()), "action": action, "arguments": args}


class DeviceStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "db"
        self.store = Store(self.path)
        self.host, self.token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        self.offer = config()
        self.store.enroll({"id": self.host, "credential": self.token, "offer": self.offer})
        self.machine = create(self.store)
        self.heartbeat(reports={self.machine["id"]: {"state": "running"}})

    def heartbeat(self, **kwargs):
        return self.store.heartbeat(self.host, self.token, {"offer": self.offer, **kwargs})

    def test_mobile_contract_roundtrip_and_immutable_runtime(self):
        for system in ("android", "ios"):
            public = template(mobile(system))
            self.assertEqual(template(public), public)
            self.assertEqual(offer(config(system))["templates"][0], public)
        invalid = mobile()
        invalid["arch"] = "amd64"
        with self.assertRaises(Error):
            template(invalid)
        with self.assertRaises(Error):
            offer({**config(), "provider": "apple"})
        with self.assertRaises(Error):
            template({**mobile(), "prepare": {"driver": "ssh"}})
        changed = copy.deepcopy(self.offer)
        changed["templates"][0]["device"]["profile"] = "pixel_9"
        with self.assertRaises(Error):
            self.store.heartbeat(self.host, self.token, {"offer": changed})

    def test_fifo_idempotency_restart_and_first_receipt_wins(self):
        first, second = operation("tap", x=10, y=20), operation()
        for request in (first, second):
            self.store.create_device_operation(self.machine["id"], request)
        self.store = Store(self.path)
        self.assertEqual(self.heartbeat()["deviceOperations"][0]["id"], first["id"])
        self.assertEqual(self.store.create_device_operation(self.machine["id"], first)["state"], "queued")
        with self.assertRaises(Error):
            self.store.create_device_operation(self.machine["id"], {**first, "arguments": {"x": 30, "y": 20}})
        report = {"state": "unknown", "result": {"detail": "Interrupted tap"}}
        self.assertEqual(self.heartbeat(deviceReports={first["id"]: report})["deviceOperations"][0]["id"], second["id"])
        self.heartbeat(deviceReports={first["id"]: {"state": "succeeded"}})
        self.assertEqual(self.store.device_operation(first["id"])["state"], "unknown")

    def test_other_hosts_cannot_report_and_invalid_report_rolls_back_inventory(self):
        request = operation()
        self.store.create_device_operation(self.machine["id"], request)
        other, credential = str(uuid.uuid4()), secrets.token_urlsafe(32)
        self.store.enroll({"id": other, "credential": credential, "offer": self.offer})
        with self.assertRaises(Error):
            self.store.heartbeat(other, credential, {"offer": self.offer, "deviceReports": {request["id"]: {"state": "succeeded"}}})
        with self.assertRaises(Error):
            self.heartbeat(reports={self.machine["id"]: {"state": "stopped"}}, deviceReports={request["id"]: {"state": "bogus"}})
        self.assertEqual(self.store.machines()[0]["observed"], "running")

    def test_offline_stopped_nonmobile_and_full_queue_reject_new_actions(self):
        self.store.desired(self.machine["id"], "stopped")
        with self.assertRaises(Error):
            self.store.create_device_operation(self.machine["id"], operation())
        self.store.desired(self.machine["id"], "running")
        self.store.clock = lambda: time.time() + 31
        with self.assertRaises(Error):
            self.store.create_device_operation(self.machine["id"], operation())
        self.store.clock = time.time
        for _ in range(32):
            self.store.create_device_operation(self.machine["id"], operation())
        with self.assertRaises(Error) as caught:
            self.store.create_device_operation(self.machine["id"], operation())
        self.assertEqual(caught.exception.status, 429)

    def test_invalid_actions_do_not_queue(self):
        for request in (operation("tap", x=True, y=1), operation("tap", x=1, y=2, serial="another"),
                        operation("location", latitude=float("nan"), longitude=0), operation("push", path="/tmp/a", data="???"),
                        operation("install", artifact="--help"), operation("shell", argv=["echo", "a\x00b"])):
            with self.assertRaises(Error):
                self.store.create_device_operation(self.machine["id"], request)


class ReceiptTests(unittest.TestCase):
    def test_escaped_text_cannot_block_the_heartbeat_result_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = Mobile({}, directory)
            provider.control = Mock(return_value={"output": "\n" * (4 * 1048576)})
            machine = {"id": str(uuid.uuid4()), "desired": "running"}
            request = {**operation("logs"), "expiresAt": time.time() + 120}
            report = provider.operate(machine, {}, Path(directory), request)
            self.assertEqual(report["state"], "unknown")
            self.assertLess(len(json.dumps(report["result"]).encode()), MAX_RESULT)
            self.assertEqual(provider.operate(machine, {}, Path(directory), request), report)
            provider.control.assert_called_once()

    def test_success_timeout_crash_expiry_and_stopped_never_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = Mobile({}, directory)
            machine = {"id": str(uuid.uuid4()), "desired": "running"}
            folder = Path(directory)
            request = {**operation("tap", x=1, y=2), "expiresAt": time.time() + 120}
            provider.control = Mock(return_value={"output": "tapped"})
            first = provider.operate(machine, {}, folder, request)
            self.assertEqual(first["state"], "succeeded")
            self.assertEqual(provider.operate(machine, {}, folder, request), first)
            self.assertEqual(provider.control.call_count, 1)
            interrupted = {**operation(), "expiresAt": time.time() + 120}
            fingerprint = digest({"machine": machine["id"], **operation_request({k: interrupted[k] for k in ("id", "action", "arguments")})})
            save_json(folder / "operations" / (interrupted["id"] + ".json"), {"fingerprint": fingerprint, "started": True})
            self.assertEqual(provider.operate(machine, {}, folder, interrupted)["state"], "unknown")
            expired = {**operation(), "expiresAt": time.time() - 1}
            self.assertEqual(provider.operate(machine, {}, folder, expired)["state"], "failed")
            stopped = {**machine, "desired": "stopped"}
            self.assertEqual(provider.operate(stopped, {}, folder, {**operation(), "expiresAt": time.time() + 120})["state"], "failed")
            provider.control.side_effect = Error("timeout")
            timed_out = {**operation(), "expiresAt": time.time() + 120}
            self.assertEqual(provider.operate(machine, {}, folder, timed_out)["state"], "unknown")
            self.assertEqual(provider.operate(machine, {}, folder, timed_out)["state"], "unknown")
            self.assertEqual(provider.control.call_count, 2)


class AndroidTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.provider = Android(config(storage=str(self.root / "storage"), androidSDK="/sdk"), self.root)
        self.machine = {"id": str(uuid.uuid4()), "template": template(mobile()), "resources": mobile()["minimum"], "desired": "running"}
        self.storage = self.provider.storage(self.machine)

    def test_provision_isolated_avd_once_and_applies_disk_reservation(self):
        def make_avd(argv, **kwargs):
            path = Path(argv[argv.index("--path") + 1])
            path.mkdir()
            (path / "config.ini").write_text("hw.device.name=pixel\n")
            self.assertNotIn("--force", argv)
        with patch.object(self.provider, "run", side_effect=make_avd) as run:
            avd = self.provider.provision(self.machine, mobile(), self.storage)
            self.provider.provision(self.machine, mobile(), self.storage)
        self.assertEqual(run.call_count, 1)
        self.assertIn("disk.dataPartition.size=8G", (avd / "config.ini").read_text())
        self.assertTrue(self.provider.environment()["ANDROID_AVD_HOME"].startswith(str(self.root)))

    def test_foreign_or_offline_serial_is_never_controlled(self):
        save_json(self.storage / "endpoint.json", {"port": 5554})
        with patch.object(self.provider, "devices", return_value={"emulator-5554": "device"}), patch.object(self.provider, "adb", return_value="someone-elses-avd\nOK") as adb:
            with self.assertRaises(Error):
                self.provider.reconcile(self.machine, mobile(), self.root)
            self.assertEqual(adb.call_count, 1)
        with patch.object(self.provider, "devices", return_value={"emulator-5554": "offline"}), patch.object(self.provider, "adb") as adb:
            with self.assertRaises(Error):
                self.provider.reconcile(self.machine, mobile(), self.root)
            adb.assert_not_called()

    def test_uncertain_launch_is_not_repeated_and_confirmed_stop_preserves_data(self):
        save_json(self.storage / "launch.json", {"pid": 1})
        with patch.object(self.provider, "devices", return_value={}), patch("canaveral.providers.android.subprocess.Popen") as start, \
                patch.object(self.provider, "process_stopped", return_value=True):
            self.assertEqual(self.provider.reconcile(self.machine, mobile(), self.root)["state"], "unknown")
            start.assert_not_called()
            save_json(self.storage / "stop.json", {"requested": True, "acknowledged": True})
            marker = self.storage / "keep-app-data"
            marker.write_text("preserved")
            stopped = self.provider.reconcile({**self.machine, "desired": "stopped"}, mobile(), self.root)
            self.assertEqual(stopped["state"], "stopped")
            self.assertTrue(marker.exists())

    def test_failed_shutdown_and_adb_outage_keep_compute_reserved(self):
        save_json(self.storage / "launch.json", {"pid": 1234})
        save_json(self.storage / "endpoint.json", {"port": 5554})
        stopped = {**self.machine, "desired": "stopped"}
        with patch.object(self.provider, "endpoint", return_value="emulator-5554"), \
                patch.object(self.provider, "adb", side_effect=Error("lost connection")):
            with self.assertRaises(Error):
                self.provider.reconcile(stopped, mobile(), self.root)
        with patch.object(self.provider, "endpoint", return_value=None), \
                patch.object(self.provider, "process_stopped", return_value=True):
            self.assertEqual(self.provider.reconcile(stopped, mobile(), self.root)["state"], "unknown")
            self.assertTrue((self.storage / "launch.json").exists())
            self.assertTrue((self.storage / "endpoint.json").exists())

    def test_acknowledged_shutdown_waits_for_process_exit_and_reaps_child(self):
        save_json(self.storage / "launch.json", {"pid": 1234})
        save_json(self.storage / "endpoint.json", {"port": 5554})
        stopped = {**self.machine, "desired": "stopped"}
        process = Mock()
        process.poll.return_value = None
        self.provider.processes[self.machine["id"]] = process
        with patch.object(self.provider, "endpoint", return_value="emulator-5554"), patch.object(self.provider, "adb") as adb:
            self.assertEqual(self.provider.reconcile(stopped, mobile(), self.root)["state"], "stopping")
            adb.assert_called_once_with("emulator-5554", "emu", "kill")
        with patch.object(self.provider, "endpoint", return_value=None):
            self.assertEqual(self.provider.reconcile(stopped, mobile(), self.root)["state"], "stopping")
            self.assertTrue((self.storage / "launch.json").exists())
            process.poll.return_value = 0
            self.assertEqual(self.provider.reconcile(stopped, mobile(), self.root)["state"], "stopped")
            self.assertFalse((self.storage / "launch.json").exists())
            self.assertNotIn(self.machine["id"], self.provider.processes)

    def test_reconnected_host_only_probes_saved_pid_without_signalling_it(self):
        save_json(self.storage / "launch.json", {"pid": 1234})
        with patch("canaveral.providers.android.os.kill", side_effect=ProcessLookupError) as probe:
            self.assertTrue(self.provider.process_stopped(self.machine, self.storage))
            probe.assert_called_once_with(1234, 0)
        with patch("canaveral.providers.android.os.kill", side_effect=PermissionError):
            self.assertFalse(self.provider.process_stopped(self.machine, self.storage))

    def test_launch_reserves_serial_and_cpu_memory_without_relaunching(self):
        with patch.object(self.provider, "devices", return_value={}), patch.object(self.provider, "provision"), \
                patch("canaveral.providers.android.socket.socket") as socket, \
                patch("canaveral.providers.android.subprocess.Popen") as start:
            start.return_value.pid = 1234
            self.assertEqual(self.provider.reconcile(self.machine, mobile(), self.root)["state"], "starting")
            argv = start.call_args.args[0]
            self.assertEqual(argv[argv.index("-cores") + 1], "2")
            self.assertEqual(argv[argv.index("-memory") + 1], "2048")
            self.assertEqual(argv[argv.index("-avd") + 1], self.provider.name(self.machine))
            self.assertEqual(json.loads((self.storage / "endpoint.json").read_text())["port"], 5554)
            self.assertEqual(self.provider.reconcile(self.machine, mobile(), self.root)["state"], "starting")
            self.assertEqual(start.call_count, 1)

    def test_ui_is_scoped_and_shell_arguments_stay_literal(self):
        with patch.object(self.provider, "endpoint", return_value="emulator-5554"), patch.object(self.provider, "adb", side_effect=["1", "ok"]) as adb:
            self.provider.control(self.machine, mobile(), self.root, operation("text", text="hi; $(touch /tmp/no)"))
            args = adb.call_args.args
            self.assertEqual(args[0], "emulator-5554")
            self.assertEqual(args[1], "shell")
            self.assertIn("'hi;%s$(touch%s/tmp/no)'", args[2])
        with patch.object(self.provider, "endpoint", return_value="emulator-5554"), patch.object(self.provider, "adb", side_effect=["1", b"\x89PNG\r\n"]) as adb:
            result = self.provider.control(self.machine, mobile(), self.root, operation())
            self.assertEqual(base64.b64decode(result["data"]), b"\x89PNG\r\n")


class IOSTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.provider = IOS(config("ios", storage=str(self.root / "storage")), self.root)
        self.machine = {"id": str(uuid.uuid4()), "template": template(mobile("ios")), "resources": mobile("ios")["minimum"], "desired": "running"}
        self.storage = self.provider.storage(self.machine)
        self.udid = str(uuid.uuid4())
        self.device = {"udid": self.udid, "name": self.provider.name(self.machine), "state": "Booted", "isAvailable": True,
                       "deviceTypeIdentifier": mobile("ios")["device"]["deviceType"]}

    def test_create_boot_reconcile_and_stop_use_same_owned_udid(self):
        device = {**self.device, "state": "Shutdown"}
        with patch.object(self.provider, "inventory", side_effect=[[], [(mobile("ios")["device"]["runtime"], device)]]), patch.object(self.provider, "simctl", side_effect=[self.udid, "", ""]) as command:
            self.assertEqual(self.provider.reconcile(self.machine, mobile("ios"), self.root)["state"], "running")
            self.assertEqual(command.call_args_list[1].args, ("boot", self.udid))
        with patch.object(self.provider, "inventory", return_value=[(mobile("ios")["device"]["runtime"], self.device)]), patch.object(self.provider, "simctl", return_value="") as command:
            self.assertEqual(self.provider.reconcile({**self.machine, "desired": "stopped"}, mobile("ios"), self.root)["state"], "stopping")
            command.assert_called_once_with("shutdown", self.udid)
        self.assertEqual(json.loads((self.storage / "simulator.json").read_text())["udid"], self.udid)

    def test_foreign_name_partial_creation_and_replaced_udid_refuse_adoption(self):
        with patch.object(self.provider, "inventory", return_value=[("runtime", self.device)]), patch.object(self.provider, "simctl") as command:
            with self.assertRaises(Error):
                self.provider.reconcile(self.machine, mobile("ios"), self.root)
            command.assert_not_called()
        save_json(self.storage / "create-started.json", {})
        with patch.object(self.provider, "inventory", return_value=[]), patch.object(self.provider, "simctl") as command:
            with self.assertRaises(Error):
                self.provider.reconcile(self.machine, mobile("ios"), self.root)
            command.assert_not_called()
        save_json(self.storage / "simulator.json", {"udid": self.udid})
        with patch.object(self.provider, "inventory", return_value=[("wrong-runtime", self.device)]):
            with self.assertRaises(Error):
                self.provider.owned(self.machine, mobile("ios"), self.storage)

    def test_idb_ui_target_and_app_container_file_boundaries(self):
        with patch.object(self.provider, "owned", return_value=self.device), patch.object(self.provider, "run", return_value="ok") as run:
            self.provider.control(self.machine, mobile("ios"), self.root, operation("swipe", x=1, y=2, toX=3, toY=4, durationMs=250))
            argv = run.call_args.args[0]
            self.assertEqual(argv[-2:], ["--udid", self.udid])
            self.assertIn("0.25", argv)
        container = self.root / "container"
        container.mkdir()
        (container / "outside").symlink_to(self.root, target_is_directory=True)
        with patch.object(self.provider, "simctl", return_value=str(container)):
            for path in ("../../secret", "/etc/passwd", "outside/secret"):
                with self.assertRaises(Error):
                    self.provider.app_file(self.udid, {"app": "com.example.app", "path": path})
            self.assertEqual(self.provider.app_file(self.udid, {"app": "com.example.app", "path": "a.txt"}), container / "a.txt")


class DeviceHTTPTests(unittest.TestCase):
    setUp = test_orchestration.HTTPTests.setUp

    def test_oversized_heartbeat_envelope_authenticates_before_reading_body(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.service.server_port, timeout=2)
        self.addCleanup(connection.close)
        connection.putrequest("POST", "/v1/hosts/" + str(uuid.uuid4()) + "/heartbeat")
        connection.putheader("Authorization", "Bearer " + secrets.token_urlsafe(32))
        connection.putheader("Content-Length", str(8 * 1048576))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 401)
        response.read()

    def test_real_outbound_delivery_large_screenshot_receipt_auth_and_cli_export(self):
        offered = config()
        agent = Agent({**offered, "storage": str(Path(self.temp.name) / "devices"), "androidSDK": "/sdk"}, self.url, Path(self.temp.name) / "agent")
        agent.connect(self.enroll)
        machine = self.client.request("POST", "/v1/machines", {"id": str(uuid.uuid4()), "name": "agent-phone", "templateId": "android-phone", "hostId": agent.identity["id"]})
        agent.reports[machine["id"]] = {"state": "running"}
        agent.poll()
        request = operation()
        self.client.request("POST", "/v1/machines/" + machine["id"] + "/operations", request)
        for token in (agent.identity["credential"], self.enroll, secrets.token_urlsafe(32)):
            with self.assertRaises(Error) as caught:
                Client(self.url, token).request("GET", "/v1/operations/" + request["id"])
            self.assertEqual(caught.exception.status, 401)
        agent.poll()
        png = b"\x89PNG\r\n" + b"x" * 1100000
        report = {"state": "succeeded", "result": {"mediaType": "image/png", "data": base64.b64encode(png).decode()}}
        with patch.object(agent.provider, "operate", return_value=report) as operate:
            agent.device_work()
            agent.device_work()
            self.assertEqual(operate.call_count, 1)
            agent.poll()
            self.assertEqual(agent.device_reports, {})
        self.assertEqual(self.client.request("GET", "/v1/operations/" + request["id"])["state"], "succeeded")
        token_file = Path(self.temp.name) / "admin.token"
        token_file.write_text(self.admin)
        output = Path(self.temp.name) / "screen.png"
        with patch("builtins.print"):
            main(["--url", self.url, "--token-file", str(token_file), "operation", request["id"], "--output", str(output)])
        self.assertEqual(output.read_bytes(), png)


if __name__ == "__main__":
    unittest.main()
