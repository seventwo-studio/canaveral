"""Owned Windows ConPTY source component; run inside a supervised guest worker.

Native creation/pipe/close calls can block. This is not a host shell adapter,
guest bootstrap, lease deadline implementation or completed terminal service.
"""
import base64
import ctypes as c
from pathlib import PureWindowsPath
import subprocess
import sys
import threading
import time
import uuid

from canaveral.model import Error

U32, I32, U16, I16, H, SIZE = c.c_uint32, c.c_int32, c.c_uint16, c.c_int16, c.c_void_p, c.c_size_t


class COORD(c.Structure):
    _fields_ = [('X', I16), ('Y', I16)]


class STARTUPINFO(c.Structure):
    _fields_ = [('cb', U32), ('lpReserved', H), ('lpDesktop', H), ('lpTitle', H),
        *[(name, U32) for name in ('dwX', 'dwY', 'dwXSize', 'dwYSize', 'dwXCountChars',
                                  'dwYCountChars', 'dwFillAttribute', 'dwFlags')],
        ('wShowWindow', U16), ('cbReserved2', U16), ('lpReserved2', H),
        ('hStdInput', H), ('hStdOutput', H), ('hStdError', H)]


class STARTUPINFOEX(c.Structure):
    _fields_ = [('StartupInfo', STARTUPINFO), ('lpAttributeList', H)]


class PROCESS_INFORMATION(c.Structure):
    _fields_ = [('hProcess', H), ('hThread', H), ('dwProcessId', U32), ('dwThreadId', U32)]


class JOB_LIMITS(c.Structure):
    _fields_ = [('PerProcessUserTimeLimit', c.c_int64), ('PerJobUserTimeLimit', c.c_int64),
        ('LimitFlags', U32), ('MinimumWorkingSetSize', SIZE), ('MaximumWorkingSetSize', SIZE),
        ('ActiveProcessLimit', U32), ('Affinity', SIZE), ('PriorityClass', U32), ('SchedulingClass', U32)]


class JOB_EXTENDED(c.Structure):
    _fields_ = [('BasicLimitInformation', JOB_LIMITS), ('IoInfo', c.c_uint64*6),
        ('ProcessMemoryLimit', SIZE), ('JobMemoryLimit', SIZE),
        ('PeakProcessMemoryUsed', SIZE), ('PeakJobMemoryUsed', SIZE)]


class JOB_ACCOUNTING(c.Structure):
    _fields_ = [('Times', c.c_int64*4), ('TotalPageFaultCount', U32),
        ('TotalProcesses', U32), ('ActiveProcesses', U32), ('TotalTerminatedProcesses', U32)]


