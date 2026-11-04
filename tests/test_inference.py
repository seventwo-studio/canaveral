import concurrent.futures
import copy
import json
import os
import secrets
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from canaveral.api import server
from canaveral.client import Client
from canaveral.files import save_json
from canaveral.host import Agent
from canaveral.inference import job_request
from canaveral.inference_resources import GiB, MiB, ResourceGuard, memory_sample
from canaveral.inference_runner import InferenceRunner
from canaveral.model import Error, digest, offer
from canaveral.store import Store
from test_orchestration import host_offer, request


def model():
    return {"id": "fixture:latest", "digest": "sha256:" + "a" * 64, "capability": "generation",
            "resources": {"cpu": 2, "memoryMiB": 2048, "diskGiB": 1}}


def inference():
    return {"runtime": "ollama", "models": [model()]}


def job_request_value(**changes):
    return {"id": str(uuid.uuid4()), "model": "fixture:latest", "prompt": "Say hello", **changes}


def job_assignment():
    return {"id": str(uuid.uuid4()), "request": job_request(job_request_value()), "definition": model(), "desired": "running"}


def result():
    return {"model": "fixture:latest", "text": "Hello", "usage": {"inputTokens": 1, "outputTokens": 1}}


class InferenceStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "db"
        self.now = 1000
        self.store = Store(self.path, clock=lambda: self.now)
        self.host, self.token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        self.offer = {**host_offer(), "inference": inference()}
        self.store.enroll({"id": self.host, "credential": self.token, "offer": self.offer})

    def report(self, inference_reports, **extra):
        return self.store.heartbeat(self.host, self.token, {"offer": self.offer, "inferenceReports": inference_reports, **extra})

    def test_vm_and_inference_admission_share_one_atomic_budget(self):
        def create(index):
            try:
                return self.store.create(request()) if index % 2 else self.store.create_job(job_request_value())
            except Error:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            admitted = [item for item in pool.map(create, range(12)) if item]
        self.assertEqual(len(admitted), 2)
        self.assertEqual(self.store.hosts()[0]["reserved"]["memoryMiB"], 4096)
        self.store = Store(self.path, clock=lambda: self.now)
        with self.assertRaises(Error):
            self.store.create_job(job_request_value())

    def test_cancellation_and_stale_hosts_keep_capacity_until_positive_confirmation(self):
        first = self.store.create_job(job_request_value())
        self.store.create(request())
        self.store.cancel_job(first["id"])
        with self.assertRaises(Error):
            self.store.create_job(job_request_value())
        self.now += 31
        self.assertEqual(self.store.jobs(first["id"])["state"], "unknown")
        self.assertEqual(self.store.hosts()[0]["reserved"]["memoryMiB"], 4096)
        self.report({first["id"]: {"state": "cancelled"}})
        self.assertEqual(self.store.hosts()[0]["reserved"]["memoryMiB"], 2048)
        self.assertTrue(self.store.create_job(job_request_value()))

    def test_retries_are_idempotent_and_model_revision_ambiguity_requires_a_pin(self):
        value = job_request_value()
        first = self.store.create_job(value)
        self.assertEqual(self.store.create_job(value), first)
        with self.assertRaises(Error):
            self.store.create_job({**value, "prompt": "Different"})
        second = copy.deepcopy(self.offer)
        second["inference"]["models"][0]["digest"] = "sha256:" + "b" * 64
        self.store.enroll({"id": str(uuid.uuid4()), "credential": secrets.token_urlsafe(32), "offer": second})
        with self.assertRaises(Error):
            self.store.create_job(job_request_value())
        pinned = self.store.create_job(job_request_value(digest=model()["digest"]))
        self.assertEqual(pinned["hostId"], self.host)

    def test_reports_enforce_ownership_and_rollback_vm_updates(self):
        job = self.store.create_job(job_request_value())
        vm = self.store.create(request())
        with self.assertRaises(Error):
            self.report({job["id"]: {"state": "succeeded", "result": {}}}, reports={vm["id"]: {"state": "running"}})
        self.assertEqual(self.store.machines()[0]["observed"], "pending")
        other, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        self.store.enroll({"id": other, "credential": token, "offer": self.offer})
        with self.assertRaises(Error):
            self.store.heartbeat(other, token, {"offer": self.offer, "inferenceReports": {job["id"]: {"state": "failed"}}})
        self.report({job["id"]: {"state": "succeeded", "result": result()}})
        self.report({job["id"]: {"state": "succeeded", "result": result()}})
        with self.assertRaises(Error):
            self.report({job["id"]: {"state": "cancelled"}})
        self.assertEqual(self.store.jobs(job["id"])["result"], result())
        self.assertNotIn("result", self.store.jobs()[0])
        self.assertNotIn("prompt", json.dumps(self.store.jobs()))

    def test_draining_and_offline_hosts_do_not_get_new_jobs(self):
        self.store.enable(self.host, False)
        with self.assertRaises(Error):
            self.store.create_job(job_request_value())
        self.store.enable(self.host, True)
        self.now += 31
        with self.assertRaises(Error):
            self.store.create_job(job_request_value())

    def test_public_offers_exclude_local_paths_and_validate_models(self):
        native = {**self.offer, "provider": "native", "templates": []}
        native["inference"] = {**inference(), "executable": "/private/ollama", "modelsDirectory": "/private/models"}
        public = offer(native)
        self.assertNotIn("executable", json.dumps(public))
        self.assertEqual(public["inference"], inference())
        for mutate in (lambda v: v.update(templates=host_offer()["templates"]),
                       lambda v: v["inference"]["models"][0].update(digest="unknown"),
                       lambda v: v["inference"]["models"][0].update(id="cloud-model"),
                       lambda v: v["inference"]["models"][0].update(capability="decision")):
            invalid = copy.deepcopy(native)
            mutate(invalid)
            with self.assertRaises(Error):
                offer(invalid)
        for invalid in (job_request_value(maxTokens=True), job_request_value(prompt="\x00" * 65536), job_request_value(other="field")):
            with self.assertRaises(Error):
                job_request(invalid)


