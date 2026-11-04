"""Read-only libvirt/QMP and kernel-cgroup attribution; never adopt or signal."""
import ctypes
import json
import os
import re
import stat
import sys
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath

from .libvirt_execution import linux_boot_id
from .libvirt_supervision import NativeLibvirtConnection, finite, validate_domain_xml
from .model import Error, identifier
from .owned_removal import assignment_fingerprint
from .owned_usage import record


def unknown(): return Error('Assigned libvirt resource identity is unavailable.', 409)


class NativeResourceConnection(NativeLibvirtConnection):
    """Only the fixed, state-querying QMP command is exposed here."""
    def __init__(self, uri, machine_id, _library=None, _qemu=None):
        super().__init__(uri, machine_id, _library)
        self.qemu = _qemu
        self.length = ctypes.CDLL(None).strnlen
        self.length.argtypes = [ctypes.c_void_p, ctypes.c_size_t]; self.length.restype = ctypes.c_size_t

    def _text(self, pointer):
        if not pointer: raise unknown()
        size = self.length(pointer, 1048577)
        if size > 1048576: raise unknown()
        return ctypes.string_at(pointer, size).decode('utf-8')

    def snapshot(self):
        def sample(domain):
            identity = ctypes.create_string_buffer(37)
            if self.library.virDomainGetUUIDString(domain, identity) != 0 or identity.value.decode('ascii') != self.machine_id:
                raise unknown()
            pointer = self.library.virDomainGetXMLDesc(domain, 0)
            try: xml = self._text(pointer)
            finally:
                if pointer: self.free(pointer)
            active = self.library.virDomainIsActive(domain)
            state, reason = ctypes.c_int(), ctypes.c_int()
            if active not in (0, 1) or self.library.virDomainGetState(domain, ctypes.byref(state), ctypes.byref(reason), 0) != 0:
                raise unknown()
            if not active:
                if state.value != 5: raise unknown()
                return {'xml': xml, 'active': False, 'id': None, 'threads': []}
            if state.value not in (1, 3): raise unknown() # Running or paused still consumes host resources.
            get_id = self.library.virDomainGetID
            get_id.argtypes = [ctypes.c_void_p]; get_id.restype = ctypes.c_uint
            native_id = get_id(domain)
            if type(native_id) is not int or not 0 < native_id < 0xffffffff: raise unknown()
            if self.qemu is None: self.qemu = ctypes.CDLL('libvirt-qemu.so.0')
            query = self.qemu.virDomainQemuMonitorCommand
            query.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint]
            query.restype = ctypes.c_int
            response = ctypes.c_void_p()
            try:
                if query(domain, b'{"execute":"query-cpus-fast"}', ctypes.byref(response), 0) != 0: raise unknown()
                value = json.loads(self._text(response))
            finally:
                if response.value: self.free(response)
            if (not isinstance(value, dict) or set(value)-{'return','id'} or
                    not isinstance(value.get('return'), list)): raise unknown()
            threads = set(); indices = set()
            for cpu in value['return']:
                tid = cpu.get('thread-id') if isinstance(cpu, dict) else None
                index = cpu.get('cpu-index') if isinstance(cpu, dict) else None
                if type(tid) is not int or tid <= 1 or type(index) is not int or index < 0 or index in indices: raise unknown()
                threads.add(tid); indices.add(index)
            if not threads: raise unknown()
            return {'xml': xml, 'active': True, 'id': native_id, 'threads': sorted(threads)}
        return self._domain(sample)


def _read(path, limit=65536):
    fd = os.open(path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): raise unknown()
        with os.fdopen(fd, 'rb', closefd=False) as stream: data = stream.read(limit+1)
        if len(data) > limit: raise unknown()
        return data.decode('utf-8')
    finally: os.close(fd)