class Win32ConPTY:
    def __init__(self):
        if sys.platform != 'win32' or c.sizeof(H) != 8:
            raise Error('ConPTY requires a 64-bit owned Windows guest worker.', 409,
                        code='capability_unsupported')
        self.k = c.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'CreatePipe': ([c.POINTER(H), c.POINTER(H), H, U32], I32),
            'CreatePseudoConsole': ([COORD, H, H, U32, c.POINTER(H)], I32),
            'ResizePseudoConsole': ([H, COORD], I32), 'ClosePseudoConsole': ([H], None),
            'CreateJobObjectW': ([H, c.c_wchar_p], H),
            'SetInformationJobObject': ([H, I32, H, U32], I32),
            'QueryInformationJobObject': ([H, I32, H, U32, c.POINTER(U32)], I32),
            'TerminateJobObject': ([H, U32], I32),
            'InitializeProcThreadAttributeList': ([H, U32, U32, c.POINTER(SIZE)], I32),
            'UpdateProcThreadAttribute': ([H, U32, SIZE, H, SIZE, H, H], I32),
            'DeleteProcThreadAttributeList': ([H], None),
            'CreateProcessW': ([c.c_wchar_p, c.c_wchar_p, H, H, I32, U32, H,
                                c.c_wchar_p, H, c.POINTER(PROCESS_INFORMATION)], I32),
            'IsProcessInJob': ([H, H, c.POINTER(I32)], I32), 'ResumeThread': ([H], U32),
            'ReadFile': ([H, H, U32, c.POINTER(U32), H], I32),
            'WriteFile': ([H, H, U32, c.POINTER(U32), H], I32),
            'WaitForSingleObject': ([H, U32], U32), 'GetExitCodeProcess': ([H, c.POINTER(U32)], I32),
            'CloseHandle': ([H], I32)}
        try:
            for name, (arguments, result) in signatures.items():
                function = getattr(self.k, name)
                function.argtypes, function.restype = arguments, result
        except AttributeError as error:
            raise Error('Required Windows ConPTY APIs are unavailable.', 409,
                        code='capability_unsupported') from error

    @staticmethod
    def check(value):
        if not value:
            raise OSError('Owned Windows terminal operation failed')

    def pipe(self):
        read, write = H(), H()
        self.check(self.k.CreatePipe(c.byref(read), c.byref(write), None, 0))
        return read.value, write.value

    def job(self):
        job = self.k.CreateJobObjectW(None, None)
        self.check(job)
        return job

    def configure_job(self, job):
        limits = JOB_EXTENDED()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE; no breakaway.
        self.check(self.k.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)))

    def console(self, columns, rows, input_read, output_write):
        handle = H()
        if self.k.CreatePseudoConsole(COORD(columns, rows), input_read, output_write, 0, c.byref(handle)) < 0:
            raise OSError('Windows pseudoconsole creation failed')
        return handle.value

    def launch(self, executable, argv, directory, console, job):
        size = SIZE()
        self.k.InitializeProcThreadAttributeList(None, 2, 0, c.byref(size))
        if not 0 < size.value <= 1048576:
            raise OSError('Windows startup attribute size is invalid')
        storage = c.create_string_buffer(size.value)
        self.check(self.k.InitializeProcThreadAttributeList(storage, 2, 0, c.byref(size)))
        jobs = (H*1)(job)
        try:
            # The process is born inside its job, avoiding an unassigned child
            # if the worker dies between CreateProcess and a later assignment.
            self.check(self.k.UpdateProcThreadAttribute(storage, 0, 0x2000D,
                c.cast(jobs, H), c.sizeof(jobs), None, None))
            self.check(self.k.UpdateProcThreadAttribute(storage, 0, 0x20016,
                H(console), c.sizeof(H), None, None))
            startup = STARTUPINFOEX()
            startup.StartupInfo.cb = c.sizeof(startup)
            startup.lpAttributeList = c.cast(storage, H)
            process = PROCESS_INFORMATION()
            command = c.create_unicode_buffer(subprocess.list2cmdline(argv))
            self.check(self.k.CreateProcessW(executable, command, None, None, False,
                0x80000 | 0x4, None, directory, c.byref(startup), c.byref(process)))
            # Return handles before verifying/resuming so the owner retains
            # cleanup authority if any subsequent native operation fails.
            return process.hProcess, process.hThread
        finally:
            self.k.DeleteProcThreadAttributeList(storage)

    def resume(self, process, thread, job):
        belongs = I32()
        self.check(self.k.IsProcessInJob(process, job, c.byref(belongs)))
        self.check(belongs.value)
        if self.k.ResumeThread(thread) == 0xFFFFFFFF:
            raise OSError('Owned Windows terminal resume failed')

    def read(self, handle):
        buffer, count = c.create_string_buffer(4096), U32()
        if not self.k.ReadFile(handle, buffer, len(buffer), c.byref(count), None):
            if c.get_last_error() in (109, 232):  # broken/no-data pipe
                return b''
            raise OSError('Owned Windows terminal output failed')
        return buffer.raw[:count.value]

    def write(self, handle, data):
        buffer, count = c.create_string_buffer(data), U32()
        self.check(self.k.WriteFile(handle, buffer, len(data), c.byref(count), None))
        return count.value

    def resize(self, console, columns, rows):
        if self.k.ResizePseudoConsole(console, COORD(columns, rows)) < 0:
            raise OSError('Owned Windows terminal resize failed')

    def empty(self, job):
        state = JOB_ACCOUNTING()
        self.check(self.k.QueryInformationJobObject(job, 1, c.byref(state), c.sizeof(state), None))
        return state.ActiveProcesses == 0

    def terminate(self, job):
        self.check(self.k.TerminateJobObject(job, 1))

    def exit_code(self, process):
        if self.k.WaitForSingleObject(process, 0) != 0:
            return None
        code = U32()
        self.check(self.k.GetExitCodeProcess(process, c.byref(code)))
        return code.value

    def close_console(self, console):
        self.k.ClosePseudoConsole(console)

    def close_handle(self, handle):
        self.check(self.k.CloseHandle(handle))