class ResourceTests(unittest.TestCase):
    @patch("canaveral.inference_resources.platform.system", return_value="Darwin")
    @patch("canaveral.inference_resources.command")
    def test_mac_cache_accounting_excludes_speculative_overlap_and_compressed_memory(self, command, system):
        command.side_effect = ["""Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages wired down: 200.
Pages occupied by compressor: 50.
File-backed pages: 300.
Pages speculative: 20.
Pages purgeable: 40.
Swapouts: 10.
""", str(1000 * 16384), "1"]
        physical, available, normal, written = memory_sample()
        self.assertEqual(physical, 1000 * 16384)
        self.assertEqual(available, (100 + 300 - 20 + 40) * 16384)
        self.assertTrue(normal)
        self.assertEqual(written, 10 * 16384)

    @patch("canaveral.inference_resources.shutil.disk_usage")
    def test_reclaimable_ram_swap_traffic_and_loaded_weights_are_accounted_once(self, disk):
        disk.return_value.free = 8 * GiB
        now = [0]
        snapshot = [36 * GiB, 10 * GiB, True, 100 * MiB]
        guard = ResourceGuard(".", sample=lambda: tuple(snapshot), clock=lambda: now[0])
        self.assertIn("baseline", guard.restriction(8192))
        now[0] = 1
        self.assertIsNone(guard.restriction(4096))
        self.assertIn("RAM", guard.restriction(8192))
        self.assertIsNone(guard.restriction(8192, running=True))
        snapshot[3] += 32 * MiB
        self.assertIn("swap", guard.restriction(1))
        now[0] += 32
        self.assertIsNone(guard.restriction(1))
        disk.return_value.free = GiB
        self.assertIn("disk", guard.restriction(1))

    def test_missing_telemetry_does_not_admit_work(self):
        guard = ResourceGuard(".", sample=Mock(side_effect=OSError))
        self.assertIn("unavailable", guard.restriction(1))


