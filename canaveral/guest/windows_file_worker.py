"""Private read-only file worker; no listener, enrollment or lease admission.

The owning guest service supplies the root, path resolver and authorization.
Child exit is not a positive native cleanup or lease-erasure receipt.
"""
import base64
import queue
import re
import subprocess
import sys
import time
import uuid

from canaveral.guest_chunk_files import CHUNK, MAX_INTEGER
from canaveral.model import Error
from .windows_downloads import WindowsDownloads, validate_request
from .windows_file_handles import WindowsRoot, component
from .windows_worker import WindowsWorker, _Work, _packet, _read_packet, _write_packet

REQUEST_BYTES, RESPONSE_BYTES = 1_400_000, 6*1048576+4096


def _parts(parts):
    if not isinstance(parts, (tuple, list)):
        raise Error('Explicit Windows path components are required.', 400)
    if sum(len(component(name))+2 for name in parts) > 65532:
        raise Error('Windows path metadata exceeds its envelope.', 400)
    return list(parts)


def _binding(drive, prefix):
    if not isinstance(drive, str) or re.fullmatch('[a-zA-Z]:', drive) is None:
        raise Error('Bind an explicit Windows drive.', 400)
    return {'drive': drive.upper(), 'prefix': _parts(prefix)}


def serve(reader, writer, factory=WindowsRoot):
    root = downloads = None
    started = closing = False
    resolved = {}
    try:
        while True:
            try: request = _read_packet(reader, REQUEST_BYTES)
            except EOFError: return
            if (set(request) != {'id', 'action', 'arguments'}
                    or not isinstance(request['id'], str) or str(uuid.UUID(request['id'])) != request['id']
                    or request['action'] not in ('open', 'files', 'close')
                    or not isinstance(request['arguments'], dict)):
                raise ValueError('Invalid file worker packet')
            action, args = request['action'], request['arguments']
            try:
                if action == 'open':
                    if started or closing or set(args) != {'drive', 'prefix'}:
                        raise Error('File worker cannot restart its root.', 409)
                    binding = _binding(args['drive'], args['prefix'])
                    started = True
                    # WindowsRoot construction opens no filesystem handles.
                    # Injected fixture factories must preserve that contract.
                    try: root = factory(binding['drive'], binding['prefix'])
                    except Exception:
                        raise Error('Windows file root construction was refused before opening.', 409) from None
                    result = root.start()
                    downloads = WindowsDownloads(root, lambda path: resolved[path], lambda: not closing,
                                                 cleanup_authorized=lambda: True)
                elif action == 'close':
                    if args: raise Error('Invalid file cleanup arguments.', 400)
                    closing = True
                    result = {'closed': root is None or root.close()}
                else:
                    if closing or downloads is None: raise Error('File worker is unavailable or fenced.', 409)
                    if set(args) != {'path', 'body', 'parts'}:
                        raise Error('Invalid file worker arguments.', 400)
                    route, _ = validate_request(args['path'], args['body'])
                    if route in ('list', 'download/begin'):
                        resolved[args['body']['path']] = _parts(args['parts'])
                    elif args['parts'] is not None:
                        raise Error('Unexpected Windows path components.', 400)
                    try: result = downloads(args['path'], args['body'])
                    finally: resolved.clear()
                response = {'id': request['id'], 'ok': True, 'result': result}
            except Error as error:
                response = {'id': request['id'], 'ok': False, 'status': error.status,
                    'code': error.code if error.code in ('input_busy', 'file_cleanup_uncertain', 'capability_unsupported') else 'file_refused',
                    'outcome': error.outcome}
            except Exception:
                response = {'id': request['id'], 'ok': False, 'status': 409,
                            'code': 'file_failed', 'outcome': 'unknown'}
            _write_packet(writer, _packet(response, RESPONSE_BYTES))
    finally:
        # Best effort only. EOF/crash or forced termination cannot turn this
        # attempt into a parent-visible positive native cleanup receipt.
        if root is not None: root.close()


