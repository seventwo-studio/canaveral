import json
import platform
import os
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

from .base import Provider, run
from ..model import Error
from ..seed import ensure_seed


def domain_xml(machine, image, disk):
    root = ET.Element("domain", type="kvm")
    ET.SubElement(root, "name").text = "cvm-" + machine["id"]
    ET.SubElement(root, "uuid").text = machine["id"]
    ET.SubElement(root, "memory", unit="MiB").text = str(machine["resources"]["memoryMiB"])
    ET.SubElement(root, "vcpu").text = str(machine["resources"]["cpu"])
    operating = ET.SubElement(root, "os", firmware="efi")
    ET.SubElement(operating, "type", arch="aarch64" if image["arch"] == "arm64" else "x86_64").text = "hvm"
    firmware = ET.SubElement(operating, "firmware")
    ET.SubElement(firmware, "feature", name="secure-boot", enabled="yes" if image.get("secureBoot", image["os"] == "windows") else "no")
    ET.SubElement(operating, "boot", dev="hd")
    features = ET.SubElement(root, "features")
    ET.SubElement(features, "acpi")
    if image["os"] == "windows":
        ET.SubElement(features, "smm", state="on")
    ET.SubElement(root, "cpu", mode="host-passthrough")
    devices = ET.SubElement(root, "devices")
    drive = ET.SubElement(devices, "disk", type="file", device="disk")
    ET.SubElement(drive, "driver", name="qemu", type="qcow2")
    ET.SubElement(drive, "source", file=str(disk))
    # SATA avoids requiring virtio storage drivers in prepared Windows images.
    ET.SubElement(drive, "target", dev="sda" if image["os"] == "windows" else "vda", bus="sata" if image["os"] == "windows" else "virtio")
    if image.get("_seedISO"):
        seed = ET.SubElement(devices, "disk", type="file", device="cdrom")
        ET.SubElement(seed, "driver", name="qemu", type="raw")
        ET.SubElement(seed, "source", file=image["_seedISO"])
        ET.SubElement(seed, "target", dev="sdb" if image["os"] == "windows" else "sda", bus="sata" if image["os"] == "windows" else "scsi")
        ET.SubElement(seed, "readonly")
        if image["os"] != "windows":
            ET.SubElement(devices, "controller", type="scsi", model="virtio-scsi")
    network = ET.SubElement(devices, "interface", type="network")
    ET.SubElement(network, "source", network=image.get("network", "default"))
    ET.SubElement(network, "model", type="e1000e" if image["os"] == "windows" else "virtio")
    serial = ET.SubElement(devices, "serial", type="pty")
    ET.SubElement(serial, "target", port="0")
    console = ET.SubElement(devices, "console", type="pty")
    ET.SubElement(console, "target", type="serial", port="0")
    if image["mode"] == "desktop":
        graphics = ET.SubElement(devices, "graphics", type="vnc", port="-1", autoport="yes", listen="127.0.0.1")
        ET.SubElement(graphics, "listen", type="address", address="127.0.0.1")
        ET.SubElement(ET.SubElement(devices, "video"), "model", type="vga" if image["os"] == "windows" else "virtio")
    else:
        ET.SubElement(ET.SubElement(devices, "video"), "model", type="none")
    if image.get("tpm", image["os"] == "windows"):
        ET.SubElement(ET.SubElement(devices, "tpm", model="tpm-crb"), "backend", type="emulator", version="2.0")
    return ET.tostring(root)


def leased_domain_xml(machine, image, disk):
    """Keep newly leased writable firmware/TPM state with the owned disk."""
    root = ET.fromstring(domain_xml(machine, image, disk))
    storage = Path(disk).parent
    ET.SubElement(root.find('os'), 'nvram').text = str(storage/'nvram.fd')
    for backend in root.findall('devices/tpm/backend'):
        backend.set('persistent_state', 'yes')
        ET.SubElement(backend, 'source', type='dir', path=str(storage/'tpm-state'))
    return ET.tostring(root)


