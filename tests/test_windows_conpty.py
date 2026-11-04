"""Native-shaped API doubles; no Windows handles or host shells are opened."""
import base64
import ctypes
import queue
import sys
import threading
import time
import unittest
import uuid
from types import SimpleNamespace

from canaveral.guest.windows_conpty import ConPTY, Win32ConPTY, COORD, STARTUPINFOEX, JOB_EXTENDED
from canaveral.model import Error


class API:
    def __init__(self):
        self.next = 0
        self.handles = set()
        self.events = []
        self.output = queue.Queue()
        self.active = False
        self.failure = None
        self.inputs = bytearray()
        self.partial = None
        self.block_write = None

    def allocate(self):
        self.next += 1
        self.handles.add(self.next)
        return self.next

    def check(self, stage):
        self.events.append(stage)
        if self.failure == stage:
            raise OSError('private native path or token')

    def job(self):
        self.check('job')
        return self.allocate()

    def configure_job(self, job):
        self.check('configure_job')

    def pipe(self):
        self.check('pipe')
        return self.allocate(), self.allocate()

    def console(self, columns, rows, input_read, output_write):
        self.check('console')
        return self.allocate()

    def launch(self, executable, argv, directory, console, job):
        self.check('launch')
        self.active = True
        return self.allocate(), self.allocate()

    def resume(self, process, thread, job):
        self.check('resume')

    def read(self, handle):
        value = self.output.get(timeout=5)
        if isinstance(value, Exception):
            raise value
        return value

    def write(self, handle, data):
        self.check('write')
        if self.block_write:
            self.block_write.wait(3)
        count = len(data) if self.partial is None else min(self.partial, len(data))
        self.inputs.extend(data[:count])
        return count

    def resize(self, console, columns, rows):
        self.check('resize')
        self.size = (columns, rows)

    def empty(self, job):
        self.check('empty')
        return not self.active

    def terminate(self, job):
        self.check('terminate')
        self.active = False

    def exit_code(self, process):
        return 0

    def close_console(self, console):
        self.check('close_console')
        self.handles.remove(console)
        self.output.put(b'')

    def close_handle(self, handle):
        self.check('close_handle')
        self.handles.remove(handle)


