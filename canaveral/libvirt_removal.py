"""Intent-bound logical erasure of a fenced libvirt assignment's owned tree.

Callers must hold exclusive assignment access and close guest/helper sessions.
This component keeps the original supervisor's lifetime lock across teardown.
Kernel/driver behavior still needs native acceptance before consumer admission.
"""
import hashlib
import json
import os
import shutil
import stat
import uuid
from pathlib import Path

from .libvirt_execution import linux_boot_id, read_binding, read_spec, _owner
from .libvirt_stop import confirm_stopped_locked
from .libvirt_reboot import check_context as check_boot_context, recover_teardown
from .libvirt_storage_handles import StorageHandleGuard
from .libvirt_supervision import NativeLibvirtConnection, SupervisorJournal, matches_identity
from .model import Error, digest, identifier


MANIFEST = 'libvirt-removal-manifest.jsonl'


def _write_manifest(journal, records):
    temporary = '.removal-manifest-' + str(uuid.uuid4())
    checksum = hashlib.sha256()
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,
                 0o600, dir_fd=journal.directory)
    try:
        with os.fdopen(fd, 'wb') as stream:
            for record in records:
                data = json.dumps(record, ensure_ascii=True, allow_nan=False).encode('ascii') + b'\n'
                if len(data) > 65536: raise Error('Storage manifest path envelope is unsupported.', 409)
                stream.write(data); checksum.update(data)
            stream.flush(); os.fsync(stream.fileno())
        try:
            prior = os.open(MANIFEST, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC, dir_fd=journal.directory)
        except FileNotFoundError: pass
        else:
            try: SupervisorJournal._regular(prior)
            finally: os.close(prior)
        os.replace(temporary, MANIFEST, src_dir_fd=journal.directory, dst_dir_fd=journal.directory)
        os.fsync(journal.directory); journal._check()
        return checksum.hexdigest()
    finally:
        try: os.unlink(temporary, dir_fd=journal.directory)
        except FileNotFoundError: pass


