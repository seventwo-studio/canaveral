"""Suspend-aware elapsed time for execution authorization, never wall time."""
import ctypes
import functools
import sys
import time

from .model import Error


@functools.lru_cache(maxsize=1)
def darwin_clock():
    class Timebase(ctypes.Structure):
        _fields_=[('numer',ctypes.c_uint32),('denom',ctypes.c_uint32)]
    library=ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    ticks=library.mach_continuous_time;ticks.argtypes=[];ticks.restype=ctypes.c_uint64
    info=library.mach_timebase_info;info.argtypes=[ctypes.POINTER(Timebase)];info.restype=ctypes.c_int
    scale=Timebase()
    if info(ctypes.byref(scale)) or not scale.numer or not scale.denom:
        raise Error('A continuous execution clock is unavailable.',409)
    return ticks,scale.numer/scale.denom/1_000_000_000


def execution_monotonic():
    if sys.platform=='darwin':
        ticks,scale=darwin_clock()
        return ticks()*scale
    if sys.platform.startswith('linux'):
        clock=getattr(time,'CLOCK_BOOTTIME',None)
        if clock is None:raise Error('This host has no suspend-aware execution clock.',409)
        return time.clock_gettime(clock)
    return time.monotonic()


def contact_fresh(last_contact):
    """Fresh controller contact in the same suspend-aware clock domain."""
    if type(last_contact) not in (int,float) or last_contact<=0:return False
    elapsed=execution_monotonic()-last_contact
    return 0<=elapsed<20