class WindowsConPTYTests(unittest.TestCase):
    def terminal(self, api=None):
        api = api or API()
        terminal = ConPTY(str(uuid.uuid4()), r'C:\Windows\System32\cmd.exe',
            [r'C:\Windows\System32\cmd.exe'], r'C:\Users\guest', api=api)
        self.addCleanup(terminal.close)
        return terminal, api

    def wait_output(self, terminal, end):
        deadline = time.monotonic()+2
        while time.monotonic() < deadline:
            result = terminal.read()
            if result['offset'] == end:
                return result
            time.sleep(.005)
        self.fail('Fixture output did not drain')

    def test_native_structures_use_explicit_windows_widths_on_development_host(self):
        self.assertEqual(ctypes.sizeof(COORD), 4)
        if ctypes.sizeof(ctypes.c_void_p) == 8:
            self.assertEqual(ctypes.sizeof(STARTUPINFOEX), 112)
            self.assertEqual(ctypes.sizeof(JOB_EXTENDED), 144)

    def test_start_resize_unicode_partial_writes_and_positive_cleanup(self):
        terminal, api = self.terminal()
        self.assertEqual(terminal.start(100, 30), {'session': terminal.session})
        api.partial = 2
        self.assertEqual(terminal.write('héllo'), {'written': 6})
        self.assertEqual(api.inputs, 'héllo'.encode())
        self.assertEqual(terminal.resize(120, 40), {'resized': True})
        self.assertEqual(api.size, (120, 40))
        self.assertLess(api.events.index('launch'), api.events.index('resume'))
        self.assertTrue(terminal.close())

    def test_common_native_shell_adapter_accepts_conpty_lifecycle_and_cursors(self):
        from canaveral.guest_chunk_shells import GuestChunkShells
        terminal, api = self.terminal()
        def request(path, body):
            self.assertEqual(body['session'], terminal.session)
            if path.endswith('/open'):
                return terminal.start(body['cols'], body['rows'])
            if path.endswith('/write'):
                return terminal.write(body['text'])
            if path.endswith('/read'):
                return terminal.read(body['offset'])
            if path.endswith('/resize'):
                return terminal.resize(body['cols'], body['rows'])
            if path.endswith('/close'):
                return {'closed': terminal.close()}
            self.fail(path)
        adapter = GuestChunkShells(request)
        args = {'session': terminal.session}
        self.assertEqual(adapter.control('shell-open', args), args)
        text = 'λ'*6000
        self.assertEqual(adapter.control('shell-write', {**args, 'text': text}), {'written': 12000})
        api.output.put(b'hello')
        self.wait_output(terminal, 5)
        result = adapter.control('shell-read', {**args, 'offset': 0})
        self.assertEqual(base64.b64decode(result['data']), b'hello')
        self.assertEqual(result['offset'], 5)
        self.assertEqual(adapter.control('shell-resize', {**args, 'cols': 100, 'rows': 30}), {'resized': True})
        self.assertEqual(adapter.control('shell-close', args), {'closed': True})
        self.assertEqual(api.handles, set())
        self.assertTrue(terminal.close())

    def test_multiple_sessions_have_independent_jobs_and_no_fixed_count_cap(self):
        terminals = [self.terminal() for _ in range(12)]
        for index, (terminal, api) in enumerate(terminals):
            terminal.start()
            terminal.write(str(index))
        for index, (terminal, api) in enumerate(terminals):
            self.assertEqual(api.inputs, str(index).encode())
            self.assertTrue(terminal.close())

    def test_ring_is_bounded_with_exact_monotonic_truncation_cursor(self):
        terminal, api = self.terminal()
        terminal.start()
        for _ in range(20):
            api.output.put(b'x'*4096)
        result = self.wait_output(terminal, 81920)
        self.assertEqual(len(terminal.data), 65536)
        self.assertEqual(len(base64.b64decode(result['data'])), 65536)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['offset']-len(base64.b64decode(result['data'])), 16384)
        self.assertEqual(terminal.read(81920)['data'], '')
        with self.assertRaises(Error):
            terminal.read(81921)

    def test_output_continues_while_input_is_blocked(self):
        terminal, api = self.terminal()
        terminal.start()
        api.block_write = threading.Event()
        failures = []
        def write():
            try:
                terminal.write('command')
            except Error as error:
                failures.append(error)
        thread = threading.Thread(target=write)
        thread.start()
        try:
            api.output.put(b'still responsive')
            self.assertEqual(base64.b64decode(self.wait_output(terminal, 16)['data']), b'still responsive')
            self.assertTrue(thread.is_alive())
        finally:
            api.block_write.set()
            thread.join(2)
        self.assertEqual(failures, [])

    def test_startup_failures_retain_cleanup_authority_and_never_restart(self):
        for stage in ('job', 'configure_job', 'pipe', 'console', 'launch', 'resume'):
            terminal, api = self.terminal()
            api.failure = stage
            with self.subTest(stage=stage), self.assertRaises(Error) as caught:
                terminal.start()
            self.assertIsNone(caught.exception.outcome)
            self.assertEqual(api.handles, set())
            with self.assertRaises(Error):
                terminal.start()

    def test_unconfirmed_stop_keeps_all_handles_for_retry(self):
        terminal, api = self.terminal()
        terminal.start()
        handles = set(api.handles)
        api.failure = 'terminate'
        self.assertFalse(terminal.close())
        self.assertEqual(api.handles, handles)
        with self.assertRaises(Error):
            terminal.write('must not run')
        api.failure = None
        self.assertTrue(terminal.close())
        self.assertEqual(api.handles, set())

    def test_inflight_input_keeps_handles_until_writer_exits(self):
        terminal, api = self.terminal()
        terminal.start()
        api.block_write = threading.Event()
        failures = []
        def write():
            try:
                terminal.write('command')
            except Error as error:
                failures.append(error)
        thread = threading.Thread(target=write)
        thread.start()
        deadline = time.monotonic()+1
        while 'write' not in api.events and time.monotonic() < deadline:
            time.sleep(.005)
        handles = set(api.handles)
        try:
            self.assertFalse(terminal.close())
            self.assertEqual(api.handles, handles)
        finally:
            api.block_write.set()
            thread.join(2)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].outcome, 'unknown')
        self.assertTrue(terminal.close())
        self.assertEqual(api.handles, set())

    def test_failed_handle_release_is_not_reported_as_cleanup(self):
        terminal, api = self.terminal()
        terminal.start()
        api.failure = 'close_handle'
        self.assertFalse(terminal.close())
        self.assertTrue(api.handles)
        api.failure = None
        self.assertTrue(terminal.close())
        self.assertEqual(api.handles, set())

    def test_write_and_resize_uncertainty_fences_further_input(self):
        for operation in ('write', 'resize'):
            terminal, api = self.terminal()
            terminal.start()
            api.failure = operation
            with self.subTest(operation=operation), self.assertRaises(Error) as caught:
                terminal.write('input') if operation == 'write' else terminal.resize(100, 40)
            self.assertEqual(caught.exception.outcome, 'unknown')
            self.assertFalse(caught.exception.retryable)
            with self.assertRaises(Error):
                terminal.write('retry')
            api.failure = None

    def test_output_failure_is_explicit_and_fences_input(self):
        terminal, api = self.terminal()
        terminal.start()
        api.output.put(OSError('private path'))
        self.assertTrue(terminal.reader_done.wait(2))
        with self.assertRaises(Error):
            terminal.read()
        with self.assertRaises(Error):
            terminal.write('no')

    def test_invalid_dimensions_input_and_cursors_have_no_native_effect(self):
        terminal, api = self.terminal()
        for dimensions in ((0, 24), (80, 501), (True, 24)):
            with self.assertRaises(Error):
                terminal.start(*dimensions)
        self.assertEqual(api.events, [])
        terminal.start()
        for value in ('\0', '\ud800', 'x'*16385):
            with self.assertRaises(Error):
                terminal.write(value)
        self.assertEqual(api.inputs, b'')
        with self.assertRaises(Error):
            terminal.read(-1)

    def test_other_platform_never_falls_back_to_a_host_shell(self):
        if sys.platform != 'win32':
            with self.assertRaises(Error) as caught:
                Win32ConPTY()
            self.assertEqual(caught.exception.code, 'capability_unsupported')

    def test_native_launch_marshals_job_and_console_attributes_before_suspended_creation(self):
        from canaveral.guest.windows_conpty import H, SIZE, PROCESS_INFORMATION
        api = Win32ConPTY.__new__(Win32ConPTY)
        events = []
        def initialize(storage, count, flags, size):
            ctypes.cast(size, ctypes.POINTER(SIZE)).contents.value = 128
            self.assertEqual(count, 2)
            return bool(storage)
        def update(storage, flags, attribute, value, size, old, returned):
            events.append(attribute)
            if attribute == 0x2000D:
                self.assertEqual(ctypes.cast(value, ctypes.POINTER(H))[0], 77)
            else:
                self.assertEqual(attribute, 0x20016)
                self.assertEqual(value.value, 88)
            self.assertEqual(size, ctypes.sizeof(H))
            return True
        def create(executable, command, security, thread_security, inherit, flags, env, cwd, startup, result):
            self.assertEqual(events, [0x2000D, 0x20016])
            self.assertFalse(inherit)
            self.assertEqual(flags, 0x80004)
            self.assertEqual(command.value, '"C:\\Program Files\\shell.exe" -NoLogo')
            info = ctypes.cast(result, ctypes.POINTER(PROCESS_INFORMATION)).contents
            info.hProcess, info.hThread = 100, 101
            events.append('created')
            return True
        api.k = SimpleNamespace(InitializeProcThreadAttributeList=initialize,
            UpdateProcThreadAttribute=update, CreateProcessW=create,
            DeleteProcThreadAttributeList=lambda storage: events.append('deleted'))
        self.assertEqual(api.launch(r'C:\Program Files\shell.exe',
            [r'C:\Program Files\shell.exe', '-NoLogo'], r'C:\Users\guest', 88, 77), (100, 101))
        self.assertEqual(events[-2:], ['created', 'deleted'])

    def test_failed_native_attribute_setup_never_creates_a_process(self):
        from canaveral.guest.windows_conpty import SIZE
        api = Win32ConPTY.__new__(Win32ConPTY)
        events = []
        def initialize(storage, count, flags, size):
            ctypes.cast(size, ctypes.POINTER(SIZE)).contents.value = 128
            return bool(storage)
        api.k = SimpleNamespace(InitializeProcThreadAttributeList=initialize,
            UpdateProcThreadAttribute=lambda *args: False,
            CreateProcessW=lambda *args: self.fail('Must not create an unowned child'),
            DeleteProcThreadAttributeList=lambda storage: events.append('deleted'))
        with self.assertRaises(OSError):
            api.launch(r'C:\shell.exe', [r'C:\shell.exe'], r'C:\Users\guest', 88, 77)
        self.assertEqual(events, ['deleted'])