class LinuxDomainCgroup:
    def __init__(self):
        if sys.platform != 'linux': raise unknown()
        self.proc = Path('/proc'); self.root = Path('/sys/fs/cgroup')

    def mount(self):
        matches = []
        for line in _read(self.proc/'self'/'mountinfo', 1048576).splitlines():
            fields = line.split(); separator = fields.index('-') if '-' in fields else -1
            if separator > 5 and fields[separator+1] == 'cgroup2':
                mountpoint = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[4])
                if mountpoint == str(self.root) and fields[3] == '/': matches.append(line)
        if len(matches) != 1: raise unknown()

    def tgid(self, tid):
        matches = re.findall(r'^Tgid:\s*([0-9]+)\s*$', _read(self.proc/str(tid)/'status'), re.MULTILINE)
        if len(matches) != 1 or int(matches[0]) <= 1: raise unknown()
        return int(matches[0])

    def membership(self, pid):
        matches = [line[3:] for line in _read(self.proc/str(pid)/'cgroup').splitlines() if line.startswith('0::')]
        if len(matches) != 1: raise unknown()
        path = PurePosixPath(matches[0])
        if not path.is_absolute() or str(path) != matches[0] or '..' in path.parts or '\0' in matches[0]: raise unknown()
        return path

    def domain(self, pid, native_id, name):
        self.mount(); path = self.membership(pid); candidates = []
        for index, part in enumerate(path.parts):
            decoded = re.sub(r'\\x([0-9a-fA-F]{2})', lambda m: chr(int(m[1], 16)), part)
            prefix = 'machine-qemu-'+str(native_id)+'-'
            systemd = (decoded.startswith(prefix) and decoded.endswith('.scope') and
                       decoded[len(prefix):-6] and name.startswith(decoded[len(prefix):-6]))
            other = part == 'qemu-'+str(native_id)+'-'+name+'.libvirt-qemu'
            if systemd or other: candidates.append(PurePosixPath(*path.parts[:index+1]))
        if len(candidates) != 1: raise unknown()
        domain = candidates[0]
        location = self.root.joinpath(*domain.parts[1:])
        # Every component is pinned to the same cgroup mount and cannot be a
        # symlink. The native/QMP anchor, not the directory name, proves scope.
        base = self.root.lstat(); current = self.root
        if not stat.S_ISDIR(base.st_mode): raise unknown()
        for part in domain.parts[1:]:
            current = current/part; value = current.lstat()
            if not stat.S_ISDIR(value.st_mode) or value.st_dev != base.st_dev: raise unknown()
        value = location.lstat()
        return domain, (value.st_dev, value.st_ino)

    def members(self, domain, identity):
        location = self.root.joinpath(*domain.parts[1:]); result = set(); directories = []
        def walk(path):
            value = path.lstat()
            if not stat.S_ISDIR(value.st_mode) or value.st_dev != identity[0]: raise unknown()
            directories.append((path, value.st_ino))
            kind = _read(path/'cgroup.type').strip()
            if kind not in ('domain', 'domain threaded', 'threaded'): raise unknown()
            if kind != 'threaded':
                fd = os.open(path/'cgroup.procs', os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
                with os.fdopen(fd, 'r', encoding='ascii') as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise unknown()
                    while True:
                        line = stream.readline(64)
                        if not line: break
                        if len(line) == 64 or not line.strip().isdigit() or int(line) <= 1: raise unknown()
                        result.add(int(line))
            # Threaded domains list every subtree process in their own procs;
            # children are still inspected for namespace/type/inode changes.
            for child in path.iterdir():
                mode = child.lstat().st_mode
                if stat.S_ISLNK(mode): raise unknown()
                if stat.S_ISDIR(mode): walk(child)
        walk(location)
        if (location.lstat().st_dev, location.lstat().st_ino) != identity: raise unknown()
        for path, inode in directories:
            if path.lstat().st_ino != inode: raise unknown()
        return result

    def contains(self, pid, domain, identity):
        location = self.root.joinpath(*domain.parts[1:]); value = location.lstat()
        member = self.membership(pid)
        return (stat.S_ISDIR(value.st_mode) and (value.st_dev, value.st_ino) == identity
                and (member == domain or domain in member.parents))


class BoundProcess:
    def __init__(self, process, verify): self.process = process; self.verify = verify
    def __getattr__(self, key): return getattr(self.process, key)
    def verify_resource_identity(self): self.verify()


def processes(provider, machine, image, folder, psutil, connection_factory=NativeResourceConnection,
              kernel_factory=LinuxDomainCgroup, host_boot=linux_boot_id):
    storage = Path(provider.config['storage']).resolve()/identifier(machine['id'])
    fingerprint = assignment_fingerprint(machine); assignment = Path(folder)/'assignment.json'
    if storage.is_symlink() or Path(folder).is_symlink(): raise unknown()
    before = (record(assignment), record(storage/'canaveral-owner.json'))
    if any(value.get('fingerprint') != fingerprint for value in before): raise unknown()
    binding = None; spec = None
    boot = identifier(host_boot())
    if machine.get('lease'):
        from .libvirt_execution import read_spec
        # Read-only metadata access: no runtime or journal locks/creation.
        class Reader:
            def read_named(self, name): return record(Path(folder)/name)
            def _check(self):
                if Path(folder).is_symlink(): raise unknown()
        binding, spec = read_spec(Reader(), machine)
        if binding.host_boot_id != boot or not provider._lease_location_matches(binding, spec): raise unknown()
    connection = connection_factory(provider.config.get('uri', 'qemu:///system'), machine['id'])
    try:
        snapshot = connection.snapshot(); root = ET.fromstring(snapshot['xml'])
        if root.findtext('name') != provider.name(machine) or identifier(root.findtext('uuid')) != machine['id']: raise unknown()
        if binding is not None: validate_domain_xml(snapshot['xml'], binding)
        disks = [disk for disk in root.findall('devices/disk') if disk.find('readonly') is None]
        if (len(disks) != 1 or disks[0].get('type') != 'file' or disks[0].find('source') is None or
                disks[0].find('source').get('file') != str(storage/'disk.qcow2') or
                root.find('devices/filesystem') is not None or root.find('devices/hostdev') is not None): raise unknown()
        if not snapshot['active']:
            # SHUTOFF establishes no current QEMU execution, not that an
            # external TPM helper has exited. Do not invent its zero usage.
            if root.find('devices/tpm') is not None: raise unknown()
            if connection.snapshot() != snapshot: raise unknown()
            result = []
        else:
            emulator = root.findtext('devices/emulator')
            if not emulator or not Path(emulator).is_absolute(): raise unknown()
            kernel = kernel_factory(); tgids = {kernel.tgid(tid) for tid in snapshot['threads']}
            if len(tgids) != 1: raise unknown()
            pid = tgids.pop(); primary = psutil.Process(pid); born = primary.create_time()
            argv = primary.cmdline()
            if (not finite(born) or Path(primary.exe()).resolve() != Path(emulator).resolve() or
                    argv.count('-uuid') != 1 or argv[argv.index('-uuid')+1] != machine['id']): raise unknown()
            domain, identity = kernel.domain(pid, snapshot['id'], provider.name(machine))
            members = kernel.members(domain, identity)
            if pid not in members: raise unknown()
            last_member = max(members)

            def verify(member_pid, birth):
                if (identifier(host_boot()) != boot or psutil.Process(member_pid).create_time() != birth or
                        psutil.Process(pid).create_time() != born or not kernel.contains(member_pid, domain, identity)
                        or not kernel.contains(pid, domain, identity) or
                        Path(psutil.Process(pid).exe()).resolve() != Path(emulator).resolve() or
                        psutil.Process(pid).cmdline() != argv):
                    raise unknown()
                if member_pid == last_member and kernel.members(domain, identity) != members: raise unknown()
            result = []
            for member in sorted(members):
                process = psutil.Process(member); birth = process.create_time()
                if not finite(birth): raise unknown()
                verify(member, birth)
                result.append((BoundProcess(process, lambda p=member, b=birth: verify(p, b)), birth, 'virtualMachines'))
            if kernel.members(domain, identity) != members or connection.snapshot() != snapshot: raise unknown()
        if (identifier(host_boot()) != boot or (record(assignment), record(storage/'canaveral-owner.json')) != before): raise unknown()
        return result
    finally: connection.close()