@unittest.skipIf(os.name == "nt", "Owned local inference currently requires a POSIX host")
class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        executable = self.root / "ollama-fixture"
        source = (Path(__file__).parent / "fixtures/ollama_runtime.py").read_text()
        executable.write_text("#!" + sys.executable + "\n" + source.split("\n", 1)[1])
        executable.chmod(0o700)
        self.config = {**inference(), "executable": str(executable), "modelsDirectory": str(self.root)}
        self.runner = InferenceRunner(self.config, self.root / "state", inference()["models"])
        self.runner.guard = Mock()
        self.runner.guard.restriction.return_value = None
        self.job = job_assignment()

    def requests(self):
        return [json.loads(line) for line in (self.root / "requests.jsonl").read_text().splitlines()]

    def test_owned_runtime_serves_a_pinned_model_and_restart_returns_receipt_without_replay(self):
        with patch.dict(os.environ, {"EXAMPLE_PROVIDER_SECRET": "never-inherit", "HTTP_PROXY": "http://invalid"}):
            report = self.runner.reconcile(self.job, lambda: False)
        self.assertEqual(report["state"], "succeeded", report)
        self.assertEqual(report["result"]["usage"]["outputTokens"], 5)
        environment = json.loads((self.root / "environment.json").read_text())
        self.assertNotIn("EXAMPLE_PROVIDER_SECRET", environment)
        self.assertNotIn("HTTP_PROXY", environment)
        self.assertEqual(environment["OLLAMA_NO_CLOUD"], "1")
        generated = next(item["value"] for item in self.requests() if item["path"] == "/api/generate")
        self.assertEqual(generated["keep_alive"], 0)
        self.assertEqual(generated["options"]["num_ctx"], 8192)
        self.assertNotIn("/api/pull", [item["path"] for item in self.requests()])
        count = len(self.requests())
        recovered = InferenceRunner(self.config, self.root / "state", inference()["models"])
        self.assertEqual(recovered.reconcile(self.job, lambda: False), report)
        self.assertEqual(len(self.requests()), count)

    def test_remote_aliases_and_changed_digests_fail_without_running_inference(self):
        for mode in ("remote", "digest"):
            (self.root / "mode").write_text(mode)
            report = self.runner.reconcile(job_assignment(), lambda: False)
            self.assertEqual(report["state"], "failed", report)
        self.assertNotIn("/api/generate", [item["path"] for item in self.requests()])

    def test_incomplete_results_or_unmeasured_usage_are_not_success(self):
        for mode in ("incomplete", "usage"):
            (self.root / "mode").write_text(mode)
            self.assertEqual(self.runner.reconcile(job_assignment(), lambda: False)["state"], "failed")

    def test_cancellation_and_resource_stop_fence_the_owned_process(self):
        (self.root / "mode").write_text("wait")
        def cancelled():
            return (self.root / "generating").exists()
        report = self.runner.reconcile(self.job, cancelled)
        self.assertEqual(report["state"], "cancelled", report)
        (self.root / "generating").unlink()
        checks = [0]
        def restriction(*args, **kwargs):
            checks[0] += 1
            return "SSD swap activity" if checks[0] > 2 else None
        self.runner.guard.restriction.side_effect = restriction
        report = self.runner.reconcile(job_assignment(), lambda: False)
        self.assertEqual(report["state"], "failed", report)

    def test_uncertain_execution_is_never_replayed_or_released_by_cancellation(self):
        path = self.runner.directory / (self.job["id"] + ".json")
        save_json(path, {"fingerprint": digest({"request": self.job["request"], "definition": self.job["definition"]}),
                         "report": {"state": "running"}})
        self.job["desired"] = "cancelled"
        self.assertEqual(self.runner.reconcile(self.job, lambda: True)["state"], "unknown")
        self.assertFalse((self.root / "requests.jsonl").exists())
        path.unlink()
        self.runner.guard.restriction.return_value = "Waiting for RAM"
        self.job["desired"] = "running"
        self.assertEqual(self.runner.reconcile(self.job, lambda: False)["state"], "waitingForResources")
        self.assertFalse(path.exists())

    def test_controller_to_host_worker_and_cli_flow(self):
        store = Store(self.root / "controller.db")
        admin, enrollment = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        service = server(store, ("127.0.0.1", 0), admin, enrollment)
        threading.Thread(target=service.serve_forever, daemon=True).start()
        self.addCleanup(service.server_close)
        self.addCleanup(service.shutdown)
        url = "http://127.0.0.1:" + str(service.server_port)
        client = Client(url, admin)
        config = {"name": "inference-host", "provider": "native", "templates": [],
                  "capacity": {"cpu": 4, "memoryMiB": 8192, "diskGiB": 10}, "inference": self.config}
        agent = Agent(config, url, self.root / "agent")
        agent.inference_runner.guard = self.runner.guard
        agent.connect(enrollment)
        agent.poll()
        for credential in (enrollment, agent.identity["credential"]):
            for method, path, body in (("GET", "/v1/models", None), ("POST", "/v1/jobs", job_request_value())):
                with self.assertRaises(Error):
                    Client(url, credential).request(method, path, body)
        token = self.root / "admin.token"
        token.write_text(admin)
        prompt = self.root / "prompt.txt"
        prompt.write_text("Say hello")
        prefix = [sys.executable, "-B", "-m", "canaveral", "--url", url, "--token-file", str(token)]
        value = json.loads(subprocess.check_output(prefix + ["generate", "--model", model()["id"], "--prompt-file", str(prompt), "--request-id", str(uuid.uuid4())]))
        agent.poll()
        completed = threading.Event()
        original = agent.inference_runner.reconcile
        def reconcile(*args):
            report = original(*args)
            completed.set()
            return report
        agent.inference_runner.reconcile = reconcile
        worker = threading.Thread(target=agent.inference_work, daemon=True)
        worker.start()
        try:
            self.assertTrue(completed.wait(10))
            # Allow the worker to publish its report under the host lock.
            agent.stopping.set()
            worker.join(timeout=3)
            agent.poll()
        finally:
            agent.stopping.set()
            worker.join(timeout=3)
        returned = json.loads(subprocess.check_output(prefix + ["job", value["id"]]))
        self.assertEqual(returned["state"], "succeeded", returned)
        self.assertEqual(returned["result"]["text"], "Hello from the runner.")
        self.assertEqual(store.hosts()[0]["reserved"]["memoryMiB"], 0)
        self.assertEqual(Store(store.path).jobs(value["id"])["result"], returned["result"])
        models = json.loads(subprocess.check_output(prefix + ["models"]))
        self.assertEqual(models["models"][0]["digest"], model()["digest"])


if __name__ == "__main__":
    unittest.main()
