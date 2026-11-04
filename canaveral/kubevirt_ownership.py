"""Bind cluster object UIDs to a recorded creation, never adopt by label alone."""
from pathlib import Path
import uuid

from .files import save_json
from .model import Error,digest,identifier
from .owned_usage import record


def binding(machine,namespace):
    return {'version':1,'machineId':identifier(machine['id']),'namespace':namespace,
            'name':'cvm-'+identifier(machine['id']),'leaseId':machine.get('lease',{}).get('id'),
            'fingerprint':digest({k:machine[k] for k in ('id','template','resources')})}


def annotations(identity):
    return {'canaveral.io/creation-id':identity['creationId'],
            'canaveral.io/assignment':identity['fingerprint']}


def checked(machine,namespace,value,owner=False):
    expected=binding(machine,namespace)
    if type(value.get('version')) is not int or set(value)!=set(expected)|{'creationId'}|({'uid'} if owner else set()) or any(value.get(k)!=v for k,v in expected.items()):
        raise Error('KubeVirt ownership receipt differs from its assignment.')
    identifier(value['creationId'])
    if owner and (not isinstance(value['uid'],str) or not 1<=len(value['uid'])<=128):
        raise Error('KubeVirt object UID is unavailable.')
    return value


def matches_vm(value,identity):
    if not isinstance(value,dict):return False
    metadata=value.get('metadata',{})
    if not isinstance(metadata,dict):return False
    return (value.get('kind')=='VirtualMachine' and value.get('apiVersion')=='kubevirt.io/v1'
            and metadata.get('namespace')==identity['namespace'] and metadata.get('name')==identity['name']
            and metadata.get('labels',{}).get('canaveral.io/machine')==identity['machineId']
            and all(metadata.get('annotations',{}).get(k)==v for k,v in annotations(identity).items())
            and isinstance(metadata.get('uid'),str) and 1<=len(metadata['uid'])<=128
            and ('uid' not in identity or metadata['uid']==identity['uid']))


def ensure_uncreated(folder):
    folder=Path(folder)
    if folder.is_symlink():raise Error('KubeVirt assignment cannot follow a directory link.')
    for name in ('kubevirt-create.json','kubevirt-owner.json'):
        path=folder/name
        if path.exists() or path.is_symlink():
            raise Error('KubeVirt creation outcome requires inspection; automatic recreation is blocked.')


def begin(machine,namespace,folder):
    folder=Path(folder)
    ensure_uncreated(folder)
    folder.mkdir(parents=True,exist_ok=True)
    identity={**binding(machine,namespace),'creationId':str(uuid.uuid4())}
    save_json(folder/'kubevirt-create.json',identity)
    return identity


def remember(machine,namespace,folder,vm):
    """Recover a lost creation response only through its persisted creation UUID."""
    folder=Path(folder)
    if folder.is_symlink():raise Error('KubeVirt assignment cannot follow a directory link.')
    pending=checked(machine,namespace,record(folder/'kubevirt-create.json'))
    if not matches_vm(vm,pending):raise Error('KubeVirt object differs from its recorded creation.')
    path=folder/'kubevirt-owner.json';owner={**pending,'uid':vm['metadata']['uid']}
    if path.exists() or path.is_symlink():
        if checked(machine,namespace,record(path),owner=True)!=owner:
            raise Error('KubeVirt object UID changed; refusing another incarnation.')
    else:save_json(path,owner)
    return owner


def verify_existing(machine,namespace,folder,vm):
    folder=Path(folder);path=folder/'kubevirt-owner.json';pending=folder/'kubevirt-create.json'
    if folder.is_symlink():raise Error('KubeVirt assignment cannot follow a directory link.')
    if path.exists() or path.is_symlink():
        identity=checked(machine,namespace,record(path),owner=True)
        if not matches_vm(vm,identity):raise Error('KubeVirt object differs from its saved ownership.')
        return True
    if pending.exists() or pending.is_symlink():
        remember(machine,namespace,folder,vm);return True
    return False  # Legacy administrative control does not establish measured ownership.


def load(machine,namespace,folder):
    folder=Path(folder)
    if folder.is_symlink():raise Error('KubeVirt assignment cannot follow a directory link.')
    identity=checked(machine,namespace,record(folder/'kubevirt-owner.json'),owner=True)
    if record(folder/'assignment.json').get('fingerprint')!=identity['fingerprint']:
        raise Error('KubeVirt assignment fingerprint is unavailable.')
    return identity
