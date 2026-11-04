import json
import os
import platform
import subprocess
from pathlib import Path

from ..files import save_json
from ..assignment_process import assignment_run
from ..model import Error, digest, identifier


def run(argv, data=None, env=None, timeout=300):
    environment = dict(os.environ if env is None else env)
    if os.name != "nt":
        environment.update(LC_ALL="C", LANG="C")
    try:
        result = assignment_run([str(a) for a in argv], input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, env=environment, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Error("Backend command unavailable or timed out: " + str(argv[0])) from error
    if result.returncode:
        raise Error("Backend command failed: " + result.stderr.decode(errors="replace")[-1800:])
    return result.stdout.decode().strip()


def architecture():
    return {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(platform.machine().lower())


class Provider:
    def display_epoch(self,machine,image,folder):
        # Unknown boot identity cannot clear an uncertain input-reset receipt.
        return None

    def remove_owned_storage(self,machine,image,folder,request_id):
        raise Error('Owned storage removal is not implemented for this runtime.',409)

    def capture_consistency(self,machine,image,folder):return 'stopped-disk'
    def capture_source(self,machine,image,folder):
        raise Error('Cold image capture is not implemented for this runtime.')

    def __init__(self, config, state):
        self.config, self.state = config, Path(state)
        import threading
        from ..accessibility import Inspections
        self.inspection_lock = threading.RLock()
        self.inspections = Inspections()
        self.access = None
        if config.get("guestAccess"):
            from ..guest_access import GuestAccess
            self.access = GuestAccess(config, state)

    def local_templates(self, systems):
        for image in self.config["templates"]:
            if image["os"] not in systems or image["arch"] != architecture():
                raise Error("Template is incompatible with this native host's OS or architecture.")
            if not Path(image.get("image", "")).is_absolute() or not Path(image["image"]).is_file():
                raise Error("Templates require a readable absolute image path installed by the host owner.")

    def storage(self, machine):
        root = Path(self.config["storage"]).resolve()
        root.mkdir(parents=True, exist_ok=True)
        path = root / identifier(machine["id"])
        path.mkdir(mode=0o755, exist_ok=True)
        marker = path / "canaveral-owner.json"
        expected = digest({"id": machine["id"], "template": machine["template"], "resources": machine["resources"]})
        if marker.exists():
            if json.loads(marker.read_text()).get("fingerprint") != expected:
                raise Error("VM storage belongs to another assignment.")
        elif list(path.iterdir()):
            raise Error("VM storage is not empty and has no Canaveral owner record.")
        else:
            save_json(marker, {"fingerprint": expected})
        return path

    def name(self, machine):
        return "cvm-" + identifier(machine["id"])

    def operate(self, machine, image, folder, operation, input_guard=None, control_handler=None):
        from .mobile import Mobile
        return Mobile.operate(self, machine, image, folder, operation, input_guard=input_guard, control_handler=control_handler)

    def control(self, machine, image, folder, request):
        if not self.access or not image.get("guestAccess"):
            raise Error("This machine has no configured guest connection.")
        return self.access.control(machine, image, folder, request)
