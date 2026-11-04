"""A Canaveral runner owns the local inference process and its job receipts."""
import json
import os
import queue
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .files import save_json
from .inference import TERMINAL, generation_result
from .inference_resources import ResourceGuard
from .model import Error, digest


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Error("Local inference redirects are not followed.")


class LocalRuntime:
    def __init__(self, config):
        self.config = config
        self.process = None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)

    def check(self):
        executable, models = self.config.get("executable", ""), self.config.get("modelsDirectory", "")
        if not Path(executable).is_absolute() or not os.access(executable, os.X_OK) or not Path(executable).is_file():
            raise Error("Configure an installed absolute Ollama executable path.")
        if not Path(models).is_absolute() or not Path(models).is_dir():
            raise Error("Configure an existing absolute directory of installed Ollama models.")

    def request(self, path, value=None, timeout=2):
        body = json.dumps(value).encode() if value is not None else None
        request = urllib.request.Request(self.url + path, data=body, headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=timeout) as response:
                data = response.read(1048577)
                if len(data) > 1048576:
                    raise Error("Local inference response exceeds 1 MiB.")
                return json.loads(data)
        except (urllib.error.URLError, OSError, ValueError):
            raise Error("Local inference failed; inspect the installed model and runtime.")

    def start(self, cancelled):
        self.check()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.url = "http://127.0.0.1:" + str(port)
        # Never inherit provider credentials, proxy settings or other Ollama configuration.
        environment = {"HOME": str(Path.home()), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                       "OLLAMA_HOST": "127.0.0.1:" + str(port), "OLLAMA_MODELS": self.config["modelsDirectory"],
                       "OLLAMA_NO_CLOUD": "1", "OLLAMA_NOPRUNE": "1", "OLLAMA_NUM_PARALLEL": "1",
                       "OLLAMA_MAX_LOADED_MODELS": "1", "OLLAMA_CONTEXT_LENGTH": "8192", "OLLAMA_KEEP_ALIVE": "0"}
        self.process = subprocess.Popen([self.config["executable"], "serve"], env=environment,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                        start_new_session=True)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if cancelled():
                raise Error("Inference stopped before runtime readiness.")
            if self.process.poll() is not None:
                raise Error("The owned inference runtime stopped before readiness.")
            try:
                self.request("/api/version")
                if self.process.poll() is None:
                    return
            except Error:
                pass
            time.sleep(0.2)
        raise Error("Local inference runtime startup timed out.")

    def stop(self):
        if self.process is None:
            return
        group = self.process.pid
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(group, sig)
            except ProcessLookupError:
                break
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                continue
        self.process.wait(timeout=2)
        # A surviving child can retain model memory after its server exits.
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            self.process = None
            return
        raise Error("Inference process cleanup is uncertain; capacity remains reserved.")

    def generate(self, job, cancelled, guard):
        try:
            self.start(cancelled)
            model = job["definition"]
            installed = self.request("/api/tags").get("models", [])
            if not any(isinstance(item, dict) and item.get("name") == model["id"] and
                       isinstance(item.get("digest"), str) and item["digest"].removeprefix("sha256:") == model["digest"][7:] for item in installed):
                raise Error("The exact installed model digest is missing; no download was attempted.")
            metadata = self.request("/api/show", {"model": model["id"]})
            if metadata.get("remote_model") or metadata.get("remote_host") or "completion" not in metadata.get("capabilities", []):
                raise Error("The selected model is not a local generation model.")
            outcome = queue.Queue(maxsize=1)

            def infer():
                try:
                    outcome.put(self.request("/api/generate", {"model": model["id"], "prompt": job["request"]["prompt"],
                        "stream": False, "keep_alive": 0, "think": False,
                        "options": {"num_ctx": 8192, "num_predict": job["request"]["maxTokens"]}}, timeout=120))
                except Exception:
                    outcome.put(Error("Local generation failed or timed out; the job was not retried."))

            thread = threading.Thread(target=infer, daemon=True)
            thread.start()
            deadline = time.monotonic() + 125
            while True:
                if cancelled():
                    raise Error("Inference cancelled or controller contact expired.")
                reason = guard.restriction(model["resources"]["memoryMiB"], running=True)
                if reason:
                    raise Error("Inference stopped: " + reason)
                if self.process.poll() is not None or time.monotonic() > deadline:
                    raise Error("The local runtime stopped or exceeded its generation deadline.")
                try:
                    value = outcome.get(timeout=1)
                    break
                except queue.Empty:
                    continue
            if isinstance(value, Exception):
                raise value
            if not isinstance(value, dict) or value.get("done") is not True or value.get("model") != model["id"]:
                raise Error("The runtime did not return a completed result for the selected model.")
            if not isinstance(value.get("response"), str) or not value["response"].strip():
                raise Error("The runtime returned no generated text.")
            return generation_result({"model": value["model"], "text": value["response"], "usage": {
                "inputTokens": value.get("prompt_eval_count"), "outputTokens": value.get("eval_count")}}, model["id"])
        finally:
            self.stop()


class InferenceRunner:
    def __init__(self, config, state_dir, models):
        self.config, self.models = config, models
        self.directory = Path(state_dir) / "inference"
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.guard = ResourceGuard(self.directory)
        self.waiting = {}

    def check(self):
        LocalRuntime(self.config).check()

    def reconcile(self, job, cancelled, started=lambda: None):
        path = self.directory / (job["id"] + ".json")
        fingerprint = digest({"request": job["request"], "definition": job["definition"]})
        if path.exists():
            receipt = json.loads(path.read_text())
            if receipt.get("fingerprint") != fingerprint:
                return {"state": "unknown", "detail": "Local inference identity conflicts with the assignment."}
            if receipt["report"]["state"] in TERMINAL:
                return receipt["report"]
            return {"state": "unknown", "detail": "Previous inference outcome is uncertain. Inspect and fence the old runtime; this job will not be replayed."}
        if job["desired"] == "cancelled" or cancelled():
            report = {"state": "cancelled"}
        elif job["definition"] not in self.models:
            report = {"state": "failed", "detail": "The pinned model contract is no longer installed on this host."}
        else:
            reason = self.guard.restriction(job["definition"]["resources"]["memoryMiB"])
            if reason:
                since = self.waiting.setdefault(job["id"], time.monotonic())
                if time.monotonic() - since < 600:
                    return {"state": "waitingForResources", "detail": reason}
                report = {"state": "failed", "detail": "Resource wait expired: " + reason}
            else:
                runtime = LocalRuntime(self.config)
                save_json(path, {"fingerprint": fingerprint, "report": {"state": "running"}})
                started()
                try:
                    result = runtime.generate(job, cancelled, self.guard)
                    report = {"state": "succeeded", "result": result}
                except Exception as error:
                    if runtime.process is not None:
                        # Cleanup was not proven; retain capacity instead of claiming cancellation.
                        return {"state": "unknown", "detail": "Runtime cleanup is uncertain; inspect the host before releasing capacity."}
                    report = {"state": "cancelled" if cancelled() else "failed",
                              "detail": (str(error) if isinstance(error, Error) else "Local inference stopped without a result; inspect the runtime and host.")[:2000]}
        self.waiting.pop(job["id"], None)
        save_json(path, {"fingerprint": fingerprint, "report": report})
        return report
