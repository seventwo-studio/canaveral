"""Private native-helper upload channel; public session completion stays on the runner."""
import hashlib
import json
import os
import re
import select
import shlex
import stat
import struct
import subprocess
import tempfile
import uuid
from pathlib import Path

from .assignment_process import assignment_popen
from .lease_clock import execution_monotonic
from .model import Error
from .transfers import copy_upload

MAX_HELPER_BYTES=16*1024*1024


def read_regular(path,limit):
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NONBLOCK',0))
    with os.fdopen(fd,'rb') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):raise ValueError()
        return handle.read(limit+1)


def load_helper(config,image):
    """Snapshot a checksum-pinned ELF; consumer requests cannot select its path."""
    try:
        manifest_path=Path(config['transferHelperManifest'])
        if not manifest_path.is_absolute():raise ValueError()
        raw=read_regular(manifest_path,65536)
        if len(raw)>65536:raise ValueError()
        manifest=json.loads(raw)
        if type(manifest['schemaVersion']) is not int or manifest['schemaVersion']!=1 or manifest['protocol']!='CANAVERAL_TRANSFER_V1' or type(manifest['minimumAPI']) is not int or manifest['minimumAPI']!=26:raise ValueError()
        system_image=image['device']['systemImage']
        match=re.fullmatch(r'system-images;android-([0-9]+);[^;]+;[^;]+',system_image)
        if not match or int(match.group(1))<manifest['minimumAPI']:raise ValueError()
        arch=image['arch'];machine={'arm64':183,'amd64':62}[arch];entry=manifest['artifacts'][arch]
        if entry['file']!='canaveral-transfer-'+arch or not re.fullmatch('[a-f0-9]{64}',entry['sha256']):raise ValueError()
        if type(entry['bytes']) is not int or not 64<=entry['bytes']<=MAX_HELPER_BYTES:raise ValueError()
        data=read_regular(manifest_path.parent/entry['file'],MAX_HELPER_BYTES)
        if len(data)!=entry['bytes'] or hashlib.sha256(data).hexdigest()!=entry['sha256']:raise ValueError()
        if data[:6]!=b'\x7fELF\x02\x01' or struct.unpack_from('<HH',data,16)!=(3,machine):raise ValueError()
        if b'CANAVERAL_TRANSFER_TEST_FAIL' in data:raise ValueError()
        return data,entry['sha256']
    except (OSError,ValueError,KeyError,TypeError,AttributeError,RecursionError,struct.error) as error:
        raise Error('Android transfer helper manifest, architecture, API level or checksum validation failed.',400,
                    code='transfer_helper_invalid') from error


def check_authorized(authorized):
    if not authorized():raise Error('Upload authorization ended before confirmed publication.',401)


def read_line(pipe,authorized,timeout=30):
    deadline=execution_monotonic()+timeout;data=bytearray()
    while len(data)<=128:
        check_authorized(authorized)
        remaining=deadline-execution_monotonic()
        if remaining<=0:raise Error('Android transfer helper response timed out.',409)
        if not select.select([pipe],[],[],min(.25,remaining))[0]:continue
        chunk=os.read(pipe.fileno(),129-len(data))
        if not chunk:raise Error('Android transfer helper ended without its required receipt.',409)
        data.extend(chunk)
        if b'\n' in data:return bytes(data)
    raise Error('Android transfer helper response exceeded its metadata envelope.',409)


def write_all(pipe,data,authorized):
    pending=memoryview(data)
    while pending:
        check_authorized(authorized)
        count=pipe.write(pending)
        if type(count) is not int or not 0<count<=len(pending):raise Error('Android transfer pipe did not accept its bytes.',409)
        pending=pending[count:]


class UploadPipe:
    def __init__(self,pipe,authorized):self.pipe,self.authorized=pipe,authorized
    def write(self,data):write_all(self.pipe,data,self.authorized)


