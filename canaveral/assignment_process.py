"""Track host helpers through runner loss without retaining command arguments."""
import json
import math
import os
import signal
import subprocess
import threading
import uuid
from pathlib import Path

from .assignment_gate import current_assignment
from .files import save_json
from .model import Error,identifier
from .process_groups import LeasedPopen,group_present


CANCEL_WAIT = 5


def helper_directory(folder,machine_id):
    return Path(folder).parent/'.assignment-helpers'/identifier(machine_id)


def helpers_closed(machine,folder):
    """Called under the exclusive assignment gate; never signal recovered PIDs."""
    import psutil
    root=helper_directory(folder,machine['id'])
    if root.is_symlink():return False
    if not root.exists():return True
    for path in root.iterdir():
        if path.is_symlink() or not path.is_file():return False
        try:
            record=json.loads(path.read_text())
            if record.get('machineId')!=machine['id'] or record.get('leaseId')!=machine['lease']['id']:return False
            # A crash between durable intent and PID publication has no positive
            # exit evidence. It requires recovery rather than an empty success.
            if record.get('version')!=2 or record.get('state') not in ('running','cancelling'):return False
            pid,started=record['pid'],record['startedAt']
            if type(pid) is not int or pid<=0 or type(started) not in (int,float) or not math.isfinite(started) or started<=0:return False
            if type(record.get('processGroupId')) is not int or record['processGroupId']!=pid:return False
            try:
                process=psutil.Process(pid)
                if process.create_time()==started and process.status()!=psutil.STATUS_ZOMBIE:return False
            except psutil.NoSuchProcess:pass
            if group_present(record['processGroupId']) is not False:return False
            path.unlink()
        except (OSError,ValueError,KeyError,psutil.Error):return False
    return True


class AssignmentProcess:
    leased_group=True
    def __init__(self,process,receipt,record):
        self.process=process;self.receipt=receipt;self.record=record;self.lock=threading.RLock()
    def __getattr__(self,name):return getattr(self.process,name)
    def finished(self):
        with self.lock:
            if (self.receipt and self.record['state']!='uncertain' and self.process.returncode is not None
                    and group_present(self.process.pid) is False):
                self.receipt.unlink(missing_ok=True);self.receipt=None
    def mark(self,state):
        with self.lock:
            if self.receipt:
                if self.record['state']=='uncertain':state='uncertain'
                self.record={**self.record,'state':state}
                save_json(self.receipt,self.record)
    def send_signal(self,signum):
        if self.process.returncode is not None and group_present(self.process.pid) is False:
            self.finished();return
        self.mark('cancelling')
        try:self.process.send_signal(signum)
        except Exception:
            self.mark('uncertain');raise
    def terminate(self):self.send_signal(signal.SIGTERM)
    def kill(self):self.send_signal(signal.SIGKILL)
    def group_closed(self):
        self.poll()
        return (self.process.returncode is not None and self.record['state']!='uncertain'
                and group_present(self.process.pid) is False)
    def poll(self):
        value=self.process.poll()
        if value is not None:self.finished()
        return value
    def wait(self,*args,**kwargs):
        try:return self.process.wait(*args,**kwargs)
        finally:self.finished()
    def communicate(self,*args,**kwargs):
        # Do not poll/reap the leader when communication times out: cancellation
        # needs that unreaped child as its positive group-identity fence.
        result=self.process.communicate(*args,**kwargs)
        self.finished();return result
    def __enter__(self):return self
    def __exit__(self,*args):
        try:
            try:self.wait(timeout=CANCEL_WAIT)
            except subprocess.TimeoutExpired:
                self.kill();self.wait(timeout=CANCEL_WAIT)
        except BaseException:
            self.mark('uncertain');raise
        finally:
            for stream in (self.process.stdin,self.process.stdout,self.process.stderr):
                if stream:
                    try:stream.close()
                    except OSError:pass
            self.finished()


def assignment_popen(*args,**kwargs):
    held=current_assignment()
    if not held:return subprocess.Popen(*args,**kwargs)
    import psutil
    machine=held['machine']
    if (os.name=='nt' or kwargs.get('preexec_fn') is not None or
            kwargs.get('process_group') not in (None,-1) or
            signal.getsignal(signal.SIGCHLD) not in (signal.SIG_DFL,None)):
        raise Error('Leased helper process ownership cannot be established on this configuration.',409,
                    code='capability_unsupported')
    root=helper_directory(held['folder'],machine['id'])
    if root.is_symlink():raise Error('Assignment helper inventory cannot be a symbolic link.',409)
    root.mkdir(mode=0o700,parents=True,exist_ok=True)
    receipt=root/(str(uuid.uuid4())+'.json')
    record={'version':2,'machineId':machine['id'],'leaseId':machine['lease']['id'],'state':'launching'}
    save_json(receipt,record)
    # The descriptor is useful even across the PID-publication window. Durable
    # records also cover tools which close inherited descriptors at startup.
    kwargs['pass_fds']=tuple(set((*kwargs.get('pass_fds',()),held['fd'])))
    kwargs['start_new_session']=True
    try:process=LeasedPopen(*args,**kwargs)
    except Exception:
        receipt.unlink(missing_ok=True);raise
    try:
        try:started=psutil.Process(process.pid).create_time()
        except psutil.NoSuchProcess:
            if process.poll() is None:raise
            record={**record,'state':'uncertain','pid':process.pid,'startedAt':0,'processGroupId':process.pid}
            save_json(receipt,record)
            return AssignmentProcess(process,receipt,record)
        record={**record,'state':'running','pid':process.pid,'startedAt':started,'processGroupId':process.pid}
        save_json(receipt,record)
    except Exception:
        # We still own the actual Popen handle here. Leave the intent behind if
        # stopping or recording its outcome is uncertain.
        try:
            process.kill();process.wait(timeout=CANCEL_WAIT)
            if group_present(process.pid) is False:receipt.unlink(missing_ok=True)
        except Exception:pass
        raise
    return AssignmentProcess(process,receipt,record)


def assignment_run(*popenargs,input=None,timeout=None,check=False,**kwargs):
    if not current_assignment():
        return subprocess.run(*popenargs,input=input,timeout=timeout,check=check,**kwargs)
    if input is not None:
        if kwargs.get('stdin') is not None:raise ValueError('stdin and input arguments may not both be used.')
        kwargs['stdin']=subprocess.PIPE
    with assignment_popen(*popenargs,**kwargs) as process:
        try:stdout,stderr=process.communicate(input,timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            try:process.communicate(timeout=CANCEL_WAIT)
            except subprocess.TimeoutExpired:
                process.mark('uncertain');process.wait(timeout=CANCEL_WAIT)
            raise
        except BaseException:
            process.kill();process.wait(timeout=CANCEL_WAIT);raise
        result=subprocess.CompletedProcess(process.args,process.returncode,stdout,stderr)
        if check:result.check_returncode()
        return result
