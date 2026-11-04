"""Fake ADB maps every guest operation into a disposable directory."""
import hashlib
import os
import shutil
import shlex
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

from canaveral.providers.android import Android


def compile_helper(root):
    binary=Path(root)/'native-transfer'
    source=Path(__file__).resolve().parents[1]/'canaveral/native/android_transfer.c'
    result=subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-DCANAVERAL_TRANSFER_TESTING',
        '-DCANAVERAL_TRANSFER_TIMEOUT_MS=1000',str(source),'-o',str(binary)],capture_output=True,text=True)
    if result.returncode:raise RuntimeError(result.stderr)
    return binary


def provider(root,binary,filesystem_root=None):
    root=Path(root);guest=root/'guest-tmp';guest.mkdir();tools=root/'tools';tools.mkdir()
    permitted=Path(filesystem_root or root).resolve()
    checksum=tools/'sha256sum'
    checksum.write_text('#!'+sys.executable+'\nimport hashlib,sys\nfrom pathlib import Path\np=sys.argv[-1]\nprint(hashlib.sha256(Path(p).read_bytes()).hexdigest()+"  "+p)\n')
    checksum.chmod(0o700)
    result=object.__new__(Android)
    result.config={'transferHelperManifest':str(root/'manifest.json')}
    result.guest=guest;result.calls=[];result.processes=[];result.allowed=True;result.failure=None;result.bad_hash=False
    result.bad_create=False;result.fail_cleanup=False
    result.payload=binary.read_bytes();result.digest=hashlib.sha256(result.payload).hexdigest()
    result.storage=lambda machine:root
    result.endpoint=lambda *args,**kwargs:'fixture-device'
    result.owned=Mock();result.tool=lambda name:'fixture-adb'
    result.environment=lambda:{**os.environ,'PATH':str(tools)+os.pathsep+os.environ['PATH'],
        **({'CANAVERAL_TRANSFER_TEST_FAIL':result.failure} if result.failure else {})}
    def local(value):return value.replace('/data/local/tmp',str(guest))
    def command(value):
        value=local(value)
        for token in shlex.split(value):
            if token.startswith('/') and not Path(token).resolve().is_relative_to(permitted):
                raise AssertionError('Fixture command escaped its disposable filesystem root.')
        return value
    def adb(serial,action,*args,**kwargs):
        assert result.allowed,'No guest RPC is allowed after authorization ends.'
        result.calls.append((action,*args))
        if action=='push':shutil.copyfile(args[0],local(args[1]));return 'pushed'
        assert action=='shell'
        command=args[0]
        if result.fail_cleanup and command.startswith('rm -f'):raise OSError('fixture cleanup')
        output=subprocess.check_output(['/bin/sh','-c',globals_command(command)],env=result.environment()).decode().strip()
        output=output.replace(str(guest),'/data/local/tmp')
        if result.bad_create and command.startswith('umask'):return 'unconfirmed'
        if result.bad_hash and 'sha256sum' in command:return '0'*64+'  '+output.split()[-1]
        return output
    globals_command=command
    result.adb=adb
    def launch(argv,**kwargs):
        assert argv[:5]==['fixture-adb','-s','fixture-device','shell','-T']
        process=subprocess.Popen(['/bin/sh','-c',command(argv[5])],**kwargs)
        result.processes.append(process);return process
    result.launch=launch
    return result