def upload(provider,machine,image,folder,path,reader,size,authorized):
    if type(size) is not int or not 0<=size<=2**53-1:raise Error('Invalid transfer length.',400)
    check_authorized(authorized)
    data,digest=load_helper(provider.config,image)
    check_authorized(authorized)
    serial=provider.endpoint(machine,provider.storage(machine),authorized=authorized)
    check_authorized(authorized)
    if not serial:raise Error('Android device is not connected.',409)
    provider.owned(machine,serial);check_authorized(authorized)
    request=str(uuid.uuid4());guest_directory='/data/local/tmp/.canaveral-transfer-'+request
    helper=guest_directory+'/helper';owned=False;process=None;commit_sent=False
    with tempfile.NamedTemporaryFile(dir=folder) as artifact,tempfile.TemporaryFile() as log:
        artifact.write(data);artifact.flush()
        try:
            check_authorized(authorized);provider.owned(machine,serial);check_authorized(authorized)
            created='CREATED '+request
            result=provider.adb(serial,'shell','umask 077; mkdir -m 700 -- '+shlex.quote(guest_directory)+
                " && printf '%s' "+shlex.quote(created),timeout=30)
            if result!=created:raise Error('Android helper directory creation was not confirmed.',409)
            owned=True;check_authorized(authorized);provider.owned(machine,serial);check_authorized(authorized)
            provider.adb(serial,'push',artifact.name,helper,timeout=30)
            check_authorized(authorized);provider.owned(machine,serial);check_authorized(authorized)
            installed=provider.adb(serial,'shell','chmod 500 '+shlex.quote(helper)+' && sha256sum -- '+shlex.quote(helper),timeout=30)
            if installed.split()!=[digest,helper]:raise Error('Android installed helper identity was not confirmed.',409)
            check_authorized(authorized);provider.owned(machine,serial);check_authorized(authorized)
            command='exec '+shlex.quote(helper)+' upload '+shlex.quote(path)+' '+str(size)+' '+request
            process=assignment_popen([provider.tool('adb'),'-s',serial,'shell','-T',command],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,env=provider.environment(),bufsize=0)
            copy_upload(reader,UploadPipe(process.stdin,authorized),size,authorized)
            expected=('CANAVERAL_TRANSFER_V1 STAGED '+request+' '+str(size)+'\n').encode()
            if read_line(process.stdout,authorized)!=expected:raise Error('Android staged upload receipt did not match.',409)
            check_authorized(authorized);provider.owned(machine,serial);check_authorized(authorized)
            commit_sent=True
            write_all(process.stdin,('COMMIT '+request+'\n').encode(),authorized);process.stdin.close()
            expected=('CANAVERAL_TRANSFER_V1 COMMITTED '+request+' '+str(size)+'\n').encode()
            if read_line(process.stdout,authorized)!=expected:raise Error('Android committed upload receipt did not match.',409)
            if process.wait(timeout=30)!=0 or process.stdout.read(1):raise Error('Android helper completion was not confirmed.',409)
            check_authorized(authorized);provider.owned(machine,serial);check_authorized(authorized)
        except Exception as error:
            if commit_sent:
                raise Error('Android upload publication may have occurred; inspect before retrying.',409,
                    code='upload_publication_uncertain') from error
            raise
        finally:
            if process is not None:
                try:process.stdin.close()  # Unbuffered EOF permits precommit guest cleanup.
                except OSError:pass
                if process.poll() is None:
                    try:process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.terminate()
                        try:process.wait(timeout=2)
                        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
                for stream in (process.stdin,process.stdout):
                    try:stream.close()
                    except OSError:pass
            if owned:
                try:
                    check_authorized(authorized);provider.owned(machine,serial);check_authorized(authorized)
                    # No recursive removal: unexpected guest entries are retained.
                    provider.adb(serial,'shell','rm -f -- '+shlex.quote(helper)+'; rmdir -- '+shlex.quote(guest_directory),timeout=30)
                except Exception:pass  # File durability does not imply helper cleanup.
    try:
        check_authorized(authorized);provider.owned(machine,serial);check_authorized(authorized)
    except Exception as error:
        raise Error('Android upload publication may have occurred; inspect before retrying.',409,
                    code='upload_publication_uncertain') from error
    return {'uploaded':size,'durable':True}
