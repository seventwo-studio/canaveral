"""One-use libvirt lease supervision component; production wiring stays gated.

Injected connections/fences support isolated tests. Native use requires a
dedicated Linux child process, the compiled kernel deadline shim and a new
connection used exclusively for this owned domain. No public configuration,
enrollment, provider launch or lease eligibility is enabled here.
"""
import ctypes
import json
import math
import os
import stat
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from .lease_clock import execution_monotonic
from .model import Error, digest, identifier

NAMESPACE = 'urn:canaveral:libvirt:lease:1'
MAX_INTEGER = 2**53-1


def finite(value):
    return type(value) in (int, float) and 0 <= value <= MAX_INTEGER and math.isfinite(value)


def matches_identity(value, expected):
    return isinstance(value, dict) and all(type(value.get(key)) is type(item) and value[key] == item
                                          for key, item in expected.items())


@dataclass(frozen=True)
class LibvirtLeaseBinding:
    machine_id: str
    lease_id: str
    boot_id: str
    host_boot_id: str
    fingerprint: str
    disk: str

    def __post_init__(self):
        for key in ('machine_id', 'lease_id', 'boot_id', 'host_boot_id'):
            if identifier(getattr(self, key)) != getattr(self, key):
                raise Error('Libvirt supervision requires canonical ownership identities.', 409)
        if (not isinstance(self.fingerprint, str) or len(self.fingerprint) != 64
                or any(c not in '0123456789abcdef' for c in self.fingerprint)
                or not isinstance(self.disk, str) or '\0' in self.disk
                or not Path(self.disk).is_absolute() or str(Path(self.disk)) != self.disk
                or '..' in Path(self.disk).parts):
            raise Error('Libvirt supervision ownership is invalid.', 409)

    def identity(self):
        return {'version': 1, 'machineId': self.machine_id, 'leaseId': self.lease_id,
                'bootId': self.boot_id, 'hostBootId': self.host_boot_id,
                'fingerprint': self.fingerprint, 'diskBinding': digest(self.disk)}

    def metadata(self):
        return {key: str(value) for key, value in self.identity().items()}


def bind_domain_xml(xml, binding):
    """Prepare a new definition only; never writes to or adopts a live domain."""
    root = ET.fromstring(xml)
    if root.tag != 'domain' or identifier(root.findtext('uuid')) != binding.machine_id:
        raise Error('Libvirt definition identity differs.', 409)
    metadata = root.find('metadata')
    if metadata is None: metadata = ET.SubElement(root, 'metadata')
    if metadata.find('{'+NAMESPACE+'}owner') is not None:
        raise Error('Libvirt lease ownership cannot be rebound.', 409)
    ET.SubElement(metadata, '{'+NAMESPACE+'}owner', binding.metadata())
    return ET.tostring(root, encoding='unicode')


def validate_domain_xml(xml, binding):
    if not isinstance(xml, str) or len(xml.encode('utf-8')) > 1048576:
        raise Error('Libvirt definition exceeds its ownership envelope.', 409)
    root = ET.fromstring(xml)
    owners = root.findall('metadata/{'+NAMESPACE+'}owner')
    if (root.tag != 'domain' or identifier(root.findtext('uuid')) != binding.machine_id
            or root.findtext('name') != 'cvm-'+binding.machine_id
            or len(owners) != 1 or owners[0].attrib != binding.metadata()):
        raise Error('Libvirt domain is not bound to this lease boot.', 409)
    disks = root.findall('devices/disk')
    primary = [d for d in disks if d.get('device') == 'disk']
    if (len(primary) != 1 or primary[0].get('type') != 'file'
            or primary[0].find('source') is None
            or primary[0].find('source').attrib != {'file': binding.disk}):
        raise Error('Libvirt domain does not use its one owned disk.', 409)
    for disk in disks:
        if disk is primary[0]: continue
        source = disk.find('source')
        path = None if source is None else source.get('file')
        if (disk.get('device') != 'cdrom' or disk.get('type') != 'file' or disk.find('readonly') is None
                or not isinstance(path, str) or Path(path).parent != Path(binding.disk).parent
                or '..' in Path(path).parts):
            raise Error('Libvirt lease has an unbound additional disk.', 409)
    if root.find('devices/filesystem') is not None or root.find('devices/hostdev') is not None:
        raise Error('Libvirt lease passthrough ownership is not implemented.', 409)
    storage = Path(binding.disk).parent
    nvram = root.findall('os/nvram')
    if len(nvram) > 1 or any((node.text or '').strip() != str(storage/'nvram.fd') or node.find('source') is not None for node in nvram):
        raise Error('Libvirt firmware state is outside the owned lease directory.', 409)
    # Varstore is a separate writable firmware backend, not a synonym for the
    # selected pflash path. It needs its own implemented ownership contract.
    if root.find('os/varstore') is not None:
        raise Error('Libvirt varstore ownership is not implemented.', 409)
    tpms = root.findall('devices/tpm')
    if len(tpms) > 1: raise Error('Multiple lease TPM backends are unsupported.', 409)
    for tpm in tpms:
        backend = tpm.find('backend')
        source = None if backend is None else backend.find('source')
        if (backend is None or backend.get('type') != 'emulator' or backend.get('persistent_state') != 'yes'
                or source is None or source.attrib != {'type': 'dir', 'path': str(storage/'tpm-state')}
                or backend.find('encryption') is not None):
            raise Error('Libvirt TPM state is not bound to its owned lease directory.', 409)


