"""Bridge conservative Python lease durations to the native continuous clock."""
import json
import math
import time
import threading
import logging
from pathlib import Path

from .files import HostLock, save_json
from .model import Error,identifier
from .providers.base import run
from .native_fence import disk_closed
from .lease_clock import execution_monotonic

_locks={}
_lock_guard=threading.Lock()


def publish(provider,machine,image,directory,stopping=False):
    with _lock_guard:lock=_locks.setdefault(str(directory),threading.RLock())
    with lock,HostLock(Path(directory)/'lease-authorization.lock'):
        return _publish(provider,machine,image,directory,stopping)


def _publish(provider,machine,image,directory,stopping=False):
    callback=image.get('_leaseAuthorization')
    if not callable(callback):raise Error('A leased native VM requires its local deadline guard.',409)
    started=execution_monotonic();authorization=callback()
    clock=json.loads(run([provider.config['runner'],'lease-clock'],timeout=5))
    elapsed=execution_monotonic()-started
    if set(clock)!={'version','bootSessionID','continuous'} or clock['version']!=1 or type(clock['continuous']) not in (int,float) or not math.isfinite(clock['continuous']) or clock['continuous']<0:
        raise Error('The native runner has no valid continuous lease clock.',409)
    lease_id=identifier(machine['lease']['id'])
    if authorization['leaseID']!=lease_id:raise Error('Native lease ownership changed.',409)
    boot=json.loads((Path(directory)/'runner-launch.json').read_text())['attemptedAt']
    value={'version':1,'machineID':identifier(machine['id']),'leaseID':lease_id,
           'revision':authorization['revision'],'boot':boot,'bootSessionID':identifier(clock['bootSessionID']),
           'deadline':max(0,clock['continuous']+authorization['remainingSeconds']-elapsed-.25),
           'fenced':stopping or authorization['fenced']}
    path=Path(directory)/'lease-authorization.json'
    if path.exists():
        previous=json.loads(path.read_text())
        if previous.get('leaseID')!=lease_id or previous.get('machineID')!=machine['id'] or previous.get('boot')!=boot:
            raise Error('Native execution authorization belongs to another identity or boot.',409)
        value['fenced']=value['fenced'] or previous['fenced']
        if value['revision']<previous['revision']:raise Error('Native execution revision cannot move backwards.',409)
        if value['revision']==previous['revision']:
            value['deadline']=min(value['deadline'],previous['deadline'])
    save_json(path,value)
    return value


def confirm_fenced(machine,directory):
    """A native self-exit marker alone never releases runtime reservations."""
    directory=Path(directory);marker=directory/'lease-fenced.json'
    boot=json.loads((directory/'runner-launch.json').read_text())['attemptedAt']
    native_fence=marker.is_file() and not marker.is_symlink()
    if native_fence:
        proof=json.loads(marker.read_text())
        if identifier(proof.get('machineID'))!=machine['id'] or identifier(proof.get('leaseID'))!=machine['lease']['id'] or proof.get('boot')!=boot:
            raise Error('Native lease fence belongs to another machine, lease or boot.',409)
    else:
        if marker.is_symlink():return False
        definition=directory/'machine.json'
        if definition.is_symlink() or not definition.is_file():return False
        if json.loads(definition.read_text()).get('executionLeaseID','').lower()!=machine['lease']['id']:return False
        status=directory/'status.json'
        if status.is_symlink() or not status.is_file():return False
        proof=json.loads(status.read_text())
        if proof.get('phase')!='Stopped' or proof.get('updatedAt',0)+978307200<boot:return False
    import psutil
    pid=proof.get('pid')
    if type(pid) is not int or pid<=0:raise Error('Native lease fence has no valid process identity.',409)
    if psutil.pid_exists(pid):return False # Never signal or adopt a potentially reused PID.
    if any((directory/name).is_symlink() for name in ('runtime.lock','disk.img','runner-launch.json')):
        raise Error('Native runtime fencing cannot follow symbolic links.',409)
    try:
        with HostLock(directory/'runtime.lock'):
            if not disk_closed(directory/'disk.img'):return False
            if native_fence:
                save_json(directory/'fenced-stop.json',{'boot':boot,'stoppedAt':time.time(),
                    'consistency':'crash-consistent','leaseID':machine['lease']['id']})
    except RuntimeError:return False
    return True


class NativeLeaseUpdates:
    """Independent per-assignment renewal/fence workers; never boot a guest."""
    def __init__(self,agent):
        self.agent=agent;self.workers={};self.lock=threading.Lock()

    def assignment(self,machine_id):
        with self.agent.lock:current=list(self.agent.assignments)
        return next((m for m in self.agent.lease_guard.assignments(current) if m['id']==machine_id),None)

    def update(self,machine_id):
        delay=.1;warned=False
        while not self.agent.stopping.is_set():
            try:
                machine=self.assignment(machine_id)
                if not machine or not machine.get('lease'):return
                runtime,image,folder=self.agent.context(machine)
                refresh=getattr(runtime,'refresh_execution',None)
                if not callable(refresh):return
                callback=lambda:self.agent.lease_guard.authorization(machine_id,machine['lease']['id'])
                from .assignment_gate import assignment_access
                with assignment_access(machine,folder,fencing=True):report=refresh(machine,image,folder,callback)
                if report and not machine.get('leaseCleanup'):
                    with self.agent.lock:
                        current=next((m for m in self.agent.assignments if m['id']==machine_id),None)
                        if not current or not current.get('leaseCleanup'):self.agent.reports[machine_id]=report
                delay=.1;warned=False
            except Exception:
                if not warned:logging.error('Native lease deadline update requires inspection; execution is not extended.')
                warned=True;delay=min(30,max(1,delay*2))
            self.agent.stopping.wait(delay)

    def step(self):
        with self.agent.lock:current=list(self.agent.assignments)
        assignments=self.agent.lease_guard.assignments(current)
        with self.lock:
            for machine in assignments:
                if not machine.get('lease') or machine['id'] in self.workers:continue
                runtime,_,_=self.agent.context(machine)
                if not callable(getattr(runtime,'refresh_execution',None)):continue
                worker=threading.Thread(target=self.update,args=(machine['id'],),daemon=True)
                self.workers[machine['id']]=worker
                try:worker.start()
                except RuntimeError:
                    self.workers.pop(machine['id'],None)
                    logging.error('Native lease worker unavailable; execution deadline remains unchanged.')
            for machine_id,worker in list(self.workers.items()):
                if not worker.is_alive():self.workers.pop(machine_id,None)

    def work(self):
        while not self.agent.stopping.wait(.1):
            try:self.step()
            except Exception:logging.error('Native lease supervision requires inspection; no guest is started by recovery.')

    def close(self):
        with self.lock:workers=list(self.workers.values())
        deadline=time.monotonic()+6
        for worker in workers:worker.join(max(0,deadline-time.monotonic()))
