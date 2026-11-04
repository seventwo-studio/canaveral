"""Explicit legacy Apple runner power-off, fenced by process and disk ownership."""
import json
import os
import subprocess
import time
from pathlib import Path

from .files import HostLock,save_json
from .model import Error,identifier


def disk_closed(path):
    result=subprocess.run(['/usr/sbin/lsof','-F','p','--',str(path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
    return result.returncode==1 and not result.stdout.strip() and not result.stderr.strip()


def same_process(proof):
    import psutil
    try:return psutil.Process(proof['pid']).create_time()==proof['createdAt']
    except psutil.NoSuchProcess:return False


def force_stop(directory,request_id,approved_runners,timeout=5):
    import psutil
    path=Path(directory);request_id=identifier(request_id)
    boot=json.loads((path/'runner-launch.json').read_text())['attemptedAt']
    receipt=path/('power-off-'+request_id+'.json')
    if receipt.exists():
        proof=json.loads(receipt.read_text())
        if proof['boot']!=boot:raise Error('Power-off receipt belongs to a different native boot.')
        # Once sent, an uncertain termination is never replayed against a PID.
        if same_process(proof):return {'state':'unknown','detail':'Power-off was requested; the verified native process has not exited.'}
    else:
        status=json.loads((path/'status.json').read_text());process=psutil.Process(status['pid'])
        created=process.create_time();executable=str(Path(process.exe()).resolve())
        approved={str(Path(value).resolve()) for value in approved_runners}
        if executable not in approved or process.cmdline()[1:]!=['run',str(path)] or process.uids().real!=os.getuid() or not boot-1<=created<=boot+10:
            raise Error('Native process identity does not match this owned VM boot; power-off was refused.')
        try:
            with HostLock(path/'runtime.lock'):pass
        except RuntimeError:pass
        else:raise Error('Native process no longer owns the runtime lock; inspect its state before power-off.')
        proof={'boot':boot,'pid':process.pid,'createdAt':created,'executable':executable,'requestId':request_id,'requestedAt':time.time()}
        save_json(receipt,proof)
        # psutil rechecks PID creation identity before signalling. This is an
        # explicit power cut, never a fallback for ordinary graceful shutdown.
        process.terminate()
        try:process.wait(timeout=timeout)
        except psutil.TimeoutExpired:return {'state':'unknown','detail':'Owned native process has not exited; resources remain reserved.'}
    if same_process(proof):return {'state':'unknown','detail':'Native process exit is not confirmed.'}
    try:
        with HostLock(path/'runtime.lock'):
            if not disk_closed(path/'disk.img'):
                return {'state':'unknown','detail':'A native disk handle is still open; resources remain reserved.'}
            save_json(path/'fenced-stop.json',{**proof,'stoppedAt':time.time(),'consistency':'crash-consistent'})
    except RuntimeError:return {'state':'unknown','detail':'Native runtime lock remains owned; resources remain reserved.'}
    return {'state':'stopped','detail':'Explicit power-off confirmed; runtime process and disk handles are closed.'}