class SupervisorJournal:
    """Private durable record with a process-lifetime lock; lost history refuses start."""
    def __init__(self, folder, prefix='libvirt-execution'):
        import fcntl
        if prefix not in ('libvirt-execution', 'libvirt-binding', 'libvirt-authorization', 'libvirt-launch', 'libvirt-reconcile', 'libvirt-reboot', 'deletion'):
            raise Error('Invalid private supervisor record kind.', 409)
        self.record = prefix+'.json'
        self.folder = Path(folder); self.fd = None
        info = self.folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Error('Libvirt supervisor requires a private owned state directory.', 409)
        self.inode = (info.st_dev, info.st_ino)
        self.directory = os.open(self.folder, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        fd = None
        try:
            if (os.fstat(self.directory).st_dev, os.fstat(self.directory).st_ino) != self.inode:
                raise Error('Libvirt supervisor state directory changed.', 409)
            fd = os.open(prefix+'.lock', os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC, 0o600, dir_fd=self.directory)
            self._regular(fd)
            fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.fd = fd
        except BaseException:
            if fd is not None: os.close(fd)
            os.close(self.directory); raise

    @staticmethod
    def _regular(fd):
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise Error('Libvirt supervisor record must be private and regular.', 409)

    def _check(self):
        info = self.folder.lstat()
        if (self.fd is None or not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != self.inode
                or info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise Error('Libvirt supervisor state directory changed.', 409)

    def read(self):
        return self.read_named(self.record)

    def read_named(self, name):
        if name not in ('assignment.json', 'libvirt-execution.json', 'libvirt-binding.json', 'libvirt-authorization.json', 'libvirt-launch.json', 'libvirt-reconcile.json', 'libvirt-reboot.json', 'deletion.json'):
            raise Error('Invalid private supervisor read.', 409)
        self._check()
        try: fd = os.open(name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC, dir_fd=self.directory)
        except FileNotFoundError: return None
        try:
            self._regular(fd); data = os.read(fd, 16385)
            if len(data) > 16384: raise Error('Libvirt supervisor journal is oversized.', 409)
            value = json.loads(data)
            if not isinstance(value, dict): raise Error('Libvirt supervisor journal is malformed.', 409)
            return value
        finally: os.close(fd)

    def write(self, value):
        self._check(); self.read()  # Refuse foreign, linked or malformed prior state.
        data = json.dumps(value, allow_nan=False).encode('utf-8')
        if len(data) > 16384: raise Error('Libvirt supervisor journal is oversized.', 409)
        temporary = '.libvirt-execution-'+str(uuid.uuid4())
        fd = os.open(temporary, os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC, 0o600, dir_fd=self.directory)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            os.replace(temporary, self.record, src_dir_fd=self.directory, dst_dir_fd=self.directory)
            os.fsync(self.directory); self._check()
        finally:
            try: os.unlink(temporary, dir_fd=self.directory)
            except FileNotFoundError: pass

    def prepare(self, binding):
        if self.read() is not None: raise Error('Libvirt launch history already exists; it cannot be reset.', 409)
        self.write({**binding.identity(), 'phase': 'prepared'})

    def close(self):
        if self.fd is not None:
            os.close(self.fd); self.fd = None; os.close(self.directory)


class LinuxKernelDeadline:
    """Fatal timer for a dedicated child, never the administrative runner process."""
    def __init__(self, library, expected_parent):
        if not sys.platform.startswith('linux') or type(expected_parent) is not int or expected_parent != os.getppid() or expected_parent <= 1:
            raise Error('Kernel lease fencing requires its dedicated Linux child process.', 409)
        self.library = ctypes.CDLL(str(library), use_errno=True)
        self.library.canaveral_lease_deadline_install.argtypes = [ctypes.c_int64]
        self.library.canaveral_lease_deadline_install.restype = ctypes.c_int
        self.library.canaveral_lease_deadline_arm.argtypes = [ctypes.c_int64, ctypes.c_int32]
        self.library.canaveral_lease_deadline_arm.restype = ctypes.c_int
        if self.library.canaveral_lease_deadline_install(expected_parent) != 0:
            raise Error('Native kernel lease fencing could not be installed.', 409)

    def arm(self, deadline):
        if not finite(deadline) or deadline <= 0: raise Error('Invalid native kernel lease deadline.', 409)
        seconds = math.floor(deadline); nanoseconds = math.floor((deadline-seconds)*1_000_000_000)
        if self.library.canaveral_lease_deadline_arm(seconds, nanoseconds) != 0:
            raise Error('Native kernel lease deadline could not be armed.', 409)


class NativeLibvirtConnection:
    """A dedicated local C API connection with explicitly freed domain handles.

The component never destroys by UUID after losing its owner. Closing this
connection lets libvirt retire only the execution it auto-destroy-bound here.
"""
    def __init__(self, uri, machine_id, _library=None):
        if uri not in ('qemu:///system', 'qemu:///session'):
            raise Error('Libvirt lease supervision requires a local connection.', 409)
        if _library is None and not sys.platform.startswith('linux'):
            raise Error('Native libvirt lease supervision requires Linux.', 409)
        self.machine_id = identifier(machine_id); self.library = _library or ctypes.CDLL('libvirt.so.0')
        self.connection = None; self.attempted = False; self.resumed = False
        signatures = {
            'virConnectOpen': ([ctypes.c_char_p], ctypes.c_void_p),
            'virConnectClose': ([ctypes.c_void_p], ctypes.c_int),
            'virConnectIsAlive': ([ctypes.c_void_p], ctypes.c_int),
            'virConnectGetType': ([ctypes.c_void_p], ctypes.c_char_p),
            'virDomainLookupByUUIDString': ([ctypes.c_void_p, ctypes.c_char_p], ctypes.c_void_p),
            'virDomainGetXMLDesc': ([ctypes.c_void_p, ctypes.c_uint], ctypes.c_void_p),
            'virDomainGetUUIDString': ([ctypes.c_void_p, ctypes.c_char_p], ctypes.c_int),
            'virDomainGetState': ([ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.c_uint], ctypes.c_int),
            'virDomainIsActive': ([ctypes.c_void_p], ctypes.c_int),
            'virDomainHasManagedSaveImage': ([ctypes.c_void_p, ctypes.c_uint], ctypes.c_int),
            'virDomainSnapshotNum': ([ctypes.c_void_p, ctypes.c_uint], ctypes.c_int),
            'virDomainListAllCheckpoints': ([ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint], ctypes.c_int),
            'virDomainCreateWithFlags': ([ctypes.c_void_p, ctypes.c_uint], ctypes.c_int),
            'virDomainResume': ([ctypes.c_void_p], ctypes.c_int),
            'virDomainFree': ([ctypes.c_void_p], ctypes.c_int),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.library, name); function.argtypes = args; function.restype = result
        self.free = ctypes.CDLL(None).free; self.free.argtypes = [ctypes.c_void_p]; self.free.restype = None
        handle = self.library.virConnectOpen(uri.encode('ascii'))
        if not handle: raise Error('Native libvirt supervision connection failed.', 409)
        self.connection = handle
        try:
            if self.library.virConnectGetType(handle) != b'QEMU':
                raise Error('This supervisor requires the QEMU libvirt driver.', 409)
        except BaseException: self.close(); raise

    def _domain(self, action):
        if self.connection is None or self.library.virConnectIsAlive(self.connection) != 1:
            raise Error('Native libvirt connection ended.', 409)
        domain = self.library.virDomainLookupByUUIDString(self.connection, self.machine_id.encode('ascii'))
        if not domain: raise Error('The bound libvirt domain is unavailable.', 409)
        try: return action(domain)
        finally:
            if self.library.virDomainFree(domain) != 0:
                raise Error('Native libvirt domain-handle release was not confirmed.', 409)

    def _validate_domain(self, domain, binding, active, paused=None):
        identity = ctypes.create_string_buffer(37)
        if self.library.virDomainGetUUIDString(domain, identity) != 0 or identity.value.decode('ascii').lower() != binding.machine_id:
            raise Error('Native libvirt domain identity differs.', 409)
        xml = self.library.virDomainGetXMLDesc(domain, 0)
        if not xml: raise Error('Native libvirt ownership XML is unavailable.', 409)
        try: validate_domain_xml(ctypes.string_at(xml).decode('utf-8'), binding)
        finally: self.free(xml)
        if self.library.virDomainIsActive(domain) != int(active):
            raise Error('Native libvirt execution state differs.', 409)
        state, reason = ctypes.c_int(), ctypes.c_int()
        if self.library.virDomainGetState(domain, ctypes.byref(state), ctypes.byref(reason), 0) != 0:
            raise Error('Native libvirt runtime state is unavailable.', 409)
        expected = 5 if not active else 3 if paused else 1 # SHUTOFF, PAUSED, RUNNING.
        if state.value != expected: raise Error('Native libvirt runtime phase differs.', 409)
        if not active and any(function(domain, 0) != 0 for function in (
                self.library.virDomainHasManagedSaveImage, self.library.virDomainSnapshotNum)):
            raise Error('Libvirt saved execution or snapshot state must be resolved before leased boot.', 409)
        if not active and self.library.virDomainListAllCheckpoints(domain, None, 0) != 0:
            raise Error('Libvirt checkpoint state must be resolved before leased boot.', 409)

    def validate(self, binding, active, paused=None):
        self._domain(lambda domain: self._validate_domain(domain, binding, active, paused))

    def _teardown_api(self):
        for name, args, result in (
                ('virDomainUndefineFlags', [ctypes.c_void_p, ctypes.c_uint], ctypes.c_int),
                ('virDomainIsPersistent', [ctypes.c_void_p], ctypes.c_int),
                ('virGetLastErrorCode', [], ctypes.c_int),
                ('virResetLastError', [], None)):
            function = getattr(self.library, name); function.argtypes = args; function.restype = result

    def absent(self):
        self._teardown_api()
        if self.connection is None or self.library.virConnectIsAlive(self.connection) != 1:
            raise Error('Native libvirt connection ended.', 409)
        self.library.virResetLastError()
        domain = self.library.virDomainLookupByUUIDString(self.connection, self.machine_id.encode('ascii'))
        if domain:
            if self.library.virDomainFree(domain) != 0:
                raise Error('Native libvirt domain-handle release was not confirmed.', 409)
            return False
        # A failed RPC/permission lookup is not evidence of an absent domain.
        if self.library.virGetLastErrorCode() != 42: # VIR_ERR_NO_DOMAIN.
            raise Error('Native libvirt domain absence is unconfirmed.', 409)
        return True

    def retire(self, binding):
        self._teardown_api()
        def retire(domain):
            self._validate_domain(domain, binding, active=False)
            if self.library.virDomainIsPersistent(domain) != 1:
                raise Error('Owned libvirt definition is not persistent.', 409)
            # Keep owned firmware/TPM files for the guarded filesystem eraser.
            # Never request deletion of unowned saved/snapshot/checkpoint state.
            if self.library.virDomainUndefineFlags(domain, 8|64) != 0:
                raise Error('Owned libvirt definition retirement is unconfirmed.', 409)
        self._domain(retire)
        # Undefining an active domain makes it transient instead of stopping it.
        # Require UUID absence after releasing the old handle; querying that old
        # inactive handle can itself fail once the definition has disappeared.
        if not self.absent(): raise Error('Libvirt definition remains after retirement.', 409)

    def start_paused(self):
        if self.attempted: raise Error('Native libvirt create will not be replayed.', 409)
        self.attempted = True
        if self._domain(lambda domain: self.library.virDomainCreateWithFlags(domain, 1|2)) != 0:
            raise Error('Native libvirt paused auto-destroy launch is unconfirmed.', 409)

    def resume(self):
        if not self.attempted or self.resumed: raise Error('Native libvirt resume is not a fresh owned transition.', 409)
        self.resumed = True
        if self._domain(self.library.virDomainResume) != 0:
            raise Error('Native libvirt resume is unconfirmed.', 409)

    def close(self):
        handle, self.connection = self.connection, None
        if handle is not None and self.library.virConnectClose(handle) != 0:
            raise Error('Native libvirt connection release is unconfirmed.', 409)


class LibvirtLeaseSupervisor:
    def __init__(self, binding, journal, authorization, ownership, host_boot, connect, fence, clock=execution_monotonic):
        self.binding, self.journal, self.authorization = binding, journal, authorization
        self.ownership, self.host_boot, self.connect, self.fence, self.clock = ownership, host_boot, connect, fence, clock
        self.connection = None; self.phase = 'new'; self.revision = 0; self.deadline = None; self.last_clock = None
        self.admitted = False

    def _write(self, phase, reason=None):
        previous = self.journal.read()
        if not matches_identity(previous, self.binding.identity()):
            raise Error('Libvirt supervisor journal ownership changed.', 409)
        value = {**self.binding.identity(), 'phase': phase, 'revision': self.revision, 'deadline': self.deadline}
        if reason is not None: value['reason'] = reason
        if previous != value: self.journal.write(value)
        self.phase = phase

    def _authorize(self):
        now = self.clock()
        if (not finite(now) or (self.last_clock is not None and now < self.last_clock)
                or (self.deadline is not None and now >= self.deadline)):
            raise Error('Libvirt execution deadline ended or its clock changed.', 410)
        self.last_clock = now
        if self.host_boot() != self.binding.host_boot_id or self.ownership() is not True:
            raise Error('Libvirt execution ownership changed.', 409)
        value = self.authorization(); expected = self.binding.identity()
        if (not isinstance(value, dict) or set(value) != set(expected)|{'revision', 'deadline', 'fenced'}
                or not matches_identity(value, expected)
                or type(value.get('revision')) is not int or not 1 <= value['revision'] <= MAX_INTEGER
                or value['revision'] < self.revision or not finite(value.get('deadline'))
                or type(value.get('fenced')) is not bool or value['fenced']):
            raise Error('Libvirt execution authorization is invalid or fenced.', 410)
        deadline = value['deadline']
        if value['revision'] == self.revision and self.deadline is not None: deadline = min(deadline, self.deadline)
        # Reading metadata/ownership may itself be slow. Never resume using a
        # sample taken before those operations, nor allow a late renewal.
        after = self.clock()
        if not finite(after) or after < now or after >= deadline or (self.deadline is not None and after >= self.deadline):
            raise Error('Libvirt authorization expired during validation.', 410)
        self.last_clock = after; self.revision = value['revision']; self.deadline = deadline
        self.fence.arm(deadline)

    def start(self):
        if self.phase != 'new': raise Error('Libvirt supervision cannot restart a launch.', 409)
        saved = self.journal.read()
        if not matches_identity(saved, self.binding.identity()) or saved != {**self.binding.identity(), 'phase': 'prepared'}:
            self.phase = 'fenced'
            raise Error('Libvirt supervision requires its unused durable preparation receipt.', 409)
        self.admitted = True
        try:
            self._authorize(); self._write('starting')
            self.connection = self.connect()
            self.connection.validate(self.binding, active=False)
            self._authorize(); self._write('creating')
            self.connection.start_paused() # Must use PAUSED | AUTODESTROY together.
            self._authorize(); self.connection.validate(self.binding, active=True, paused=True)
            self._authorize(); self._write('resuming')
            self.connection.resume()
            self._authorize(); self._write('running')
        except BaseException:
            self.close('startup-unconfirmed'); raise Error('Libvirt leased startup was not confirmed; it will not be replayed.', 409) from None

    def step(self):
        if self.phase != 'running': return False
        try:
            self._authorize()
            self.connection.validate(self.binding, active=True, paused=False)
            self._authorize(); self._write('running')
            return True
        except BaseException:
            self.close('authorization-or-runtime-ended'); return False

    def close(self, reason='supervisor-ended'):
        if self.phase == 'fenced': return
        if not self.admitted: self.phase = 'fenced'; return
        # Shorten the existing kernel deadline before close/persistence, so an
        # RPC blocked during revocation cannot consume the old lease duration.
        if self.deadline is not None:
            try:
                now = self.clock()
                if finite(now): self.fence.arm(min(self.deadline, now+.1))
            except Exception: pass # The previous kernel timer remains armed.
        # No receipt here claims positive runtime/storage reclamation.
        try: self._write('fenced', reason)
        except BaseException: self.phase = 'fenced'
        finally:
            connection, self.connection = self.connection, None
            if connection is not None:
                try: connection.close()
                except Exception: pass

    def run(self, wait=time.sleep):
        try:
            self.start()
            while self.step(): wait(.1)
        finally: self.close()