class Libvirt(Provider):
    def resource_processes(self, machine, image, folder, psutil):
        from ..libvirt_usage import processes
        return processes(self, machine, image, folder, psutil)

    def __init__(self, config, state):
        super().__init__(config, state)
        self.lease_processes = {}

    def _lease_authorization(self, image):
        callback = image.get('_leaseAuthorization')
        if not callable(callback): raise Error('Leased libvirt execution requires its pinned local deadline.', 409)
        return callback

    def _prepare_lease(self, machine, image, folder):
        from ..libvirt_execution import prepare, linux_boot_id, library_identity
        from ..libvirt_supervision import LibvirtLeaseBinding, SupervisorJournal, bind_domain_xml
        from ..owned_removal import assignment_fingerprint, sync_directory
        library = self.config.get('leaseDeadlineLibrary')
        if not isinstance(library, str): raise Error('Leased libvirt execution requires a reviewed native deadline library.', 409)
        library_identity(library) # Validate before any native provisioning effect.
        state = SupervisorJournal(folder, 'libvirt-binding')
        try:
            if (state.read() is not None or any(state.read_named(name) is not None for name in (
                    'libvirt-execution.json', 'libvirt-launch.json', 'libvirt-authorization.json'))):
                raise Error('Libvirt lease preparation has unknown prior history.', 409)
            assignment = state.read_named('assignment.json')
            if (not isinstance(assignment, dict) or assignment.get('fingerprint') != assignment_fingerprint(machine)
                    or assignment.get('leaseId') != machine['lease']['id']):
                raise Error('Libvirt preparation cannot adopt another assignment.', 409)
        finally: state.close()
        if self.name(machine) in self.virsh('list', '--all', '--name').splitlines() or machine['id'] in self.virsh('list', '--all', '--uuid').lower().splitlines():
            raise Error('A leased libvirt assignment cannot adopt an existing domain.', 409)
        path = self.storage(machine); disk = path/'disk.qcow2'
        if disk.exists() or disk.is_symlink() or (path/'domain.xml').exists():
            raise Error('Libvirt lease preparation is partial; native creation will not be replayed.', 409)
        image = {**image, '_seedISO': ensure_seed(image, machine, path)}
        info = json.loads(run(['qemu-img', 'info', '--output=json', image['image']]))
        if (info['virtual-size'] > machine['resources']['diskGiB']*1073741824
                or info['format'] not in ('raw', 'qcow2') or info.get('backing-filename')):
            raise Error('Libvirt lease base disk is incompatible or is not standalone.', 409)
        run(['qemu-img', 'create', '-f', 'qcow2', '-F', info['format'], '-b', image['image'], disk, str(machine['resources']['diskGiB'])+'G'])
        binding = LibvirtLeaseBinding(machine['id'], machine['lease']['id'], str(uuid.uuid4()), linux_boot_id(), assignment_fingerprint(machine), str(disk))
        prepare(binding, folder, self.config.get('uri', 'qemu:///system'), library)
        definition = path/'domain.xml'
        fd = os.open(definition, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(bind_domain_xml(leased_domain_xml(machine, image, disk), binding).encode('utf-8'))
            stream.flush(); os.fsync(stream.fileno())
        sync_directory(path)
        self.virsh('define', definition) # Binding/one-use preparation survive a lost define acknowledgement.

    def start_lease_supervisor(self, machine, folder):
        from ..libvirt_execution import launch
        process = launch(machine, folder)
        self.lease_processes[machine['id']] = process

    def _reap_supervisors(self):
        for machine_id, process in list(self.lease_processes.items()):
            if process.poll() is not None: self.lease_processes.pop(machine_id, None)

    def _lease_location_matches(self, binding, spec):
        expected = Path(self.config['storage']).resolve()/binding.machine_id/'disk.qcow2'
        return spec['uri'] == self.config.get('uri', 'qemu:///system') and Path(binding.disk).resolve() == expected

    def confirm_execution_stopped(self, machine, folder):
        from ..libvirt_stop import confirm_stopped
        return confirm_stopped(machine, folder, self._lease_location_matches)

    def remove_owned_storage(self, machine, image, folder, request_id):
        from ..libvirt_removal import remove_storage
        return remove_storage(machine, folder, request_id, self._lease_location_matches)

    def stop_for_cleanup(self, machine, image, folder):
        """Fence under the caller's exclusive assignment gate; never prepare."""
        from ..libvirt_reboot import fence_cleanup
        if machine.get('desired') != 'stopped' or machine.get('lease', {}).get('state') not in ('released', 'expired', 'failed'):
            raise Error('Libvirt cleanup fencing requires a terminal stopped lease.', 409)
        self._reap_supervisors()
        fence_cleanup(machine, folder, self._lease_authorization(image), self._lease_location_matches)
        stopped = self.confirm_execution_stopped(machine, folder)
        return {'state': 'stopped' if stopped is not None else 'stopping', 'leaseFenced': True}

    def refresh_execution(self, machine, image, folder, authorization):
        from ..libvirt_execution import inspect_execution, publish, supervisor_alive
        from ..libvirt_supervision import SupervisorJournal
        self._reap_supervisors()
        current = inspect_execution(machine, folder)
        if current is None: return None
        binding, spec, execution, launch_record = current
        ended = execution.get('phase') == 'fenced' or not self._lease_location_matches(binding, spec)
        if execution.get('phase') == 'running':
            try: state = SupervisorJournal(folder, 'libvirt-launch')
            except BlockingIOError: pass # Parent is still publishing the child's birth.
            else:
                try: ended = ended or not supervisor_alive(binding, folder, state.read())
                finally: state.close()
        result = publish(machine, folder, authorization, stopping=machine['desired']=='stopped' or ended)
        if result['fenced']:
            if self.confirm_execution_stopped(machine, folder) is not None:
                return {'state': 'stopped', 'leaseFenced': True, 'detail': 'Owned libvirt execution stopped; storage handles and erasure remain unverified.'}
            return {'state': 'stopping', 'leaseFenced': True, 'detail': 'Libvirt execution authorization ended; positive native stop and cleanup remain pending.'}
        return None

    def _reconcile_lease(self, machine, image, folder):
        from ..libvirt_execution import inspect_execution, publish, supervisor_alive, valid_authorization
        from ..libvirt_supervision import validate_domain_xml
        self._reap_supervisors()
        authorization = self._lease_authorization(image)
        current = inspect_execution(machine, folder)
        if current is None:
            if machine['desired'] == 'stopped':
                return {'state': 'unknown', 'leaseFenced': True, 'detail': 'Libvirt leased execution history is missing; no native resource was adopted.'}
            value = authorization()
            if (not valid_authorization(value, machine['lease']['id']) or value['fenced']
                    or value['remainingSeconds'] <= 0):
                raise Error('Libvirt execution was fenced before preparation.', 410)
            self._prepare_lease(machine, image, folder)
            current = inspect_execution(machine, folder)
        binding, spec, execution, launch_record = current
        if not self._lease_location_matches(binding, spec):
            publish(machine, folder, authorization, stopping=True)
            return {'state': 'unknown', 'leaseFenced': True, 'detail': 'Libvirt runtime location changed; the previous owned execution was fenced.'}
        value = publish(machine, folder, authorization, stopping=machine['desired']=='stopped')
        if value['fenced'] or execution.get('phase') == 'fenced':
            if self.confirm_execution_stopped(machine, folder) is not None:
                return {'state': 'stopped', 'leaseFenced': True, 'detail': 'Owned libvirt execution stopped; storage handles and erasure remain unverified.'}
            return {'state': 'stopping', 'leaseFenced': True, 'detail': 'Libvirt supervisor is fenced; positive native reclamation is still required.'}
        validate_domain_xml(self.virsh('dumpxml', machine['id']), binding)
        state = self.virsh('domstate', machine['id']).lower()
        if launch_record is None:
            if execution.get('phase') != 'prepared' or state != 'shut off':
                raise Error('Libvirt leased launch is not a fresh inactive owned boot.', 409)
            self.start_lease_supervisor(machine, folder)
            return {'state': 'starting', 'detail': 'Owned libvirt lease supervisor launch requested.'}
        if execution.get('phase') == 'running':
            if state == 'running' and supervisor_alive(binding, folder, launch_record): return {'state': 'running'}
            publish(machine, folder, authorization, stopping=True)
            return {'state': 'unknown', 'leaseFenced': True, 'detail': 'Libvirt native owner or execution changed; no new launch was attempted.'}
        return {'state': 'unknown' if execution.get('phase') == 'running' else 'starting',
                'detail': 'Libvirt supervisor outcome is pending or uncertain; native launch is never replayed.'}

    def virsh(self, *args):
        return run(["virsh", "--connect", self.config.get("uri", "qemu:///system"), *args])

    def check(self):
        if platform.system() != "Linux":
            raise Error("The libvirt provider runs on Linux hosts.")
        if self.config.get("uri", "qemu:///system") not in ("qemu:///system", "qemu:///session"):
            raise Error("Use a local libvirt connection; offer remote hosts through their own agents.")
        self.local_templates({"linux", "windows"})
        self.virsh("domcapabilities", "--virttype", "kvm")
        run(["qemu-img", "--version"])

    def reconcile(self, machine, image, folder):
        if machine.get('lease'):
            from ..assignment_gate import assignment_access
            from ..libvirt_supervision import SupervisorJournal
            with assignment_access(machine, folder):
                state = SupervisorJournal(folder, 'libvirt-reconcile')
                try: return self._reconcile_lease(machine, image, folder)
                finally: state.close()
        name = self.name(machine)
        names = self.virsh("list", "--all", "--name").splitlines()
        if name not in names:
            if machine["desired"] == "stopped":
                return {"state": "stopped"}
            path = self.storage(machine)
            image = {**image, "_seedISO": ensure_seed(image, machine, path)}
            disk = path / "disk.qcow2"
            if disk.exists():
                raise Error("A disk exists without its domain. Inspect this partial creation; it will not be overwritten.")
            info = json.loads(run(["qemu-img", "info", "--output=json", image["image"]]))
            if info["virtual-size"] > machine["resources"]["diskGiB"] * 1073741824:
                raise Error("Requested disk is smaller than the template.")
            if info["format"] not in ("qcow2", "raw") or info.get("backing-filename"):
                raise Error("Use a standalone raw or QCOW2 base image.")
            run(["qemu-img", "create", "-f", "qcow2", "-F", info["format"], "-b", image["image"], disk, str(machine["resources"]["diskGiB"]) + "G"])
            definition = path / "domain.xml"
            definition.write_bytes(domain_xml(machine, image, disk))
            self.virsh("define", definition)
        if self.virsh("domuuid", name).lower() != machine["id"]:
            raise Error("Existing domain identity does not match the assignment.")
        expected_disk = self.storage(machine) / "disk.qcow2"
        definition = ET.fromstring(self.virsh("dumpxml", name))
        sources = [element.get("file") for element in definition.findall("devices/disk/source")]
        if str(expected_disk) not in sources or not expected_disk.exists():
            raise Error("Existing domain does not use this assignment's owned disk.")
        state = self.virsh("domstate", name).lower()
        if machine["desired"] == "running" and state == "shut off":
            self.virsh("start", name)
            return {"state": "starting"}
        if machine["desired"] == "stopped":
            if state == "shut off":
                return {"state": "stopped"}
            self.virsh("shutdown", name)
            return {"state": "stopping", "detail": "Graceful shutdown requested; disk and placement retained."}
        return {"state": "running" if state == "running" else "unknown", "detail": "Use virsh console " + name if image["mode"] == "headless" else "Use virsh domdisplay " + name + "; VNC listens on host loopback."}