def _check_manifest(journal, records, checksum, partial=False):
    current = {tuple(record['path']): record for record in records}
    pending = set(current); seen = set(); actual = hashlib.sha256()
    fd = os.open(MANIFEST, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC, dir_fd=journal.directory)
    with os.fdopen(fd, 'rb') as stream:
        SupervisorJournal._regular(stream.fileno())
        before = os.fstat(stream.fileno())
        while True:
            line = stream.readline(65537)
            if not line: break
            if len(line) > 65536: raise Error('Storage manifest entry is invalid.', 409)
            actual.update(line); value = json.loads(line)
            path = tuple(value['path'])
            if path in seen or (path not in current and not partial):
                raise Error('Storage manifest entry is missing or duplicated.', 409)
            seen.add(path)
            if path in current:
                if value != current[path]: raise Error('Storage manifest inode identity changed.', 409)
                pending.remove(path)
        after = os.fstat(stream.fileno())
        if any(getattr(before, key) != getattr(after, key) for key in (
                'st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
            raise Error('Storage manifest changed while reading.', 409)
    if pending or actual.hexdigest() != checksum:
        raise Error('Storage manifest integrity is unconfirmed.', 409)


def _absent(factory, spec, binding):
    connection = factory(spec['uri'], binding.machine_id)
    try:
        if connection.absent() is not True: raise Error('Libvirt definition remains.', 409)
    finally: connection.close()


def remove_storage(machine, folder, request_id, location_matches,
                   connection_factory=NativeLibvirtConnection, host_boot=linux_boot_id,
                   guard_factory=StorageHandleGuard):
    """Return storage-only completion; never erase assignment credentials here."""
    request_id = identifier(request_id)
    if (machine.get('desired') != 'stopped' or machine.get('lease', {}).get('state') not in
            ('released', 'expired', 'failed') or machine.get('leaseCleanup', {}).get('id') != request_id or
            machine.get('leaseCleanup', {}).get('leaseId') != machine.get('lease', {}).get('id')):
        raise Error('Libvirt removal requires its terminal lease cleanup intent.', 409)
    execution = SupervisorJournal(folder)
    deletion = None; parent = None
    try:
        deletion = SupervisorJournal(folder, 'deletion')
        binding, spec = read_binding(execution, machine)
        storage = Path(binding.disk).parent
        quarantine = storage.with_name('.removing-' + binding.machine_id + '-' + request_id)
        parent = os.open(storage.parent, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        parent_info = os.fstat(parent)
        if parent_info.st_uid != os.geteuid() or parent_info.st_mode & 0o022:
            raise Error('Storage parent ownership is unconfirmed.', 409)
        launch = execution.read_named('libvirt-launch.json')
        expected = {**binding.identity(), 'id': request_id, 'specDigest': digest(spec), 'launchDigest': digest(launch)}

        def context():
            observed = proof.get('observedHostBootId', binding.host_boot_id)
            if (identifier(host_boot()) != observed or not location_matches(binding, spec) or
                    read_binding(execution, machine) != (binding, spec) or
                    execution.read_named('libvirt-launch.json') != launch):
                raise Error('Libvirt teardown context changed.', 409)
            value = execution.read_named('libvirt-authorization.json')
            retired = execution.read()
            if (not matches_identity(value, binding.identity()) or value.get('fenced') is not True or
                    not matches_identity(retired, binding.identity()) or retired.get('phase') != 'fenced' or
                    retired.get('stopEvidence') not in ('never-launched', 'supervisor-exited', 'host-reboot')):
                raise Error('Libvirt teardown lacks a stopped fenced boot.', 409)
            check_boot_context(machine, execution, binding, spec, observed, stopped=True)
            if observed != binding.host_boot_id and (retired.get('stopEvidence') != 'host-reboot'
                    or retired.get('observedHostBootId') != observed):
                raise Error('Libvirt teardown lacks current reboot stop evidence.', 409)
            current = storage.parent.lstat()
            if (not stat.S_ISDIR(current.st_mode) or current.st_uid != os.geteuid() or current.st_mode & 0o022
                    or (current.st_dev, current.st_ino) != (parent_info.st_dev, parent_info.st_ino)):
                raise Error('Storage parent changed during teardown.', 409)
            if storage.is_symlink() or quarantine.is_symlink():
                raise Error('Storage teardown paths must not be symbolic links.', 409)

        proof = deletion.read()
        if proof is None:
            read_spec(execution, machine)
            stopped = confirm_stopped_locked(machine, execution, location_matches, connection_factory, host_boot)
            if not stopped or stopped.get('executionStopped') is not True:
                raise Error('Positive native stop is required before removal.', 409)
            if os.path.lexists(quarantine): raise Error('Storage quarantine is already occupied.', 409)
            proof = {**expected, 'state': 'planned', 'executionStopped': True, 'evidence': stopped['evidence'],
                     'observedHostBootId': stopped['observedHostBootId']}
            context(); deletion.write(proof)
        if (not matches_identity(proof, expected) or proof.get('executionStopped') is not True or
                proof.get('evidence') not in ('never-launched', 'supervisor-exited', 'host-reboot') or
                proof.get('state') not in ('planned', 'quarantined', 'retired', 'erasing', 'cleared', 'removing', 'complete')):
            raise Error('Libvirt deletion receipt belongs to another intent or boot.', 409)
        if proof['state'] in ('erasing', 'cleared', 'removing', 'complete'):
            manifest = proof.get('manifest')
            if (not isinstance(manifest, str) or len(manifest) != 64 or
                    any(character not in '0123456789abcdef' for character in manifest)):
                raise Error('Libvirt removal lacks a bound storage manifest.', 409)
        if proof['state'] in ('cleared', 'removing', 'complete') and proof.get('contentsErased') is not True:
            raise Error('Libvirt removal lacks durable content erasure evidence.', 409)
        if proof['state'] == 'complete' and proof.get('storageRemoved') is not True:
            raise Error('Libvirt storage completion evidence is missing.', 409)
        observed = proof.get('observedHostBootId', binding.host_boot_id)
        if identifier(observed) != observed: raise Error('Libvirt deletion boot observation is invalid.', 409)
        if identifier(host_boot()) != observed:
            observed = recover_teardown(machine, execution, binding, spec, proof, location_matches,
                                        connection_factory, host_boot)
            proof.update(observedHostBootId=observed, evidence='host-reboot'); deletion.write(proof)
        context()
        if proof['state'] == 'complete':
            if os.path.lexists(storage) or os.path.lexists(quarantine):
                raise Error('Storage reappeared after removal.', 409)
            _absent(connection_factory, spec, binding)
            return proof
        if os.path.lexists(storage):
            if proof['state'] != 'planned' or os.path.lexists(quarantine):
                raise Error('Storage layout conflicts with removal intent.', 409)
            read_spec(execution, machine)
            context()
            os.rename(storage.name, quarantine.name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        if proof['state'] == 'planned':
            value = quarantine.lstat()
            if ((value.st_dev, value.st_ino) != (spec['storageIdentity']['device'], spec['storageIdentity']['inode'])
                    or _owner(quarantine).get('fingerprint') != binding.fingerprint):
                raise Error('Quarantined storage is not the original owned tree.', 409)
            disk = (quarantine/Path(binding.disk).name).lstat()
            if (disk.st_dev, disk.st_ino) != (spec['diskIdentity']['device'], spec['diskIdentity']['inode']):
                raise Error('Quarantined disk identity changed.', 409)
            proof['state'] = 'quarantined'; deletion.write(proof)

        if os.path.lexists(quarantine):
            with guard_factory(quarantine, (spec['storageIdentity']['device'], spec['storageIdentity']['inode'])) as guard:
                context()
                if os.path.lexists(storage): raise Error('Original storage path reappeared.', 409)
                if proof['state'] == 'quarantined':
                    connection = connection_factory(spec['uri'], binding.machine_id)
                    try:
                        if connection.absent() is not True: connection.retire(binding)
                        if connection.absent() is not True: raise Error('Libvirt retirement is unconfirmed.', 409)
                    finally: connection.close()
                    guard.verify(); context()
                    proof['state'] = 'retired'; deletion.write(proof)
                else: _absent(connection_factory, spec, binding)
                if proof['state'] == 'retired':
                    proof.update(state='erasing', manifest=_write_manifest(deletion, guard.snapshot()))
                    deletion.write(proof)
                if proof['state'] == 'erasing':
                    _check_manifest(deletion, guard.snapshot(), proof.get('manifest'))
                    context(); guard.erase_contents(); context()
                    proof.update(state='cleared', contentsErased=True); deletion.write(proof)
                if proof['state'] == 'cleared':
                    _check_manifest(deletion, guard.snapshot(), proof.get('manifest'))
                    if any(os.fstat(item[0]).st_size for item in guard.files):
                        raise Error('Storage contains uncleared contents.', 409)
                    proof['state'] = 'removing'; deletion.write(proof)
                if proof['state'] != 'removing' or proof.get('contentsErased') is not True:
                    raise Error('Storage erasure has no durable cleared-content evidence.', 409)
                _check_manifest(deletion, guard.snapshot(), proof.get('manifest'), partial=True)
                if any(os.fstat(item[0]).st_size for item in guard.files):
                    raise Error('Storage contents reappeared during removal.', 409)
                guard.verify(); context(); _absent(connection_factory, spec, binding); guard.verify()
                if not shutil.rmtree.avoids_symlink_attacks:
                    raise Error('Safe storage removal is unavailable.', 409)
                shutil.rmtree(quarantine)
                guard.verify_unlinked()
                os.fsync(parent)
        elif proof['state'] != 'removing' or proof.get('contentsErased') is not True:
            raise Error('Missing storage has no durable erasure evidence.', 409)
        context(); _absent(connection_factory, spec, binding)
        if os.path.lexists(storage) or os.path.lexists(quarantine):
            raise Error('Storage paths remain after erasure.', 409)
        os.fsync(parent)
        proof.update(state='complete', storageRemoved=True); deletion.write(proof)
        return proof
    finally:
        if parent is not None: os.close(parent)
        if deletion is not None: deletion.close()
        execution.close()
