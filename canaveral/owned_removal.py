"""Crash-recoverable removal of positively stopped, assignment-owned Apple disks.

The receipt lives outside the storage tree so a missing directory alone never
counts as evidence of deletion. Controller admission must keep its reservation
until this procedure returns a complete receipt.
"""
import json
import os
import shutil
import subprocess
from contextlib import nullcontext
from pathlib import Path

from .files import HostLock, save_json
from .model import Error, digest, identifier
from .native_fence import disk_closed


def assignment_fingerprint(machine):
    return digest({key: machine[key] for key in ('id', 'template', 'resources')})


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def tree_closed(path):
    result=subprocess.run(['/usr/sbin/lsof','-F','p','+D',str(path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
    return result.returncode==1 and not result.stdout.strip() and not result.stderr.strip()


def remove_apple_storage(provider, machine, folder, request_id,preboot=False):
    """Remove one owned storage directory, retaining its assignment tombstone.

    Never stops a VM, adopts an unmarked directory, or treats a vanished tree as
    proof of cleanup. Callers must serialize this with assignment reconciliation.
    """
    request_id = identifier(request_id)
    machine_id = identifier(machine['id'])
    if machine.get('desired') != 'stopped':
        raise Error('Storage removal requires a stopped assignment.', 409)
    folder = Path(folder)
    fingerprint = assignment_fingerprint(machine)
    assignment = folder / 'assignment.json'
    if not assignment.is_file() or assignment.is_symlink() or json.loads(assignment.read_text()).get('fingerprint') != fingerprint:
        raise Error('Assignment ownership receipt is missing or different.', 409)
    root = Path(provider.config['storage']).resolve()
    storage = root / machine_id
    quarantine = root / ('.removing-' + machine_id + '-' + request_id)
    receipt = folder / 'deletion.json'
    expected = {'id': request_id, 'machineId': machine_id, 'fingerprint': fingerprint}
    with HostLock(folder / 'deletion.lock'):
        if receipt.exists():
            proof = json.loads(receipt.read_text())
            if proof.get('evidence')=='preboot':
                if not machine.get('lease'):raise Error('Pre-boot deletion belongs to a lease.',409)
                expected.update(evidence='preboot',leaseId=machine['lease']['id'])
            if any(proof.get(key) != value for key, value in expected.items()):
                raise Error('Deletion receipt belongs to another intent or assignment.', 409)
            if preboot and proof.get('evidence')!='preboot':raise Error('Deletion evidence differs from this recovery path.',409)
        else:
            if not storage.is_dir() or storage.is_symlink() or quarantine.exists():
                raise Error('Owned storage is missing or its removal path is occupied.', 409)
            marker = storage / 'canaveral-owner.json'
            if marker.is_symlink() or not marker.is_file() or json.loads(marker.read_text()).get('fingerprint') != fingerprint:
                raise Error('Storage ownership does not match this assignment.', 409)
            if preboot:
                from .provisioning import preboot_storage
                if not preboot_storage(machine,folder,storage):raise Error('No durable pre-boot evidence is available.',409)
                expected.update(evidence='preboot',leaseId=machine['lease']['id'])
            proof = {**expected, 'state': 'planned'}

        if proof['state'] == 'complete':
            if storage.exists() or quarantine.exists():
                raise Error('Storage reappeared after completed deletion; inspect the host.', 409)
            return proof
        if storage.is_symlink() or quarantine.is_symlink():
            raise Error('Refusing deletion through a symbolic link.', 409)
        if storage.exists():
            if proof['state'] != 'planned' or quarantine.exists():
                raise Error('Storage layout conflicts with the deletion receipt.', 409)
            marker = storage / 'canaveral-owner.json'
            if marker.is_symlink() or not marker.is_file() or json.loads(marker.read_text()).get('fingerprint') != fingerprint:
                raise Error('Storage ownership changed during removal.', 409)
            native = storage / machine_id.upper()
            partial=proof.get('evidence')=='preboot'
            if native.is_symlink() or (native.exists() and not native.is_dir()) or (not partial and not native.is_dir()):
                raise Error('Owned native VM directory is missing.', 409)
            if any((native / name).is_symlink() for name in ('runtime.lock', 'status.json', 'runner-launch.json', 'fenced-stop.json', 'disk.img')):
                raise Error('Native runtime records must not be symbolic links.', 409)
            # Inspect before opening our own runtime-lock file, which would
            # itself appear as an open handle in the recursive tree sample.
            if partial and not tree_closed(storage):raise Error('Partial preparation still has open handles.',409)
            with HostLock(native / 'runtime.lock') if native.is_dir() else nullcontext():
                if partial:
                    from .provisioning import preboot_storage
                    if not preboot_storage(machine,folder,storage):
                        raise Error('Partial preparation lacks pre-boot evidence.',409)
                elif not provider.confirmed_stopped(native) or not disk_closed(native / 'disk.img'):
                    raise Error('Native shutdown and closed disk handles are required before removal.', 409)
                # Publish the intent before moving anything. The original path
                # stays absent on every resumed attempt; it is never recreated.
                save_json(receipt, proof)
                os.rename(storage, quarantine)
                sync_directory(root)

        if not quarantine.exists() and proof['state'] != 'removing':
            raise Error('No durable evidence explains the missing storage.', 409)
        if quarantine.exists():
            if proof['state'] not in ('planned', 'removing'):
                raise Error('Invalid storage removal receipt.', 409)
            if proof['state']=='planned':
                marker=quarantine/'canaveral-owner.json'
                if marker.is_symlink() or not marker.is_file() or json.loads(marker.read_text()).get('fingerprint')!=fingerprint:
                    raise Error('Quarantined storage ownership does not match the removal intent.',409)
            # shutil.rmtree's fd-based implementation does not follow symlinks
            # inside the tree. Require that protection before touching storage.
            if not shutil.rmtree.avoids_symlink_attacks:
                raise Error('Safe directory removal is unavailable on this host.', 409)
            proof = {**expected, 'state': 'removing'}
            save_json(receipt, proof)
            shutil.rmtree(quarantine)
            sync_directory(root)
        proof = {**expected, 'state': 'complete'}
        save_json(receipt, proof)
        return proof
