"""Private libvirt lease launch records and native authorization publication.

No enrollment or lease eligibility is enabled here. Native start is delegated to
one dedicated child, with a verified shim artifact and a one-use launch record.
"""
import dataclasses
import hashlib
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

from .lease_clock import execution_monotonic
from .libvirt_supervision import (MAX_INTEGER, LibvirtLeaseBinding, SupervisorJournal,
    finite, matches_identity)
from .model import Error, identifier
from .owned_removal import assignment_fingerprint


def linux_boot_id():
    if not sys.platform.startswith('linux'): raise Error('Libvirt lease execution requires Linux.', 409)
    fd = os.open('/proc/sys/kernel/random/boot_id', os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try: return identifier(os.read(fd, 128).decode('ascii').strip())
    finally: os.close(fd)


def _identity(path):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise Error('Libvirt lease disk must be a regular unlinked-alias-free file.', 409)
    return {'device': info.st_dev, 'inode': info.st_ino}


def _storage_identity(path):
    info = Path(path).lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise Error('Libvirt lease storage directory ownership is invalid.', 409)
    return {'device': info.st_dev, 'inode': info.st_ino}


def _owner(storage):
    directory = os.open(storage, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        fd = os.open('canaveral-owner.json', os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC, dir_fd=directory)
        try:
            SupervisorJournal._regular(fd); data = os.read(fd, 16385)
            if len(data) > 16384: raise Error('Libvirt storage marker is oversized.', 409)
            value = json.loads(data)
            if not isinstance(value, dict): raise Error('Libvirt storage marker is malformed.', 409)
            return value
        finally: os.close(fd)
    finally: os.close(directory)


def library_identity(path):
    path = Path(path)
    if not path.is_absolute(): raise Error('The native deadline library requires an absolute path.', 409)
    fd = os.open(path, os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
    try:
        return {'path': str(path), 'sha256': library_digest(fd)}
    finally: os.close(fd)


def library_digest(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > 8*1048576:
        raise Error('Native deadline library ownership or envelope is invalid.', 409)
    checksum = hashlib.sha256(); total = 0
    while True:
        block = os.read(fd, 65536)
        if not block: break
        total += len(block)
        if total > 8*1048576: raise Error('Native deadline artifact grew beyond its envelope.', 409)
        checksum.update(block)
    after = os.fstat(fd)
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if total != info.st_size or any(getattr(after, key) != getattr(info, key) for key in fields):
        raise Error('Native deadline artifact changed while being verified.', 409)
    return checksum.hexdigest()


def ownership(state, binding, spec):
    state._check()
    assignment = state.read_named('assignment.json')
    storage = Path(binding.disk).parent
    return bool(isinstance(assignment, dict) and assignment.get('fingerprint') == binding.fingerprint
        and assignment.get('leaseId') == binding.lease_id and storage.name == binding.machine_id
        and _storage_identity(storage) == spec['storageIdentity']
        and _identity(binding.disk) == spec['diskIdentity']
        and _owner(storage).get('fingerprint') == binding.fingerprint)


def read_binding(state, machine=None):
    """Read immutable metadata for teardown; does not prove storage ownership."""
    spec = state.read_named('libvirt-binding.json')
    if (not isinstance(spec, dict) or set(spec) != {'version', 'binding', 'uri', 'library', 'storageIdentity', 'diskIdentity'}
            or type(spec.get('version')) is not int or spec['version'] != 1
            or spec.get('uri') not in ('qemu:///system', 'qemu:///session')
            or not isinstance(spec.get('binding'), dict)):
        raise Error('Libvirt execution binding is missing or invalid.', 409)
    try: binding = LibvirtLeaseBinding(**spec['binding'])
    except (TypeError, ValueError): raise Error('Libvirt execution binding is malformed.', 409) from None
    for key in ('storageIdentity', 'diskIdentity'):
        value = spec[key]
        if (not isinstance(value, dict) or set(value) != {'device', 'inode'}
                or any(type(item) is not int or item < 0 for item in value.values())):
            raise Error('Libvirt storage birth identity is invalid.', 409)
    library = spec['library']
    if (not isinstance(library, dict) or set(library) != {'path', 'sha256'}
            or not isinstance(library.get('path'), str) or not Path(library['path']).is_absolute()
            or not isinstance(library.get('sha256'), str) or len(library['sha256']) != 64
            or any(c not in '0123456789abcdef' for c in library['sha256'])):
        raise Error('Libvirt deadline artifact binding is invalid.', 409)
    if machine is not None and (binding.machine_id != machine['id'] or binding.lease_id != machine['lease']['id']
            or binding.fingerprint != assignment_fingerprint(machine)):
        raise Error('Libvirt execution binding belongs to another assignment.', 409)
    assignment = state.read_named('assignment.json')
    if (not isinstance(assignment, dict) or assignment.get('fingerprint') != binding.fingerprint
            or assignment.get('leaseId') != binding.lease_id):
        raise Error('Libvirt assignment ownership changed.', 409)
    return binding, spec


def read_spec(state, machine=None):
    binding, spec = read_binding(state, machine)
    if not ownership(state, binding, spec): raise Error('Libvirt owned storage or assignment changed.', 409)
    return binding, spec


def inspect_execution(machine, folder):
    path = Path(folder)/'libvirt-binding.json'
    if not path.exists() and not path.is_symlink(): return None
    state = SupervisorJournal(folder, 'libvirt-binding')
    try:
        binding, spec = read_spec(state, machine)
        execution = state.read_named('libvirt-execution.json')
        launch_record = state.read_named('libvirt-launch.json')
        if not matches_identity(execution, binding.identity()):
            raise Error('Libvirt execution history is missing or belongs to another boot.', 409)
        if launch_record is not None and not matches_identity(launch_record, binding.identity()):
            raise Error('Libvirt launch history belongs to another boot.', 409)
        return binding, spec, execution, launch_record
    finally: state.close()


def valid_authorization(value, lease_id):
    return (isinstance(value, dict) and set(value) == {'leaseID', 'revision', 'remainingSeconds', 'fenced'}
        and value.get('leaseID') == lease_id and type(value.get('revision')) is int
        and 1 <= value['revision'] <= MAX_INTEGER and type(value.get('fenced')) is bool
        and finite(value.get('remainingSeconds')))


def supervisor_alive(binding, folder, launch_record):
    """Observe only the specifically recorded child; never signal recovered PIDs."""
    import psutil
    if (not matches_identity(launch_record, binding.identity()) or type(launch_record.get('pid')) is not int
            or launch_record['pid'] <= 0 or type(launch_record.get('parentPid')) is not int
            or launch_record['parentPid'] <= 1 or not finite(launch_record.get('createdAt'))):
        return False
    try:
        process = psutil.Process(launch_record['pid'])
        expected = ['-m', 'canaveral.libvirt_supervisor_child', '--state-directory', str(Path(folder).resolve()),
                    '--parent-pid', str(launch_record['parentPid'])]
        return (process.create_time() == launch_record['createdAt'] and process.uids().real == os.getuid()
                and process.ppid() == launch_record['parentPid']
                and Path(process.exe()).resolve() == Path(sys.executable).resolve()
                and process.cmdline()[1:] == expected and process.status() != psutil.STATUS_ZOMBIE)
    except psutil.NoSuchProcess: return False


def prepare(binding, folder, uri, library):
    """Bind already prepared owned storage; never defines or starts a domain."""
    state = SupervisorJournal(folder, 'libvirt-binding')
    try:
        if (state.read() is not None or any(state.read_named(name) is not None for name in (
                'libvirt-execution.json', 'libvirt-launch.json', 'libvirt-authorization.json'))):
            raise Error('Libvirt execution binding cannot adopt partial or previous history.', 409)
        spec = {'version': 1, 'binding': dataclasses.asdict(binding), 'uri': uri,
                'library': library_identity(library), 'storageIdentity': _storage_identity(Path(binding.disk).parent),
                'diskIdentity': _identity(binding.disk)}
        if uri not in ('qemu:///system', 'qemu:///session') or not ownership(state, binding, spec):
            raise Error('Libvirt preparation ownership or connection differs.', 409)
        # A partial binding/preparation never becomes an automatic retry.
        state.write(spec)
        journal = SupervisorJournal(folder)
        try: journal.prepare(binding)
        finally: journal.close()
        return spec
    finally: state.close()


def publish(machine, folder, authorization, stopping=False, clock=execution_monotonic, host_boot=linux_boot_id):
    state = SupervisorJournal(folder, 'libvirt-authorization')
    try:
        binding, spec = read_spec(state, machine)
        before = clock()
        if not finite(before) or host_boot() != binding.host_boot_id:
            raise Error('Libvirt native clock or host boot changed.', 409)
        value = authorization(); after = clock()
        if (not valid_authorization(value, binding.lease_id) or not finite(after) or after < before
                or host_boot() != binding.host_boot_id):
            raise Error('Libvirt deadline publication lacks valid local authorization.', 409)
        deadline = max(0, before+value['remainingSeconds']-.25)
        if not finite(deadline): raise Error('Libvirt native deadline exceeds its clock envelope.', 409)
        result = {**binding.identity(), 'revision': value['revision'], 'deadline': deadline,
                  'fenced': stopping or value['fenced'] or deadline <= after}
        previous = state.read()
        if previous is not None:
            if (not matches_identity(previous, binding.identity()) or set(previous) != set(result)
                    or type(previous.get('revision')) is not int or not 1 <= previous['revision'] <= MAX_INTEGER
                    or type(previous.get('fenced')) is not bool or not finite(previous.get('deadline'))
                    or result['revision'] < previous['revision']):
                raise Error('Libvirt native authorization history is invalid or newer.', 409)
            result['fenced'] = result['fenced'] or previous['fenced'] or before >= previous['deadline']
            if result['revision'] == previous['revision']: result['deadline'] = min(result['deadline'], previous['deadline'])
        if not ownership(state, binding, spec): raise Error('Libvirt ownership changed during publication.', 409)
        if previous != result: state.write(result)
        return result
    finally: state.close()


def launch(machine, folder, popen=subprocess.Popen, birth=None):
    state = SupervisorJournal(folder, 'libvirt-launch')
    try:
        binding, spec = read_spec(state, machine)
        if state.read() is not None: raise Error('Libvirt supervisor launch will not be replayed.', 409)
        prepared = state.read_named('libvirt-execution.json')
        if not matches_identity(prepared, binding.identity()) or prepared != {**binding.identity(), 'phase': 'prepared'}:
            raise Error('Libvirt supervisor preparation is not unused.', 409)
        if library_identity(spec['library']['path']) != spec['library']:
            raise Error('Libvirt deadline artifact changed before launch.', 409)
        value = {**binding.identity(), 'parentPid': os.getpid(), 'attemptedAt': time.time()}
        state.write(value)
        # Bare Popen is deliberate: a VM supervisor must not inherit the shared
        # helper gate needed by cleanup to revoke and observe it.
        fd = os.open('libvirt-supervisor.log', os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK, 0o600, dir_fd=state.directory)
        with os.fdopen(fd, 'ab') as output:
            SupervisorJournal._regular(output.fileno())
            process = popen([sys.executable, '-m', 'canaveral.libvirt_supervisor_child',
                             '--state-directory', str(Path(folder).resolve()), '--parent-pid', str(os.getpid())],
                            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                            close_fds=True, start_new_session=True)
        if type(process.pid) is not int or process.pid <= 0:
            raise Error('Libvirt supervisor child identity was not confirmed.', 409)
        if birth is None:
            import psutil
            birth = lambda pid: psutil.Process(pid).create_time()
        created = birth(process.pid)
        if type(process.pid) is not int or process.pid <= 0 or not finite(created):
            raise Error('Libvirt supervisor child identity was not confirmed.', 409)
        state.write({**value, 'pid': process.pid, 'createdAt': created})
        return process
    finally: state.close()
