import json
import platform
import subprocess
import time
import contextlib
from pathlib import Path

from .base import Provider, run
from ..files import save_json
from ..model import Error
from ..seed import ensure_seed


class Apple(Provider):
    def resource_processes(self,machine,image,folder,psutil):
        from ..owned_usage import apple_processes
        return apple_processes(self,machine,folder,psutil)

    def refresh_execution(self,machine,image,folder,authorization):
        """Publish deadlines without entering preparation or VM reconciliation."""
        from ..native_lease import publish,confirm_fenced
        from ..model import digest
        machine_id=machine['id'];storage=Path(self.config['storage']).resolve()/machine_id
        path=storage/machine_id.upper()
        if (Path(folder)/'deletion.json').exists():return None
        if not (path/'runner-launch.json').is_file():return None
        expected=digest({key:machine[key] for key in ('id','template','resources')})
        for receipt in (Path(folder)/'assignment.json',storage/'canaveral-owner.json'):
            if receipt.is_symlink() or not receipt.is_file() or json.loads(receipt.read_text()).get('fingerprint')!=expected:
                raise Error('Native lease update requires matching assignment and storage ownership.',409)
        if storage.is_symlink() or path.is_symlink():raise Error('Native lease supervision cannot follow storage links.',409)
        definition=json.loads((path/'machine.json').read_text())
        if definition.get('executionLeaseID','').lower()!=machine['lease']['id']:raise Error('Native lease updates cannot adopt administrative machines.',409)
        if confirm_fenced(machine,path):return {'state':'stopped','leaseFenced':True,'detail':'Native leased execution ended; process, runtime lock and disk handles are closed.'}
        value=authorization();receipt=path/'lease-authorization.json'
        previous=json.loads(receipt.read_text()) if receipt.is_file() else {}
        stopping=machine['desired']=='stopped' or value['fenced']
        if previous.get('revision')!=value['revision'] or stopping and not previous.get('fenced'):
            publish(self,machine,{**image,'_leaseAuthorization':authorization},path,stopping=stopping)
        if stopping:return {'state':'stopping','leaseFenced':True,'detail':'Lease execution is fenced; native stop confirmation is pending.'}
        return None

    def display_epoch(self,machine,image,folder):
        from ..model import digest
        path=self.storage(machine)/machine['id'].upper()/'runner-launch.json'
        if not path.is_file():return None
        launch=json.loads(path.read_text())
        return {'startedAt':launch['attemptedAt'],'identity':digest(launch)}

    def remove_owned_storage(self,machine,image,folder,request_id,preboot=False):
        from ..owned_removal import remove_apple_storage
        return remove_apple_storage(self,machine,folder,request_id,preboot=preboot)

    @contextlib.contextmanager
    def capture_source(self,machine,image,folder):
        from ..files import HostLock
        if (Path(folder)/'deletion.json').exists():raise Error('This assignment has a deletion intent; capture is refused.',409)
        if image['os']!='linux':raise Error('macOS capture requires restore/platform artifact handling; this runtime currently captures Linux disks.')
        storage=self.storage(machine)
        path=storage/machine['id'].upper()
        if not (path/'native-prepared').exists() or not (Path(folder)/'assignment.json').exists():raise Error('Owned prepared machine receipt is missing.')
        with HostLock(path/'runtime.lock'):
            if not self.confirmed_stopped(path):raise Error('Native runtime has not confirmed shutdown of its latest boot.')
            yield path/'disk.img','raw'

    def confirmed_stopped(self,path):
        status=path/'status.json';launch=path/'runner-launch.json'
        if not launch.exists():return not status.exists() or json.loads(status.read_text()).get('phase')=='Stopped'
        current=json.loads(status.read_text()) if status.exists() else None
        fence=path/'fenced-stop.json'
        if fence.exists():
            proof=json.loads(fence.read_text())
            matching=proof.get('boot')==json.loads(launch.read_text())['attemptedAt'] and proof.get('consistency')=='crash-consistent'
            if matching and current and current.get('updatedAt',0)+978307200<=proof.get('stoppedAt',0):return True
            if matching and not current and proof.get('leaseID') and (path/'machine.json').exists():
                return json.loads((path/'machine.json').read_text()).get('executionLeaseID','').lower()==proof['leaseID']
        if not current:return False
        return current.get('phase')=='Stopped' and current.get('updatedAt',0)+978307200>=json.loads(launch.read_text())['attemptedAt']

    def capture_consistency(self,machine,image,folder):
        path=self.storage(machine)/machine['id'].upper()
        fence=path/'fenced-stop.json';launch=json.loads((path/'runner-launch.json').read_text()) if (path/'runner-launch.json').exists() else {}
        if fence.exists() and json.loads(fence.read_text()).get('boot')==launch.get('attemptedAt'):return 'crash-consistent'
        current=json.loads((path/'status.json').read_text())
        return 'crash-consistent' if current.get('stopReason') in ('forced','error') else 'guest-shutdown' if current.get('stopReason')=='guest' else 'stopped-disk'
    def check(self):
        if platform.system() != "Darwin":
            raise Error("The Apple backend requires a physical Mac with hardware virtualization.")
        self.local_templates({"linux", "macos"})
        if any(t["os"] == "macos" and t["arch"] != "arm64" for t in self.config["templates"]):
            raise Error("macOS guests require Apple silicon.")
        if any(t["os"] == "macos" and t["mode"] != "desktop" for t in self.config["templates"]):
            raise Error("The Apple runtime currently exposes macOS desktop guests.")
        for image in self.config["templates"]:
            if image["os"] == "macos" and not image["image"].lower().endswith(".ipsw"):
                from pathlib import Path
                if not all(image.get(key) and Path(image[key]).is_file() for key in ("macOSRestoreImage", "macOSAuxiliaryStorage", "macOSHardwareModel")):
                    raise Error("A macOS base disk needs matching restore image, auxiliary storage and hardware model bindings.")
        if not self.config.get("runner"):
            raise Error("Build the signed CanaveralVMRunner and configure its absolute path.")
        run([self.config["runner"], "check"])

    def reconcile(self, machine, image, folder):
        storage = self.storage(machine)
        path = storage / machine["id"].upper()
        machine_file = path / "machine.json"
        if machine_file.exists():
            native_lease=json.loads(machine_file.read_text()).get('executionLeaseID')
            expected=machine.get('lease',{}).get('id')
            if (native_lease is None)!=(expected is None) or (native_lease is not None and native_lease.lower()!=expected):
                raise Error('Native execution ownership differs from this assignment; adoption was refused.',409)
        request = {"id": machine["id"], "name": machine["name"], "os": image["os"], "mode": image["mode"],
                   "cpu": machine["resources"]["cpu"], "memoryMiB": machine["resources"]["memoryMiB"],
                   "diskGiB": machine["resources"]["diskGiB"], "image": image["image"], "directory": str(storage)}
        if image["os"] == "macos" and image.get("macOSRestoreImage"):
            request.update(image=image["macOSRestoreImage"], baseDisk=image["image"], auxiliaryStorage=image.get("macOSAuxiliaryStorage"), hardwareModel=image.get("macOSHardwareModel"))
        if machine.get('lease'):request['leaseID']=machine['lease']['id']
        status = path / "status.json"
        current = json.loads(status.read_text()) if status.exists() else None
        # Swift Date's JSON epoch is 2001-01-01, not Unix time.
        fresh = current and time.time() - (current["updatedAt"] + 978307200) < 8
        locked = json.loads(run([self.config["runner"], "inspect", str(path)]))["locked"] if path.exists() else False
        active = locked and fresh and current["phase"] not in ("Stopped", "Unavailable")
        if machine.get('lease') and (path/'runner-launch.json').exists():
            from ..native_lease import publish,confirm_fenced
            if confirm_fenced(machine,path):return {'state':'stopped','leaseFenced':True,'detail':'Native leased execution ended; runtime lock and disk handles are closed.'}
            publish(self,machine,image,path,stopping=machine['desired']=='stopped')
            if machine['desired']=='stopped':return {'state':'stopping','detail':'Lease execution is fenced; awaiting native process and disk-handle confirmation.'}
        if machine["desired"] == "stopped":
            if machine.get('lease') and not (path/'runner-launch.json').exists():
                return {'state':'unknown','detail':'Leased native boot history is missing. Owned pre-boot cleanup requires its durable preparation journal.'}
            if machine.get('powerOffRequest') and not (not locked and self.confirmed_stopped(path)):
                if current and current.get('runnerProtocol')==1 and locked:
                    boot=json.loads((path/'runner-launch.json').read_text())['attemptedAt']
                    save_json(path/'power-off.request',{'id':machine['powerOffRequest'],'boot':boot})
                    return {'state':'stopping','detail':'Explicit power-off requested; awaiting native confirmation.'}
                from ..native_fence import force_stop
                return force_stop(path,machine['powerOffRequest'],[self.config['runner'],*self.config.get('legacyRunners',[])])
            if active:
                detail='Graceful shutdown requested; waiting for native stop confirmation.'
                if self.access and image.get('guestAccess') and image['os']=='linux':
                    launch=path/'runner-launch.json'
                    if launch.exists():
                        try:self.access.shutdown(machine,image,folder,json.loads(launch.read_text())['attemptedAt'])
                        except Error:
                            detail='Guest-assisted shutdown unavailable; native shutdown requested. Waiting for positive stop confirmation.'
                (path / "shutdown.request").touch()
                return {"state": "stopping",'detail':detail}
            if not locked and self.confirmed_stopped(path):
                return {"state": "stopped"}
            return {"state": "unknown", "detail": "Runner status expired; inspect the machine before reusing its capacity."}
        if not machine_file.exists():
            seed = ensure_seed(image, machine, storage)
            if seed:
                request["seedISO"] = seed
            run([self.config["runner"], "prepare"], data=json.dumps(request).encode())
        if not (path / "native-prepared").exists():
            raise Error("Native preparation is incomplete. Inspect the partial machine before booting it.")
        if active:
            return {"state": "running" if current["phase"] == "Running" else "starting", "detail": current["detail"]}
        if fresh and current["phase"] == "Unavailable":
            return {"state": "error", "detail": current["detail"]}
        # The native runner owns a per-machine flock; duplicate starts cannot boot a second VM.
        launch = path / "runner-launch.json"
        if locked or (launch.exists() and not self.confirmed_stopped(path)):
            return {"state": "unknown", "detail": "Runner outcome uncertain. Inspect the machine and its log before clearing runner-launch.json."}
        shutdown = path / "shutdown.request"
        shutdown.unlink(missing_ok=True)
        (path/'power-off.request').unlink(missing_ok=True)
        attempted_at=time.time()
        from ..provisioning import record_boot_request
        record_boot_request(machine,folder,attempted_at)
        save_json(launch, {"attemptedAt": attempted_at})
        if machine.get('lease'):
            from ..native_lease import publish
            publish(self,machine,image,path)
        with (path / "runner.log").open("ab") as output:
            # The VM has its own execution deadline, process/lock/disk proofs.
            # It must not inherit the helper gate needed to request its stop.
            subprocess.Popen([self.config["runner"], "run", str(path)], stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        return {"state": "starting"}
