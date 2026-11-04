"""Concurrent private ConPTY worker, not a guest listener or lease gate."""
import queue
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field

from canaveral.guest_chunk_shells import GuestChunkShells
from canaveral.model import Error
from .windows_conpty import ConPTY
from .windows_worker import WindowsWorker, _packet, _read_packet, _write_packet

REQUEST_BYTES, RESPONSE_BYTES = 65536, 98304
ACTIONS = ('open', 'read', 'write', 'resize', 'close')


def serve(reader, writer, factory=ConPTY):
    terminal, created, created_session = None, False, None
    closing = threading.Event()
    output_lock = threading.Lock()
    slots = threading.BoundedSemaphore(3)
    lanes = {key: threading.Lock() for key in ('input', 'read', 'lifecycle')}

    def respond(value):
        with output_lock:
            _write_packet(writer, _packet(value, RESPONSE_BYTES))

    def run(request, lane, target):
        action, args = request['action'], request['arguments']
        try:
            if action == 'open': result = target.start(args['cols'], args['rows'])
            elif action == 'read': result = target.read(args['offset'])
            elif action == 'write': result = target.write(args['text'])
            elif action == 'resize': result = target.resize(args['cols'], args['rows'])
            else: result = {'closed': target.close()}
            response = {'id': request['id'], 'ok': True, 'result': result}
        except Error as error:
            response = {'id': request['id'], 'ok': False, 'status': error.status,
                'code': 'native_failed', 'outcome': error.outcome}
        except Exception:
            response = {'id': request['id'], 'ok': False, 'status': 409,
                'code': 'native_failed', 'outcome': None if action == 'read' else 'unknown'}
        # Make the lane available before its acknowledgement is visible, while
        # retaining an output slot until the bounded reply has been flushed.
        lane.release()
        try: respond(response)
        finally: slots.release()

    while True:
        try:
            request = _read_packet(reader, REQUEST_BYTES)
        except EOFError:
            return
        if (set(request) != {'id', 'action', 'arguments'} or request['action'] not in ACTIONS
                or not isinstance(request['id'], str) or str(uuid.UUID(request['id'])) != request['id']
                or not isinstance(request['arguments'], dict)):
            raise ValueError('Invalid terminal worker packet')
        args, action = request['arguments'], request['action']
        expected = {'open': {'session', 'cols', 'rows', 'executable', 'argv', 'directory'},
            'read': {'session', 'offset'}, 'write': {'session', 'text'},
            'resize': {'session', 'cols', 'rows'}, 'close': {'session'}}[action]
        rejected = set(args) != expected or closing.is_set()
        # ConPTY construction opens no job, console or application. A rejected
        # constructor can positively retire that unstarted session, rather
        # than treating helper process exit as evidence of native job cleanup.
        if (not rejected and action == 'close' and created and terminal is None
                and args.get('session') == created_session):
            closing.set()
            respond({'id': request['id'], 'ok': True, 'result': {'closed': True}})
            continue
        if action == 'open': rejected = rejected or created
        else: rejected = rejected or terminal is None or args.get('session') != terminal.session
        if rejected:
            respond({'id': request['id'], 'ok': False, 'status': 409,
                     'code': 'input_rejected', 'outcome': None})
            continue
        lane = lanes['input' if action in ('write', 'resize') else 'read' if action == 'read' else 'lifecycle']
        if not lane.acquire(blocking=False):
            respond({'id': request['id'], 'ok': False, 'status': 409,
                     'code': 'input_busy', 'outcome': None})
            continue
        if not slots.acquire(blocking=False):
            lane.release()
            respond({'id': request['id'], 'ok': False, 'status': 409,
                     'code': 'input_busy', 'outcome': None})
            continue
        try:
            if action == 'open':
                created = True
                created_session = args['session']
                terminal = factory(args['session'], args['executable'], args['argv'], args['directory'])
            if action == 'close': closing.set()
        except Exception:
            lane.release()
            slots.release()
            respond({'id': request['id'], 'ok': False, 'status': 409,
                     'code': 'native_failed', 'outcome': None})
            continue
        # One operation per lane bounds outstanding native work. Reads remain
        # independent of a blocked input operation, with no global shell cap.
        threading.Thread(target=run, args=(request, lane, terminal), daemon=True).start()


