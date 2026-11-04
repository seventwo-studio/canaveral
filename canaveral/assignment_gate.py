"""Shared leased work and exclusive cleanup, outside the directory being erased."""
import contextlib
import os
import threading
from pathlib import Path

from .model import Error,identifier


_work=threading.local()


def current_assignment():
    held=getattr(_work,'held',())
    return held[-1] if held else None


def paths(folder,machine_id):
    root=Path(folder).parent
    return root/'.assignment-locks'/(identifier(machine_id)+'.lock'),root/'.lease-cleanup'/(machine_id+'.json')


@contextlib.contextmanager
def assignment_access(machine,folder,exclusive=False,fencing=False):
    if not machine.get('lease'):
        yield;return
    if os.name=='nt':raise Error('Lease cleanup locking is not implemented on this host.',409,code='capability_unsupported')
    import fcntl
    lock,marker=paths(folder,machine['id'])
    lock.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    descriptor=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW,0o600)
    try:
        try:fcntl.flock(descriptor,(fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)|fcntl.LOCK_NB)
        except BlockingIOError:raise Error('Leased assignment still has active work.',409,code='assignment_busy')
        if (marker.exists() or marker.is_symlink()) and not (exclusive or fencing):raise Error('This assignment has a durable cleanup intent.',410,code='lease_ended')
        # Keep the collection itself so a streamed source can close its gate
        # from another thread without leaving a closed descriptor in this one.
        held=getattr(_work,'held',None)
        if held is None:held=_work.held=[]
        entry={'machine':machine,'folder':Path(folder),'fd':descriptor}
        if not exclusive:held.append(entry)
        try:yield
        finally:
            if not exclusive:held.remove(entry)
    finally:os.close(descriptor)


class GatedSource:
    def __init__(self,source,gate):self.source=source;self.gate=gate
    def __getattr__(self,name):return getattr(self.source,name)
    def close(self):
        try:self.source.close()
        finally:
            if self.gate:
                gate,self.gate=self.gate,None;gate.__exit__(None,None,None)
