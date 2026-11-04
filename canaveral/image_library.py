"""Immutable host-local image artifacts, with public metadata and private bindings."""
import copy
import contextlib
import hashlib
import json
import os
import stat
import struct
import tempfile
import threading
from pathlib import Path

from .files import save_json
from .model import Error, identifier, resources, template, text


def specification(value):
    if not isinstance(value,dict) or set(value)-{'id','name','os','arch','mode','mediaType','format','minimum','guestAccess'}:
        raise Error('Invalid image import metadata.',400)
    result={'id':identifier(value.get('id')),'name':text(value.get('name'),'image name'),
            'os':value.get('os'),'arch':value.get('arch'),'mode':value.get('mode','desktop'),
            'mediaType':value.get('mediaType'),'format':value.get('format'),
            'minimum':resources(value.get('minimum'))}
    if result['os'] not in ('linux','windows','macos') or result['arch'] not in ('arm64','amd64') or result['mode'] not in ('headless','desktop'):
        raise Error('Choose a supported VM image operating system, architecture and mode.',400)
    formats={'installer':('iso','ipsw'),'disk':('raw','qcow2','vhdx')}
    if result['format'] not in formats.get(result['mediaType'],()):raise Error('Installer media and installed boot disks require distinct formats.',400)
    if value.get('guestAccess') is not None and type(value['guestAccess']) is not bool:raise Error('Invalid image guest access flag.',400)
    if value.get('guestAccess'):
        if result['os']!='linux' or result['mediaType']!='disk':raise Error('Automatic guest access requires an installed Linux disk.',400)
        result['guestAccess']=True
    return result


def artifact_signature(info):
    return info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns


