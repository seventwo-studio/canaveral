"""Durable distinction between owned preparation and a possible native boot."""
import json
from pathlib import Path

from .files import save_json
from .model import Error
from .owned_removal import assignment_fingerprint


def binding(machine):
    return {'version':1,'machineId':machine['id'],'leaseId':machine['lease']['id'],
            'fingerprint':assignment_fingerprint(machine)}


def read_journal(machine,folder):
    path=Path(folder)/'provisioning.json'
    if not path.exists() and not path.is_symlink():return None
    if path.is_symlink() or not path.is_file():raise Error('Provisioning journal is not a regular owned file.',409)
    value=json.loads(path.read_text())
    if any(value.get(k)!=v for k,v in binding(machine).items()) or value.get('phase') not in ('preparing','unproven','bootRequested'):
        raise Error('Provisioning journal belongs to another assignment or is invalid.',409)
    return value


def record_preparation(machine,folder,never_started):
    existing=read_journal(machine,folder)
    if existing:return existing # A restart must never turn bootRequested into preparing.
    assignment=Path(folder)/'assignment.json'
    if assignment.is_symlink() or not assignment.is_file():raise Error('Leased preparation requires owned assignment metadata.',409)
    owner=json.loads(assignment.read_text())
    expected=binding(machine)
    if owner.get('fingerprint')!=expected['fingerprint'] or owner.get('leaseId')!=expected['leaseId']:
        raise Error('Leased preparation cannot adopt another assignment.',409)
    value={**expected,'phase':'preparing' if never_started is True else 'unproven'}
    save_json(Path(folder)/'provisioning.json',value)
    return value


def record_boot_request(machine,folder,attempted_at):
    if not machine.get('lease'):return
    value=read_journal(machine,folder)
    if value is None:value=record_preparation(machine,folder,False)
    save_json(Path(folder)/'provisioning.json',{**value,'phase':'bootRequested','attemptedAt':attempted_at})


def preboot_storage(machine,folder,storage):
    """Positive preparing journal, with no contradictory execution evidence."""
    value=read_journal(machine,folder)
    if not value or value['phase']!='preparing':return False
    assignment=Path(folder)/'assignment.json'
    if assignment.is_symlink() or not assignment.is_file():raise Error('Partial preparation has no owned assignment receipt.',409)
    owner=json.loads(assignment.read_text())
    if owner.get('fingerprint')!=value['fingerprint'] or owner.get('leaseId')!=value['leaseId']:
        raise Error('Partial assignment ownership differs from its journal.',409)
    storage=Path(storage);native=storage/machine['id'].upper()
    if storage.is_symlink() or native.is_symlink():raise Error('Pre-boot cleanup cannot follow storage links.',409)
    if storage.exists():
        marker=storage/'canaveral-owner.json'
        if marker.is_symlink() or not marker.is_file() or json.loads(marker.read_text()).get('fingerprint')!=value['fingerprint']:
            raise Error('Partial storage ownership is missing or different.',409)
    if any(storage.parent.glob('.removing-'+machine['id']+'-*')):
        raise Error('Partial storage has a removal quarantine; matching recovery is required.',409)
    # These can only be published after the preparing phase has ended. Their
    # presence is contradictory evidence, never something cleanup can clear.
    for name in ('runner-launch.json','status.json','lease-authorization.json','lease-fenced.json','fenced-stop.json','runner.log'):
        path=native/name
        if path.exists() or path.is_symlink():raise Error('Partial storage has possible execution evidence.',409)
    metadata=native/'machine.json'
    if metadata.exists() or metadata.is_symlink():
        native_lease=None if metadata.is_symlink() else json.loads(metadata.read_text()).get('executionLeaseID')
        if not isinstance(native_lease,str) or native_lease.lower()!=machine['lease']['id']:
            raise Error('Partial native metadata is not bound to this lease.',409)
    return True
