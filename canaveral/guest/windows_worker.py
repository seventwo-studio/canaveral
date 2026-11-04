"""Private persistent UIA worker IPC; no listener, enrollment or admission.

Only the child owns COM handles. The parent supervises one retained subprocess,
never a saved PID or a desktop application. Killing this worker cannot undo a
native invocation or establish guest/lease fencing.
"""
import json
import math
import queue
import struct
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field

from canaveral.inspection_protocol import MAX_BYTES, validate_snapshot
from canaveral.model import Error
from .windows_accessibility import WindowsInspections, native_api


MAX_REQUEST = 16384
MAX_RESPONSE = MAX_BYTES + 4096


def _read_exact(reader, length):
    result = bytearray()
    while len(result) < length:
        data = reader.read(length-len(result))
        if not data:
            raise EOFError('Worker packet was truncated')
        result.extend(data)
    return bytes(result)


def _packet(value, limit):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False,
                     separators=(',', ':')).encode('utf-8')
    if len(raw) > limit:
        raise ValueError('Worker packet exceeds its envelope')
    return struct.pack('!I', len(raw)) + raw


def _read_packet(reader, limit):
    length, = struct.unpack('!I', _read_exact(reader, 4))
    if not 0 < length <= limit:
        raise ValueError('Worker packet exceeds its envelope')
    def invalid(value):
        raise ValueError('Invalid JSON number')
    value = json.loads(_read_exact(reader, length), parse_constant=invalid)
    if not isinstance(value, dict):
        raise ValueError('Invalid worker packet')
    return value


def _write_packet(writer, packet):
    pending = memoryview(packet)
    while pending:
        count = writer.write(pending)
        if not count:
            raise EOFError('Worker pipe closed')
        pending = pending[count:]
    writer.flush()


def serve(reader, writer, api_context=native_api):
    """One MTA thread keeps the same UIA handles until refresh/action/exit."""
    with api_context() as api:
        inspections = WindowsInspections(api)
        while True:
            try:
                request = _read_packet(reader, MAX_REQUEST)
            except EOFError:
                return
            if (set(request) != {'id', 'action', 'arguments'} or not isinstance(request['id'], str)
                    or str(uuid.UUID(request['id'])) != request['id']
                    or request['action'] not in ('inspect', 'invoke')
                    or not isinstance(request['arguments'], dict)):
                raise ValueError('Invalid worker request')
            try:
                if request['action'] == 'inspect':
                    if request['arguments']:
                        raise Error('Inspection arguments are invalid.', 400)
                    result = inspections.inspect()
                else:
                    result = inspections.invoke(request['arguments'])
                response = {'id': request['id'], 'ok': True, 'result': result}
            except Error as error:
                response = {'id': request['id'], 'ok': False, 'status': error.status,
                    'code': 'input_rejected' if error.code == 'input_rejected' else 'worker_refused',
                    'outcome': error.outcome}
            except Exception:
                response = {'id': request['id'], 'ok': False, 'status': 503,
                    'code': 'worker_failed', 'outcome': 'unknown' if request['action'] == 'invoke' else None}
            _write_packet(writer, _packet(response, MAX_RESPONSE))


@dataclass
class _Work:
    packet: bytes
    deadline: float
    done: object = field(default_factory=threading.Event)
    dispatched: object = field(default_factory=threading.Event)
    response: object = None
    failed: bool = False