def checksum(path):
    path=Path(path);result=hashlib.sha256()
    try:
        before=path.lstat()
        if not stat.S_ISREG(before.st_mode):raise Error('Image artifact must be a regular file, without symbolic links.')
        descriptor=os.open(path,os.O_RDONLY|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_BINARY',0))
        with os.fdopen(descriptor,'rb') as source:
            def unchanged():
                if (artifact_signature(before)!=artifact_signature(os.fstat(source.fileno())) or
                    artifact_signature(before)!=artifact_signature(path.lstat())):
                    raise Error('Image artifact changed during checksum verification.')
            unchanged();remaining=before.st_size
            while remaining:
                data=source.read(min(1048576,remaining))
                if not data:raise Error('Image artifact ended during checksum verification.')
                result.update(data);remaining-=len(data)
            unchanged()
        return result.hexdigest()
    except OSError as error:
        raise Error('Image artifact could not be verified as a stable regular file.') from error


class ImageLibrary:
    def __init__(self,state):
        self.root=Path(state)/'image-library'
        self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.lock=threading.RLock()
        self.verified={}

    def verify_definition(self,image):
        """Verify catalogue bytes before provisioning, caching only an unchanged file."""
        path=Path(image['image'])
        before=path.lstat()
        if not stat.S_ISREG(before.st_mode):raise Error('Image artifact must be a regular file, without symbolic links.')
        signature=artifact_signature(before)
        expected=image['artifactSha256']
        with self.lock:
            if self.verified.get((str(path),expected))==signature:return
        actual=checksum(path);after=path.lstat()
        if actual!=expected or signature!=artifact_signature(after):
            raise Error('Image artifact changed or failed checksum validation; provisioning was refused.')
        with self.lock:self.verified[(str(path),expected)]=signature

    def records(self):
        with self.lock:return [json.loads(path.read_text()) for path in sorted(self.root.glob('*.json'))]

    def definitions(self):return [record['definition'] for record in self.records() if record.get('registered')]
    def public_records(self):return [record['public'] for record in self.records()]

    def acknowledge(self,registered):
        with self.lock:
            for record in self.records():
                public=record['public']
                if registered.get(public['id'])!=public['sha256']:continue
                if not record.get('registered'):
                    record['registered']=True
                    save_json(self.root/(public['id']+'.json'),record)

    def capture(self,task,provider,image,folder):
        """Only a positively fenced stopped source can enter this path."""
        receipt=self.root/(task['id']+'.capture.json.receipt')
        fingerprint=json.dumps({'id':task['id'],'machineId':task['machineId'],'name':task['name']},sort_keys=True)
        if receipt.exists():
            previous=json.loads(receipt.read_text())
            if previous['fingerprint']!=fingerprint:raise Error('Capture identity conflicts with its local receipt.')
            if 'report' not in previous:
                published=self.root/(task['id']+'.json')
                if published.exists():
                    record=json.loads(published.read_text())
                    if (record['public'].get('id')==task['id'] and record['public'].get('name')==task['name'] and
                        record['public'].get('sourceMachineId')==task['machineId'] and checksum(record['definition']['image'])==record['public']['sha256']):
                        return {'state':'succeeded','result':record['public']}
            return previous.get('report',{'state':'unknown','result':{'detail':'Interrupted capture; inspect its private receipt and artifact before recovery.'}})
        save_json(receipt,{'fingerprint':fingerprint,'started':True})
        machine=task['machine']
        if machine['desired']!='stopped' or machine['observed']!='stopped':raise Error('Source must remain confirmed stopped.')
        try:
            with contextlib.ExitStack() as capture_files:
                with provider.capture_source(machine,image,folder) as (source,format):
                    source=Path(source);before=source.lstat()
                    if not stat.S_ISREG(before.st_mode):raise Error('Capture source must be an owned regular disk.')
                    descriptor=os.open(source,os.O_RDONLY|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_BINARY',0))
                    reader=capture_files.enter_context(os.fdopen(descriptor,'rb'))
                    def unchanged():
                        if artifact_signature(before)!=artifact_signature(os.fstat(reader.fileno())) or artifact_signature(before)!=artifact_signature(source.lstat()):
                            raise Error('Source changed during capture; do not use this artifact.')
                    unchanged()
                    metadata={'id':task['id'],'name':task['name'],'os':image['os'],'arch':image['arch'],'mode':image['mode'],
                              'mediaType':'disk','format':format,'minimum':machine['resources']}
                    public=self.import_stream(metadata,reader,before.st_size,lambda:True,defer=True)
                    unchanged()
                    record_path=self.root/(task['id']+'.staged')
                    with self.lock:
                        record=json.loads(record_path.read_text())
                        definition=record['definition']
                        definition['imageKind']='derived'
                        for key in ('prepare','guestAccess','memoryStepMiB','runtime','ssh'):
                            if key in image:definition[key]=copy.deepcopy(image[key])
                        if image.get('guestAccess') and image['os']=='linux':definition['cloneIdentity']='linux-cloud-init'
                        if image.get('guestAccess') and definition.get('prepare'):
                            definition['prepare']['commands']=[command.replace('systemctl enable --now canaveral-desktop','systemctl enable canaveral-desktop && systemctl restart canaveral-desktop') for command in definition['prepare']['commands']]
                        template(definition)
                        public.update(kind='derived',sourceMachineId=task['machineId'],identityPolicy='linux-cloud-init' if image.get('guestAccess') else 'preserve-configured-os-state')
                        public['consistency']=provider.capture_consistency(machine,image,folder) if hasattr(provider,'capture_consistency') else 'stopped-disk'
                        if image.get('catalogueImageId'):public['baseImageId']=image['catalogueImageId']
                        if image.get('guestAccess'):public['guestAccess']=True
                        record['public']=public
                        save_json(record_path,record)
                unchanged()
                with self.lock:
                    os.replace(record_path,self.root/(task['id']+'.json'))
                    if os.name!='nt':
                        directory=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
                        try:os.fsync(directory)
                        finally:os.close(directory)
                report={'state':'succeeded','result':public}
        except Exception:
            # A published-but-unconfirmed artifact must not be offered or release
            # its reserved storage until an operator resolves the uncertain copy.
            record_path=self.root/(task['id']+'.staged')
            if record_path.exists():
                record_path.rename(self.root/(task['id']+'.quarantined'))
                report={'state':'unknown','result':{'detail':'Capture artifact needs inspection; source state and reserved storage were preserved.'}}
            elif (self.root/(task['id']+'.json')).exists():
                report={'state':'unknown','result':{'detail':'Capture publication was not confirmed; preserve its artifact and reservation for inspection.'}}
            else:report={'state':'failed','result':{'detail':'Cold capture failed; inspect runtime support, owned source and storage headroom.'}}
        save_json(receipt,{'fingerprint':fingerprint,'report':report})
        return report

    def import_stream(self,value,reader,size,authorized,prepare=None,defer=False,memory_step=1,expected_sha256=None,registry=None):
        metadata=specification(value)
        if metadata['minimum']['memoryMiB']%memory_step:raise Error('Image memory must match this runtime memory granularity.',400)
        if type(size) is not int or size<512:raise Error('Image artifact is too small.',400)
        fd,temporary=tempfile.mkstemp(dir=str(self.root),suffix='.partial')
        try:
            digest=hashlib.sha256();copied=0
            with os.fdopen(fd,'wb') as output:
                while copied<size:
                    if not authorized():raise Error('Image import authorization ended.',403)
                    data=reader.read(min(1048576,size-copied))
                    if not data:raise Error('Image upload was interrupted.',400)
                    if len(data)>size-copied:raise Error('Image stream exceeded its declared length.',400)
                    digest.update(data)
                    # Preserve sparse raw images instead of allocating zero blocks.
                    if data.count(0)==len(data):output.seek(len(data),1)
                    else:output.write(data)
                    copied+=len(data)
                output.truncate(size)
                output.flush();os.fsync(output.fileno())
            self._validate_artifact(Path(temporary),metadata['format'],size)
            if expected_sha256 is not None and digest.hexdigest()!=expected_sha256:raise Error('Downloaded image does not match the pinned publisher checksum.',400)
            public={**metadata,'sha256':digest.hexdigest(),'bytes':size,'kind':'base','revision':'1'}
            if registry is not None:public['registry']=registry
            definition={'id':metadata['id'],'catalogueImageId':metadata['id'],'imageKind':'base','artifactSha256':public['sha256'],'name':metadata['name'],'revision':'1','os':metadata['os'],'arch':metadata['arch'],'mode':metadata['mode'],
                        'mediaType':metadata['mediaType'],'minimum':metadata['minimum'],'defaults':metadata['minimum'],
                        'memoryStepMiB':memory_step,
                        'source':{'sha256':public['sha256'],'format':metadata['format']}}
            if metadata.get('guestAccess'):
                if not prepare:raise Error('This host has no configured Linux guest-access preparation.',409)
                definition.update(guestAccess=True,prepare=prepare)
                definition['prepare']=copy.deepcopy(prepare)
                definition['prepare']['commands']=[command.replace('systemctl enable --now canaveral-desktop','systemctl enable canaveral-desktop && systemctl restart canaveral-desktop') for command in definition['prepare']['commands']]
                definition['cloneIdentity']='linux-cloud-init'
            with self.lock:
                artifact=self.root/(public['sha256']+'.'+metadata['format'])
                definition['image']=str(artifact)
                definition['source']['path']=str(artifact)
                template(definition)
                record=self.root/(metadata['id']+('.staged' if defer else '.json'))
                if defer and (self.root/(metadata['id']+'.json')).exists():raise Error('Image ID already has a published manifest.')
                if record.exists():
                    previous=json.loads(record.read_text())
                    if previous['public']!=public:raise Error('Image identity already refers to another artifact or specification.')
                    return previous['public']
                if not authorized():raise Error('Image import authorization ended.',403)
                created=False
                if artifact.exists():
                    if checksum(artifact)!=public['sha256']:raise Error('Existing image artifact checksum failed; it was preserved for inspection.')
                else:
                    os.link(temporary,artifact)
                    created=True
                try:
                    if created:os.chmod(artifact,0o400)
                    save_json(record,{'public':public,'definition':definition,'registered':False})
                except Exception:
                    if created:artifact.unlink()
                    raise
            return public
        finally:
            try:os.unlink(temporary)
            except FileNotFoundError:pass

    @staticmethod
    def _validate_artifact(path,format,size):
        with path.open('rb') as source:
            header=source.read(104)
            if format=='qcow2':
                if header[:4]!=b'QFI\xfb' or struct.unpack('!I',header[4:8])[0] not in (2,3) or struct.unpack('!Q',header[8:16])[0]!=0:
                    raise Error('Import a standalone QCOW2 v2/v3 disk without a backing file.',400)
            elif format=='vhdx' and header[:8]!=b'vhdxfile':raise Error('Invalid VHDX header.',400)
            elif format=='ipsw' and header[:4]!=b'PK\x03\x04':raise Error('Invalid restore archive header.',400)
            elif format=='iso':
                source.seek(32769)
                if source.read(5)!=b'CD001':raise Error('ISO image volume descriptor is missing.',400)
            elif format=='raw' and size%512:raise Error('Raw disk size must be a multiple of 512 bytes.',400)
