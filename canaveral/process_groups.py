"""Signal only a still-owned child group; recovered groups are observed only."""
import ctypes
import errno
import os
import signal
import subprocess
import sys
import threading
import time

from .model import Error


_DARWIN = sys.platform == 'darwin'


def group_present(group):
    if type(group) is not int or group <= 1:
        return None
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return None


def unreaped_child(pid):
    """WNOWAIT establishes child ownership without freeing its PID for reuse."""
    if type(pid) is not int or pid <= 1:
        return False
    for _ in range(3):
        try:
            flags = os.WEXITED | os.WNOHANG | os.WNOWAIT
            if callable(getattr(os, 'waitid', None)):
                os.waitid(os.P_PID, pid, flags)
                return True
            if not _DARWIN:
                return False
            # Some Darwin Python builds omit os.waitid despite the libc API.
            # This aligned storage exceeds Darwin siginfo_t; its contents are
            # not interpreted. Only waitid's ownership/error result is used.
            storage = (ctypes.c_long * 64)()
            library = ctypes.CDLL(None, use_errno=True)
            call = library.waitid
            call.argtypes = (ctypes.c_int, ctypes.c_uint, ctypes.c_void_p, ctypes.c_int)
            call.restype = ctypes.c_int
            if call(os.P_PID, pid, ctypes.byref(storage), flags) == 0:
                return True
            if ctypes.get_errno() != errno.EINTR:
                return False
        except InterruptedError:
            continue
        except (OSError, AttributeError):
            return False
    return False


def cancellation_unknown():
    return Error('Owned helper cancellation was not confirmed; cleanup remains blocked.', 409,
                 code='helper_cancellation_uncertain', retryable=False, outcome='unknown')


class LeasedPopen(subprocess.Popen):
    """Serialize reaping against group signals while allowing active I/O cancellation."""
    def __init__(self, *args, **kwargs):
        self.group_lock = threading.RLock()
        self.isolated_group = kwargs.get('start_new_session') is True
        super().__init__(*args, **kwargs)

    def poll(self):
        with self.group_lock:
            return super().poll()

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            result = self.poll()
            if result is not None:
                return result
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(self.args, timeout)
            time.sleep(.01 if deadline is None else min(.01, max(0, deadline-time.monotonic())))

    def signal_group(self, signum):
        # The Popen wait lock also covers CPython's internal interrupt/reap path.
        with self.group_lock, self._waitpid_lock:
            if self.returncode is not None:
                if group_present(self.pid) is False:
                    return
                raise cancellation_unknown()
            if not self.isolated_group or self.pid == os.getpgrp() or not unreaped_child(self.pid):
                raise cancellation_unknown()
            try:
                # Successful start_new_session established this group before
                # exec. Darwin getpgid cannot inspect a zombie leader, but its
                # unreaped PID still reserves the group identity for us.
                os.killpg(self.pid, signum)
            except ProcessLookupError:
                if group_present(self.pid) is not False:
                    raise cancellation_unknown()
            except OSError as error:
                raise cancellation_unknown() from error

    def send_signal(self, signum):
        self.signal_group(signum)

    def terminate(self):
        self.signal_group(signal.SIGTERM)

    def kill(self):
        self.signal_group(signal.SIGKILL)
