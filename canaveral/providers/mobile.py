"""Shared, bounded subprocess and operation receipt handling for mobile hosts."""
import base64
import json
import os
import subprocess
import tempfile
import time
from contextlib import nullcontext
from pathlib import Path

from .base import Provider, architecture
from ..assignment_process import assignment_run
from ..devices import MAX_RESULT, operation_request
from ..files import HostLock, save_json
from ..model import Error, digest, identifier


def execute(argv, env=None, data=None, timeout=60, binary=False):
    # Large screenshots and command output go to disk before bounded reads.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        try:
            result = assignment_run([str(x) for x in argv], input=data, stdout=output, stderr=errors,
                                    env=env, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Error("Device command unavailable or timed out; its effects may be uncertain.") from error
        if result.returncode:
            raise Error("Device command failed; inspect the private host logs and device state.")
        output.seek(0)
        value = output.read(4 * 1048576 + 1)
        if len(value) > 4 * 1048576:
            raise Error("Device output exceeds 4 MiB; request a smaller file or log.")
        return value if binary else value.decode("utf-8", errors="replace").strip()


def encoded(data, media_type="application/octet-stream"):
    return {"data": base64.b64encode(data).decode("ascii"), "mediaType": media_type}


def operation_receipt(folder,operation_id):
    receipt=Path(folder)/'operations'/(identifier(operation_id)+'.json')
    unknown={'state':'unknown','result':{'detail':'No completed local receipt is available. Inspect before retrying.'}}
    if not receipt.exists():return unknown
    if receipt.stat().st_size>MAX_RESULT+16384:raise Error('Operation receipt exceeds its bounded envelope.')
    return json.loads(receipt.read_text()).get('report',unknown)


class Mobile(Provider):
    def storage(self, machine):
        path = super().storage(machine)
        path.chmod(0o700)
        return path

    def check_templates(self, system):
        for image in self.config["templates"]:
            if image["os"] != system or image["arch"] != architecture():
                raise Error("Device templates must match this host's platform and architecture.")

    def artifact(self, name):
        path = self.config.get("artifacts", {}).get(name)
        if not isinstance(path, str) or not Path(path).is_absolute() or not Path(path).exists():
            raise Error("Install requires an artifact ID configured by this host's owner.")
        return path

    def operate(self, machine, image, folder, operation, input_guard=None, control_handler=None):
        from ..assignment_gate import assignment_access
        with assignment_access(machine,folder):
            return Mobile._locked_operate(self,machine,image,folder,operation,input_guard,control_handler)

    def _locked_operate(self, machine, image, folder, operation, input_guard=None, control_handler=None):
        request=operation_request({key:operation[key] for key in ('id','action','arguments')})
        receipt=Path(folder)/'operations'/(request['id']+'.json')
        receipt.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        with HostLock(receipt.with_suffix('.lock')):
            return Mobile._operate(self,machine,image,folder,operation,input_guard,control_handler)

    def _operate(self, machine, image, folder, operation, input_guard=None, control_handler=None):
        """A started receipt never replays effects after a crash or ambiguous timeout."""
        request = operation_request({key: operation[key] for key in ("id", "action", "arguments")})
        receipt = folder / "operations" / (identifier(request["id"]) + ".json")
        fingerprint = digest({"machine": machine["id"], **request})
        if receipt.exists():
            saved = json.loads(receipt.read_text())
            if saved["fingerprint"] != fingerprint:
                raise Error("Device operation identity conflicts with its local receipt.")
            return saved.get("report", {"state": "unknown", "result": {"detail": "Interrupted device action; inspect before issuing a new operation."}})
        if time.time() > operation["expiresAt"]:
            report = {"state": "failed", "result": {"detail": "Device operation expired before execution."}}
        elif machine["desired"] != "running":
            report = {"state": "failed", "result": {"detail": "Device is stopping or stopped."}}
        else:
            save_json(receipt, {"fingerprint": fingerprint, "started": True})
            try:
                with input_guard() if input_guard else nullcontext():
                    if image.get("os") in ("android", "ios") and request["action"] in ("accessibility", "accessibility-action"):
                        from ..accessibility import inspect_provider
                        if request["action"] == "accessibility":
                            result = inspect_provider(self, machine, image, folder, include_frame=True)
                        else:
                            from ..accessibility import snapshot
                            from ..display_access import InputDenied
                            if request["arguments"]["nativeAction"] != "click":
                                raise InputDenied("Only click is currently exposed for simulator accessibility targets.",409,code='input_rejected')
                            native = self.control(machine, image, folder, {"id": request["id"], "action": "hierarchy", "arguments": {}})
                            current = snapshot(image["os"], native)
                            try:point = self.inspections.target(machine["id"], request["arguments"], current)
                            except Error as error:raise InputDenied(str(error),409,code='input_rejected') from error
                            result = self.control(machine, image, folder, {"id": request["id"], "action": "tap", "arguments": point})
                    else:
                        result = control_handler(request) if control_handler else self.control(machine, image, folder, request)
                report = {"state": "succeeded", "result": result}
            except Error as error:
                from ..display_access import InputDenied
                report = {"state": "failed" if isinstance(error,InputDenied) else "unknown", "result": {"detail": str(error)[:2000]}}
                if isinstance(error,InputDenied):report['result']['code']=error.code
            except Exception:
                report = {"state": "unknown", "result": {"detail": "Device action failed or was interrupted; inspect device state before retrying with a new ID."}}
        # Escaping a bounded text result can exceed the binary result envelope.
        if len(json.dumps(report.get("result", {}), allow_nan=False).encode()) > MAX_RESULT:
            report = {"state": "unknown", "result": {"detail": "Device action output exceeds the result envelope; inspect device state before issuing a smaller request."}}
        save_json(receipt, {"fingerprint": fingerprint, "report": report})
        return report

    def run(self, argv, **kwargs):
        return execute(argv, **kwargs)

    def environment(self):
        result = dict(os.environ)
        result.update(LC_ALL="C", LANG="C")
        return result