class ConPTY:
    """One session, its own job and output reader; no global session-count cap."""
    def __init__(self, session, executable, argv, directory, *, api=None):
        try:
            self.session = str(uuid.UUID(session))
        except (ValueError, TypeError, AttributeError):
            raise Error('A Windows terminal requires a session UUID.', 400)
        if (not isinstance(executable, str) or not PureWindowsPath(executable).is_absolute()
                or not isinstance(directory, str) or not PureWindowsPath(directory).is_absolute()
                or not isinstance(argv, list) or not argv or argv[0] != executable
                or any(not isinstance(s, str) or '\0' in s for s in argv+[directory])
                or len(subprocess.list2cmdline(argv)) > 30000):
            raise Error('Use explicit absolute guest executable and working-directory bindings.', 400)
        self.api = api if api is not None else Win32ConPTY()
        self.executable, self.argv, self.directory = executable, list(argv), directory
        self.handles = dict.fromkeys(('job', 'input_read', 'input_write', 'output_read',
                                     'output_write', 'console', 'process', 'thread'))
        self.lock, self.write_lock, self.close_lock = threading.Lock(), threading.Lock(), threading.RLock()
        self.reader, self.reader_done = None, threading.Event()
        self.data, self.base = bytearray(), 0
        self.started = self.fenced = self.output_failed = False

    @staticmethod
    def dimensions(columns, rows):
        if any(type(n) is not int or not 1 <= n <= 500 for n in (columns, rows)):
            raise Error('Terminal dimensions must be integers from 1 through 500.', 400)

    def start(self, columns=80, rows=24):
        with self.close_lock:
            return self._start(columns, rows)

    def _start(self, columns, rows):
        self.dimensions(columns, rows)
        if self.started or self.fenced:
            raise Error('A Windows terminal cannot be restarted or adopted.', 409)
        self.started = True
        try:
            h = self.handles
            h['job'] = self.api.job()
            self.api.configure_job(h['job'])
            h['input_read'], h['input_write'] = self.api.pipe()
            h['output_read'], h['output_write'] = self.api.pipe()
            h['console'] = self.api.console(columns, rows, h['input_read'], h['output_write'])
            self.reader = threading.Thread(target=self._drain, daemon=True, name='canaveral-conpty-output')
            self.reader.start()
            if self.fenced:
                raise OSError('Terminal closed during startup')
            h['process'], h['thread'] = self.api.launch(self.executable, self.argv, self.directory,
                                                      h['console'], h['job'])
            if self.fenced:
                raise OSError('Terminal closed before resume')
            self.api.resume(h['process'], h['thread'], h['job'])
            if self.fenced:
                raise OSError('Terminal closed before startup acknowledgement')
            self._release('input_read')
            self._release('output_write')
            return {'session': self.session}
        except Exception as error:
            self.fenced = True
            confirmed = self.close()
            raise Error('Windows terminal startup failed; owned cleanup ' +
                        ('was confirmed.' if confirmed else 'remains unconfirmed.'), 409,
                        retryable=False, outcome=None if confirmed else 'unknown') from error

    def _release(self, key):
        handle = self.handles[key]
        if handle is not None:
            self.api.close_handle(handle)
            self.handles[key] = None

    def _drain(self):
        try:
            while True:
                data = self.api.read(self.handles['output_read'])
                if not data:
                    break
                if not isinstance(data, bytes) or len(data) > 4096:
                    raise ValueError('Invalid terminal output chunk')
                with self.lock:
                    self.data.extend(data)
                    excess = max(0, len(self.data)-65536)
                    del self.data[:excess]
                    self.base += excess
        except Exception:
            self.output_failed = self.fenced = True
        finally:
            self.reader_done.set()

    def read(self, offset=0):
        with self.close_lock:
            return self._read_snapshot(offset)

    def _read_snapshot(self, offset):
        if not self.started or self.handles['job'] is None:
            raise Error('This Windows terminal has no live session context.', 410)
        if type(offset) is not int or not 0 <= offset <= 2**53-1:
            raise Error('Invalid terminal output offset.', 400)
        with self.lock:
            end = self.base+len(self.data)
            if offset > end:
                raise Error('Terminal output offset is ahead of this session.', 409)
            begin = max(offset, self.base)
            data = bytes(self.data[begin-self.base:])
        if self.output_failed:
            raise Error('Windows terminal output was interrupted.', 409, retryable=False)
        exited = (self.started and self.handles['job'] is not None and self.reader_done.is_set()
                  and self.api.empty(self.handles['job']))
        return {'session': self.session, 'data': base64.b64encode(data).decode(), 'offset': end,
            'truncated': offset < self.base, 'exited': bool(exited),
            'exitCode': self.api.exit_code(self.handles['process']) if exited and self.handles['process'] else None}

    def write(self, text):
        if not isinstance(text, str) or '\0' in text:
            raise Error('Invalid Windows terminal input.', 400)
        try:
            data = text.encode('utf-8')
        except UnicodeError:
            raise Error('Invalid Windows terminal Unicode.', 400) from None
        if len(data) > 16384:
            raise Error('Terminal input exceeds its bounded message envelope.', 400)
        with self.write_lock:
            if self.fenced or not self.started or self.handles['input_write'] is None:
                raise Error('Windows terminal input is fenced.', 410)
            sent = 0
            try:
                while sent < len(data):
                    if self.fenced:
                        raise OSError('Terminal closed during input')
                    count = self.api.write(self.handles['input_write'], data[sent:])
                    if type(count) is not int or not 0 < count <= len(data)-sent:
                        raise OSError('Invalid terminal input acknowledgement')
                    sent += count
                if self.fenced:
                    raise OSError('Terminal closed before input acknowledgement')
            except Exception as error:
                self.fenced = True
                raise Error('Windows terminal input was not confirmed; inspect before another command.',
                            409, retryable=False, outcome='unknown') from error
        return {'written': sent}

    def resize(self, columns, rows):
        self.dimensions(columns, rows)
        with self.write_lock:
            if self.fenced or self.handles['console'] is None:
                raise Error('Windows terminal input is fenced.', 410)
            try:
                self.api.resize(self.handles['console'], columns, rows)
                if self.fenced:
                    raise OSError('Terminal closed before resize acknowledgement')
            except Exception as error:
                self.fenced = True
                raise Error('Windows terminal resize was not confirmed.', 409,
                            retryable=False, outcome='unknown') from error
        return {'resized': True}

    def close(self):
        self.fenced = True
        with self.close_lock:
            h = self.handles
            try:
                if h['job'] is not None and not self.api.empty(h['job']):
                    self.api.terminate(h['job'])
                    deadline = time.monotonic()+2
                    while not self.api.empty(h['job']):
                        if time.monotonic() >= deadline:
                            return False
                        time.sleep(.01)
                # Never release/reuse a handle while WriteFile or resize is
                # still using it. A stuck native caller remains unconfirmed.
                if not self.write_lock.acquire(timeout=2):
                    return False
                try:
                    return self._finish_close()
                finally:
                    self.write_lock.release()
            except Exception:
                return False

    def _finish_close(self):
        h = self.handles
        # A failed/absent reader cannot drain shutdown output. Close that read
        # end first, as required by ClosePseudoConsole.
        if self.reader is None or self.reader_done.is_set():
            self._release('output_read')
        if h['console'] is not None:
            self.api.close_console(h['console'])
            h['console'] = None
        self._release('output_write')
        if self.reader is not None:
            self.reader.join(2)
            if self.reader.is_alive():
                return False
        for key in ('output_read', 'input_read', 'input_write', 'thread', 'process', 'job'):
            self._release(key)
        return True