class WindowsFileWorker(WindowsWorker):
    def __init__(self, drive, prefix, resolve, authorized, *, timeout=5, command=None):
        self.binding = _binding(drive, prefix)
        if not callable(resolve): raise Error('A file worker requires a path resolver.', 400)
        self.resolve = resolve
        self.ready = self.opened = self.closing = self.cleanup_confirmed = False
        self.native_cleanup_confirmed = False
        if command is None:
            if sys.platform != 'win32':
                raise Error('Native file workers require Windows.', 409, code='capability_unsupported')
            command = [sys.executable, '-m', 'canaveral.guest.windows_file_worker']
        super().__init__(authorized, timeout=timeout, command=command)

    def _pump(self):
        process = None
        try:
            while not self.closed.is_set():
                try: work = self.pending.get(timeout=.05)
                except queue.Empty:
                    if not self._allowed(): return
                    continue
                if work is None or self.closed.is_set() or not self._allowed(): return
                try:
                    if process is None:
                        process = subprocess.Popen(self.command, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                            close_fds=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                        with self.state: self.process = process
                    if self.closed.is_set() or not self._allowed() or time.monotonic() >= work.deadline:
                        work.failed = True
                        return
                    work.dispatched.set()
                    _write_packet(process.stdin, work.packet)
                    work.response = _read_packet(process.stdout, RESPONSE_BYTES)
                except Exception:
                    work.failed = True
                finally:
                    work.done.set()
                if work.failed: return
        finally:
            self.closed.set()
            self._stop_process()

    def _exchange(self, action, arguments):
        if self.closed.is_set() or not self._allowed():
            self.close()
            raise Error('Windows file authorization ended.', 410, retryable=False)
        identity = str(uuid.uuid4())
        try: packet = _packet({'id': identity, 'action': action, 'arguments': arguments}, REQUEST_BYTES)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise Error('Invalid file worker envelope.', 400) from None
        work = _Work(packet, time.monotonic()+self.timeout)
        if action == 'open': self.opened = True
        try: self.pending.put_nowait(work)  # The caller holds the sole request lane.
        except queue.Full:
            self.close()
            raise Error('Windows file worker closed before dispatch.', 410, retryable=False) from None
        while not work.done.wait(min(.05, max(0, work.deadline-time.monotonic()))):
            if self.closed.is_set() or not self._allowed() or time.monotonic() >= work.deadline: break
        if not work.done.is_set() or work.failed or self.closed.is_set() or not self._allowed():
            self.close()
            raise Error('Windows file acknowledgement was interrupted.', 503, code='worker_interrupted',
                        retryable=False, outcome='unknown' if work.dispatched.is_set() else None)
        response = work.response
        if (not isinstance(response, dict) or response.get('id') != identity
                or type(response.get('ok')) is not bool
                or (set(response) != {'id', 'ok', 'result'} if response['ok']
                    else set(response) != {'id', 'ok', 'status', 'code', 'outcome'})):
            self._invalid()
        if response['ok']:
            if not isinstance(response['result'], dict): self._invalid()
            return response['result']
        status, code, outcome = (response[key] for key in ('status', 'code', 'outcome'))
        if (type(status) is not int or status not in (400, 404, 409, 410, 503)
                or code not in ('input_busy', 'file_cleanup_uncertain', 'capability_unsupported', 'file_refused', 'file_failed')
                or outcome not in (None, 'unknown')
                or code in ('input_busy', 'file_cleanup_uncertain', 'capability_unsupported') and status != 409):
            self._invalid()
        if outcome == 'unknown' or code == 'file_failed': self.close()
        raise Error('Windows file worker refused the request.', status, code=code,
                    retryable=False, outcome=outcome)

    def _invalid(self):
        self.close()
        raise Error('Windows file worker acknowledgement is invalid.', 409, retryable=False, outcome='unknown')

    @staticmethod
    def _integer(value):
        return type(value) is int and 0 <= value <= MAX_INTEGER

    def _validate_result(self, route, identity, body, result):
        valid = False
        if route == 'list':
            valid = (result.get('path') == body['path'] and type(result.get('truncated')) is bool
                and isinstance(result.get('entries'), list) and len(result['entries']) <= 2000
                and all(isinstance(entry, dict) for entry in result['entries']))
        elif result.get('id') == identity:
            if route == 'abort':
                valid = (result == {'id': identity, 'state': 'aborted', 'bytes': 0}
                         and type(result['bytes']) is int)
            elif route == 'download/chunk':
                try:
                    encoded = result.get('data')
                    data = base64.b64decode(encoded, validate=True) if isinstance(encoded, str) and len(encoded) <= 700000 else None
                    valid = (set(result) == {'id', 'offset', 'data'} and data is not None and len(data) <= CHUNK
                        and self._integer(result['offset']) and result['offset'] == body['offset']+len(data))
                except (ValueError, TypeError): valid = False
            else:
                valid = (result.get('state') in ('reading', 'verifying', 'cleanupPending', 'verified', 'failed', 'aborted')
                    and self._integer(result.get('bytes')) and self._integer(result.get('offset'))
                    and result['offset'] <= result['bytes'] and type(result.get('cleanupPending')) is bool)
                if valid and result['state'] in ('verifying', 'cleanupPending'):
                    valid = self._integer(result.get('verified')) and result['verified'] <= result['bytes']
                if valid and result['state'] == 'verified':
                    valid = (not result['cleanupPending'] and result['offset'] == result['bytes']
                        and isinstance(result.get('sha256'), str) and re.fullmatch('[a-f0-9]{64}', result['sha256']) is not None)
                elif 'sha256' in result: valid = False
        if not valid: self._invalid()

    def __call__(self, path, body):
        route, identity = validate_request(path, body)
        if not self.busy.acquire(blocking=False):
            raise Error('Windows file worker is busy.', 409, code='input_busy', retryable=False)
        try:
            if self.closing: raise Error('Windows file worker is closing.', 410)
            if self.closed.is_set() or not self._allowed():
                self.close()
                raise Error('Windows file authorization ended.', 410, retryable=False)
            parts = _parts(self.resolve(body['path'])) if route in ('list', 'download/begin') else None
            if not self.ready:
                if self.opened: raise Error('Windows file root cannot restart.', 409)
                result = self._exchange('open', self.binding)
                if (set(result) != {'volume', 'fileId'} or type(result['volume']) is not int
                        or result['volume'] < 0 or not isinstance(result['fileId'], str) or not result['fileId']):
                    self._invalid()
                self.ready = True
            result = self._exchange('files', {'path': path, 'body': body, 'parts': parts})
            self._validate_result(route, identity, body, result)
            if not self._allowed() or self.closed.is_set():
                self.close()
                raise Error('Windows file authorization ended before acknowledgement.', 410, outcome='unknown')
            return result
        finally:
            self.busy.release()

    def shutdown(self):
        """Request native root release, then stop; forced close is never proof."""
        if self.cleanup_confirmed: return True
        if not self.busy.acquire(blocking=False): return False
        try:
            self.closing = True
            if self.native_cleanup_confirmed:
                self.cleanup_confirmed = self.close()
                return self.cleanup_confirmed
            if not self.opened:
                self.native_cleanup_confirmed = True  # No open was dispatched.
                self.cleanup_confirmed = self.close()
                return self.cleanup_confirmed
            if self.closed.is_set(): return False
            result = self._exchange('close', {})
            if set(result) != {'closed'} or type(result['closed']) is not bool: self._invalid()
            if not result['closed']: return False
            self.native_cleanup_confirmed = True
            self.cleanup_confirmed = self.close()
            return self.cleanup_confirmed
        finally:
            self.busy.release()


def main():
    try:
        serve(sys.stdin.buffer, sys.stdout.buffer)
        return 0
    except Exception:
        return 1


if __name__ == '__main__': sys.exit(main())