class WindowsWorker:
    def __init__(self, authorized, *, timeout=5, command=None):
        if not callable(authorized):
            raise Error('A worker requires assignment authorization.', 400)
        if type(timeout) not in (float, int) or not math.isfinite(timeout) or not 0 < timeout <= 30:
            raise Error('Invalid Windows worker timeout.', 400)
        if command is None:
            if sys.platform != 'win32':
                raise Error('The native worker requires Windows.', 409, code='capability_unsupported')
            command = [sys.executable, '-m', 'canaveral.guest.windows_worker']
        if not isinstance(command, list) or not command or any(not isinstance(s, str) or not s for s in command):
            raise Error('Invalid internal worker command.', 400)
        self.authorized, self.timeout, self.command = authorized, timeout, tuple(command)
        self.closed = threading.Event()
        self.pending = queue.Queue(maxsize=1)
        self.busy, self.state, self.stopping = threading.Lock(), threading.Lock(), threading.Lock()
        self.process = None
        self.thread = threading.Thread(target=self._pump, name='canaveral-uia-pipe', daemon=True)
        self.thread.start()

    def _allowed(self):
        try:
            return bool(self.authorized())
        except Exception:
            return False

    def _pump(self):
        process = None
        try:
            while not self.closed.is_set():
                try:
                    work = self.pending.get(timeout=.05)
                except queue.Empty:
                    if not self._allowed():
                        return
                    continue
                if work is None or self.closed.is_set() or not self._allowed():
                    return
                try:
                    if process is None:
                        process = subprocess.Popen(self.command, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                            close_fds=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                        with self.state:
                            self.process = process
                    if self.closed.is_set() or not self._allowed() or time.monotonic() >= work.deadline:
                        work.failed = True
                        return
                    work.dispatched.set()
                    _write_packet(process.stdin, work.packet)
                    work.response = _read_packet(process.stdout, MAX_RESPONSE)
                except Exception:
                    work.failed = True
                finally:
                    work.done.set()
                if work.failed:
                    return
        finally:
            self.closed.set()
            self._stop_process()

    def _stop_process(self):
        with self.stopping:
            with self.state:
                process = self.process
            if process is None:
                return True
            try:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=.25)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=.5)
                return process.poll() is not None
            except (OSError, subprocess.TimeoutExpired):
                return False
            finally:
                # Close pipes only after stop; a native call must not leave a
                # reader or a partially blocked stdin writer holding the API.
                if process.poll() is not None:
                    process.stdin.close()
                    process.stdout.close()

    def close(self):
        self.closed.set()
        try:
            self.pending.put_nowait(None)
        except queue.Full:
            pass
        stopped = self._stop_process()
        if threading.current_thread() is not self.thread:
            self.thread.join(1)
        # A late process creation is stopped by the pump before it can dispatch.
        return stopped and not self.thread.is_alive()

    def _request(self, action, arguments):
        if not self.busy.acquire(blocking=False):
            raise Error('Windows inspection worker is busy.', 409, code='input_busy', retryable=False)
        work = None
        try:
            if self.closed.is_set() or not self._allowed():
                self.close()
                raise Error('Windows worker authorization ended.', 410, retryable=False)
            request_id = str(uuid.uuid4())
            try:
                packet = _packet({'id': request_id, 'action': action, 'arguments': arguments}, MAX_REQUEST)
            except (ValueError, TypeError, UnicodeError, RecursionError) as error:
                raise Error('Windows worker request is invalid or oversized.', 400) from error
            deadline = time.monotonic() + self.timeout
            work = _Work(packet, deadline)
            try:
                self.pending.put_nowait(work)
            except queue.Full:
                self.close()
                raise Error('Windows worker closed before dispatch.', 410, retryable=False) from None
            while not work.done.wait(min(.05, max(0, deadline-time.monotonic()))):
                if self.closed.is_set() or not self._allowed() or time.monotonic() >= deadline:
                    break
            if (not work.done.is_set() or work.failed or self.closed.is_set() or not self._allowed()):
                self.close()
                raise Error('Windows worker response was not confirmed; inspect before another action.',
                    503, code='worker_interrupted', retryable=False,
                    outcome='unknown' if action == 'invoke' and work.dispatched.is_set() else None)
            response = work.response
            if (not isinstance(response, dict) or response.get('id') != request_id
                    or type(response.get('ok')) is not bool):
                self.close()
                raise Error('Windows worker acknowledgement is invalid.', 409, retryable=False,
                            outcome='unknown' if action == 'invoke' else None)
            if response['ok']:
                if set(response) != {'id', 'ok', 'result'} or not isinstance(response['result'], dict):
                    self.close()
                    raise Error('Windows worker result is invalid.', 409, retryable=False,
                                outcome='unknown' if action == 'invoke' else None)
                if action == 'invoke' and response['result'] != {'status': 'posted'}:
                    self.close()
                    raise Error('Windows native invocation acknowledgement is invalid.', 409,
                                retryable=False, outcome='unknown')
                return response['result']
            if (set(response) != {'id', 'ok', 'status', 'code', 'outcome'}
                    or type(response['status']) is not int or response['status'] not in (400, 409, 410, 503)
                    or response['code'] not in ('input_rejected', 'worker_refused', 'worker_failed')
                    or response['outcome'] not in (None, 'unknown')):
                self.close()
                raise Error('Windows worker refusal is invalid.', 409, retryable=False,
                            outcome='unknown' if action == 'invoke' else None)
            if response['code'] == 'input_rejected' and (response['status'] != 409 or response['outcome'] is not None):
                self.close()
                raise Error('Windows worker pre-effect refusal is invalid.', 409, retryable=False,
                            outcome='unknown' if action == 'invoke' else None)
            raise Error('Windows native action requires a fresh inspection.' if response['code'] == 'input_rejected'
                        else 'Windows native worker refused the request.', response['status'],
                        code=response['code'], retryable=False, outcome=(
                            'unknown' if action == 'invoke' and response['code'] != 'input_rejected'
                            else response['outcome']))
        finally:
            self.busy.release()

    def inspect(self):
        value = self._request('inspect', {})
        try:
            validate_snapshot(value)
            if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_BYTES:
                raise ValueError('Oversized native snapshot')
            if value['source'] != 'windows-uia' or value['coordinateSpace'] != 'screen-pixels':
                raise ValueError('Wrong native source')
        except (Error, ValueError):
            self.close()
            raise Error('Windows worker returned an invalid native snapshot.', 409) from None
        return value

    def invoke(self, snapshot_id, node_id, native_action):
        return self._request('invoke', {'snapshotId': snapshot_id, 'nodeId': node_id,
                                        'nativeAction': native_action})


def main():
    try:
        serve(sys.stdin.buffer, sys.stdout.buffer)
        return 0
    except Exception:
        return 1  # No private COM exception text enters the IPC or HTTP surface.


if __name__ == '__main__':
    sys.exit(main())
