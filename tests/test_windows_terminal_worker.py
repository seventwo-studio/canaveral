import base64
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import uuid

from canaveral.guest.windows_terminal_worker import WindowsTerminalWorker
from canaveral.model import Error


class TerminalWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.marker = Path(self.temp.name)/'effect'
        self.allowed = True

    def worker(self, mode='normal', timeout=2):
        command = [sys.executable, '-c',
            'import runpy,sys; path=sys.argv.pop(1); runpy.run_path(path,run_name="__main__")',
            str(Path(__file__).parent/'fixtures/windows_terminal_fixture.py'), mode, str(self.marker)]
        worker = WindowsTerminalWorker(str(uuid.uuid4()), r'C:\Windows\System32\cmd.exe',
            [r'C:\Windows\System32\cmd.exe'], r'C:\Users\guest', lambda: self.allowed,
            timeout=timeout, command=command)
        self.addCleanup(worker.close)
        return worker

    def call(self, worker, action, **arguments):
        return worker.control('shell-'+action, {'session': worker.session, **arguments})

    def wait_marker(self):
        deadline = time.monotonic()+2
        while not self.marker.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(self.marker.exists())

    def test_common_lifecycle_has_positive_terminal_and_worker_cleanup(self):
        worker = self.worker()
        self.assertEqual(self.call(worker, 'open'), {'session': worker.session})
        self.assertEqual(self.call(worker, 'write', text='héllo'), {'written': 6})
        self.assertEqual(self.call(worker, 'resize', cols=100, rows=30), {'resized': True})
        value = self.call(worker, 'read', offset=0)
        self.assertEqual(base64.b64decode(value['data']), b'output while input is pending')
        self.assertEqual(self.call(worker, 'close'), {'closed': True})
        self.assertTrue(worker.cleanup_confirmed)
        self.assertIsNotNone(worker.process.poll())
        self.assertFalse(worker.receiver.is_alive())
        self.assertEqual(self.call(worker, 'close'), {'closed': True})
        with self.assertRaises(Error): self.call(worker, 'open')

    def test_read_and_resize_refusal_do_not_wait_behind_blocked_input(self):
        worker = self.worker('slow-write', timeout=5)
        self.call(worker, 'open')
        values, failures = [], []
        def write():
            try: values.append(self.call(worker, 'write', text='command'))
            except Error as error: failures.append(error)
        thread = threading.Thread(target=write)
        thread.start()
        try:
            self.wait_marker()
            started = time.monotonic()
            value = self.call(worker, 'read', offset=0)
            self.assertIn(b'output', base64.b64decode(value['data']))
            self.assertLess(time.monotonic()-started, 1)
            self.assertTrue(thread.is_alive())
            with self.assertRaises(Error) as caught:
                self.call(worker, 'resize', cols=100, rows=30)
            self.assertEqual(caught.exception.code, 'input_busy')
        finally:
            self.marker.with_suffix('.release').touch()
            thread.join(3)
        self.assertEqual(failures, [])
        self.assertEqual(values, [{'written': 7}])
        self.assertEqual(self.call(worker, 'close'), {'closed': True})

    def test_uncertain_write_fences_input_but_preserves_reads_and_explicit_close(self):
        worker = self.worker('uncertain-write')
        self.call(worker, 'open')
        with self.assertRaises(Error) as caught: self.call(worker, 'write', text='command')
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertNotIn('private', str(caught.exception))
        with self.assertRaises(Error): self.call(worker, 'write', text='retry')
        self.assertFalse(worker.closed.is_set())
        self.assertIn(b'output', base64.b64decode(self.call(worker, 'read', offset=0)['data']))
        self.assertEqual(self.call(worker, 'close'), {'closed': True})
        self.assertTrue(worker.cleanup_confirmed)

    def test_timed_out_write_never_confuses_worker_exit_with_terminal_cleanup(self):
        worker = self.worker('hang-write', timeout=.6)
        self.call(worker, 'open')
        with self.assertRaises(Error) as caught: self.call(worker, 'write', text='command')
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertFalse(caught.exception.retryable)
        self.assertTrue(worker.closed.is_set())
        self.assertFalse(worker.cleanup_confirmed)
        self.assertIsNotNone(worker.process.poll())
        with self.assertRaises(Error): self.call(worker, 'write', text='retry')

    def test_unconfirmed_native_close_stays_unknown_after_forced_worker_exit(self):
        worker = self.worker('uncertain-close')
        self.call(worker, 'open')
        with self.assertRaises(Error) as caught: self.call(worker, 'close')
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertFalse(worker.cleanup_confirmed)
        self.assertTrue(worker.closed.is_set())
        self.assertIsNotNone(worker.process.poll())

    def test_constructor_failure_can_confirm_cleanup_without_native_execution(self):
        worker = self.worker('constructor-failure')
        with self.assertRaises(Error): self.call(worker, 'open')
        self.assertFalse(worker.cleanup_confirmed)
        self.assertEqual(self.call(worker, 'close'), {'closed': True})
        self.assertTrue(worker.cleanup_confirmed)
        self.assertIsNotNone(worker.process.poll())

    def test_invalid_write_acknowledgement_cannot_confirm_input(self):
        worker = self.worker('bad-write-ack')
        self.call(worker, 'open')
        with self.assertRaises(Error) as caught: self.call(worker, 'write', text='command')
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertTrue(worker.closed.is_set())
        self.assertFalse(worker.cleanup_confirmed)

    def test_pre_effect_validation_and_session_binding_do_not_launch_child(self):
        worker = self.worker()
        for action, args in [('shell-open', {'session': str(uuid.uuid4())}),
                             ('shell-open', {'session': worker.session, 'cols': 0}),
                             ('shell-close', {'session': worker.session}),
                             ('shell-write', {'session': worker.session, 'text': '\0'})]:
            with self.assertRaises(Error): worker.control(action, args)
        self.assertIsNone(worker.process)
        self.assertEqual(self.call(worker, 'open'), {'session': worker.session})

    def test_sequential_input_acknowledgements_make_lane_ready_for_next_chunk(self):
        worker = self.worker()
        self.call(worker, 'open')
        for index in range(40):
            text = str(index)
            self.assertEqual(self.call(worker, 'write', text=text), {'written': len(text)})
        self.assertEqual(self.call(worker, 'close'), {'closed': True})

    def test_active_revocation_interrupts_pending_input_and_both_io_threads(self):
        worker = self.worker('hang-write', timeout=5)
        self.call(worker, 'open')
        errors = []
        def write():
            try: self.call(worker, 'write', text='command')
            except Error as error: errors.append(error)
        thread = threading.Thread(target=write)
        thread.start()
        try:
            self.wait_marker()
            self.allowed = False
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertEqual(errors[0].outcome, 'unknown')
            self.assertTrue(worker.closed.is_set())
            self.assertIsNotNone(worker.process.poll())
            self.assertFalse(worker.cleanup_confirmed)
        finally:
            worker.close()
            thread.join(2)

    def test_multiple_terminals_have_no_shared_count_cap_or_input_lock(self):
        workers = [self.worker() for _ in range(9)]
        for worker in workers: self.call(worker, 'open')
        self.assertEqual(len({worker.process.pid for worker in workers}), 9)
        for index, worker in enumerate(workers):
            self.assertEqual(self.call(worker, 'write', text=str(index)), {'written': 1})
        for worker in workers: self.assertEqual(self.call(worker, 'close'), {'closed': True})

    def test_idle_revocation_reaps_both_io_threads_and_keeps_cleanup_unknown(self):
        worker = self.worker()
        self.call(worker, 'open')
        self.allowed = False
        worker.thread.join(2)
        worker.receiver.join(2)
        self.assertFalse(worker.thread.is_alive())
        self.assertFalse(worker.receiver.is_alive())
        self.assertIsNotNone(worker.process.poll())
        self.assertFalse(worker.cleanup_confirmed)

    def test_hung_start_and_bad_correlation_never_restart_worker(self):
        for mode in ('hang-start', 'mismatch'):
            worker = self.worker(mode, timeout=.6)
            with self.subTest(mode=mode), self.assertRaises(Error) as caught:
                self.call(worker, 'open')
            self.assertEqual(caught.exception.outcome, 'unknown')
            self.assertTrue(worker.closed.is_set())
            self.assertFalse(worker.cleanup_confirmed)
            with self.assertRaises(Error): self.call(worker, 'open')

    def test_default_does_not_start_host_shell_on_another_platform(self):
        if sys.platform != 'win32':
            with self.assertRaises(Error) as caught:
                WindowsTerminalWorker(str(uuid.uuid4()), r'C:\shell.exe', [r'C:\shell.exe'],
                                      r'C:\Users\guest', lambda: True)
            self.assertEqual(caught.exception.code, 'capability_unsupported')