@dataclass
class Pending:
    identity: str
    action: str
    packet: bytes
    deadline: float
    done: object = field(default_factory=threading.Event)
    dispatched: object = field(default_factory=threading.Event)
    response: object = None
    failed: bool = False


class WindowsTerminalWorker(WindowsWorker):
    def __init__(self, session, executable, argv, directory, authorized, *, timeout=5, command=None):
        try: self.session = str(uuid.UUID(session))
        except (ValueError, TypeError, AttributeError): raise Error('Invalid terminal session UUID.', 400)
        if command is None:
            if sys.platform != 'win32':
                raise Error('Native terminal workers require Windows.', 409, code='capability_unsupported')
            command = [sys.executable, '-m', 'canaveral.guest.windows_terminal_worker']
        self.binding = {'executable': executable, 'argv': list(argv) if isinstance(argv, list) else argv,
                        'directory': directory}
        self.inbox = queue.Queue(maxsize=3)
        self.waiting, self.receiver = {}, None
        self.lanes = {key: threading.Lock() for key in ('input', 'read', 'lifecycle')}
        self.ready = self.opened = self.closing = self.faulted = self.cleanup_confirmed = False
        super().__init__(authorized, timeout=timeout, command=command)

    def _pump(self):
        process = None
        try:
            while not self.closed.is_set():
                try: work = self.inbox.get(timeout=.05)
                except queue.Empty:
                    if not self._allowed(): return
                    continue
                if self.closed.is_set() or not self._allowed(): return
                try:
                    if process is None:
                        import subprocess
                        process = subprocess.Popen(self.command, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                            close_fds=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                        with self.state: self.process = process
                        if self.closed.is_set() or not self._allowed() or time.monotonic() >= work.deadline:
                            return
                        self.receiver = threading.Thread(target=self._receive, args=(process,), daemon=True)
                        self.receiver.start()
                    if self.closed.is_set() or not self._allowed() or time.monotonic() >= work.deadline:
                        return
                    work.dispatched.set()
                    _write_packet(process.stdin, work.packet)
                except Exception:
                    return
        finally:
            self.closed.set()
            self._stop_process()

    def _receive(self, process):
        try:
            while not self.closed.is_set():
                response = _read_packet(process.stdout, RESPONSE_BYTES)
                identity = response.get('id')
                with self.state:
                    work = self.waiting.get(identity) if isinstance(identity, str) else None
                    if work is None or work.done.is_set():
                        raise ValueError('Unknown terminal acknowledgement')
                    work.response = response
                    work.done.set()
        except Exception:
            self.closed.set()
        finally:
            self._stop_process()

    def close(self):
        stopped = super().close()
        receiver = self.receiver
        if receiver is not None and receiver is not threading.current_thread():
            receiver.join(1)
        return stopped and (receiver is None or not receiver.is_alive())

    def _exchange(self, action, arguments):
        if self.closed.is_set() or not self._allowed():
            self.close()
            raise Error('Windows terminal authorization ended.', 410, retryable=False)
        identity = str(uuid.uuid4())
        try:
            packet = _packet({'id': identity, 'action': action, 'arguments': arguments}, REQUEST_BYTES)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise Error('Invalid terminal worker request envelope.', 400) from None
        if action == 'open': self.opened = True
        work = Pending(identity, action, packet, time.monotonic()+self.timeout)
        with self.state: self.waiting[identity] = work
        try:
            try: self.inbox.put_nowait(work)
            except queue.Full:
                raise Error('Terminal control buffers are busy.', 409, code='input_busy', retryable=False)
            while not work.done.wait(min(.05, max(0, work.deadline-time.monotonic()))):
                if self.closed.is_set() or not self._allowed() or time.monotonic() >= work.deadline: break
            if not work.done.is_set() or self.closed.is_set() or not self._allowed():
                self.close()
                raise Error('Windows terminal acknowledgement was interrupted.', 503, retryable=False,
                    outcome='unknown' if action != 'read' and work.dispatched.is_set() else None)
            response = work.response
            if (type(response.get('ok')) is not bool or response.get('id') != identity
                    or (set(response) != {'id', 'ok', 'result'} if response['ok']
                        else set(response) != {'id', 'ok', 'status', 'code', 'outcome'})):
                self.close()
                raise Error('Windows terminal acknowledgement is invalid.', 409, retryable=False,
                            outcome='unknown' if action != 'read' else None)
            if response['ok']:
                if not isinstance(response['result'], dict):
                    self.close()
                    raise Error('Invalid terminal result.', 409, retryable=False,
                                outcome='unknown' if action != 'read' else None)
                return response['result']
            code, status, outcome = (response[key] for key in ('code', 'status', 'outcome'))
            if (code not in ('input_busy', 'input_rejected', 'native_failed')
                    or type(status) is not int or status not in (400, 404, 409, 410, 503)
                    or outcome not in (None, 'unknown')
                    or code != 'native_failed' and (status != 409 or outcome is not None)):
                self.close()
                raise Error('Invalid terminal refusal.', 409, retryable=False,
                            outcome='unknown' if action != 'read' else None)
            raise Error('Windows terminal request was refused.', status, code=code, retryable=False,
                        outcome='unknown' if action != 'read' and code == 'native_failed' else outcome)
        finally:
            with self.state: self.waiting.pop(identity, None)

    def control(self, action, arguments):
        route = {'shell-open': 'open', 'shell-read': 'read', 'shell-write': 'write',
                 'shell-resize': 'resize', 'shell-close': 'close'}.get(action)
        if route is None: raise Error('Invalid terminal operation.', 400)
        lane = self.lanes['input' if route in ('write', 'resize') else 'read' if route == 'read' else 'lifecycle']
        if not lane.acquire(blocking=False):
            raise Error('Windows terminal operation is busy.', 409, code='input_busy', retryable=False)
        received = False
        def request(path, values):
            nonlocal received
            if values['session'] != self.session:
                raise Error('This terminal belongs to another session.', 409, code='input_rejected')
            if route == 'close' and self.cleanup_confirmed:
                return {'closed': True}  # Owned cleanup receipt, no native replay.
            if route == 'open':
                if self.opened: raise Error('Terminal session cannot be restarted.', 409, code='input_rejected')
                values = {**values, **self.binding}
            elif route != 'close' and (not self.ready or self.closing or self.faulted and route != 'read'):
                raise Error('Terminal input is unavailable or fenced.', 409, code='input_rejected')
            if route == 'close':
                if not self.opened:
                    raise Error('This terminal has not been opened.', 404, code='input_rejected')
                self.closing = True
            result = self._exchange(route, values)
            received = True
            return result
        try:
            result = GuestChunkShells(request).control(action, arguments)
            if route == 'open': self.ready = True
            if route == 'close':
                if not self.close():
                    raise Error('Terminal worker exit remains unconfirmed.', 409, retryable=False, outcome='unknown')
                self.cleanup_confirmed = True
            return result
        except Error as error:
            if error.outcome == 'unknown': self.faulted = True
            if received:
                self.close()
                raise Error('Terminal result validation or cleanup was not confirmed.', error.status,
                            retryable=False, outcome='unknown' if route != 'read' else None) from error
            raise
        finally:
            lane.release()


def main():
    try:
        serve(sys.stdin.buffer, sys.stdout.buffer)
        return 0
    except Exception:
        return 1


if __name__ == '__main__':
    sys.exit(main())
