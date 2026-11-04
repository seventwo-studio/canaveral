import io
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from canaveral.guest.windows_worker import WindowsWorker, _packet, _read_packet
from canaveral.model import Error


class WindowsWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.marker = Path(self.temp.name)/'effects'
        self.allowed = True

    def worker(self, mode='normal', timeout=2):
        worker = WindowsWorker(lambda: self.allowed, timeout=timeout,
            command=[sys.executable, '-c',
                     'import runpy, sys; path=sys.argv.pop(1); runpy.run_path(path, run_name="__main__")',
                     str(Path(__file__).parent/'fixtures/windows_worker_fixture.py'),
                     mode, str(self.marker)])
        self.addCleanup(worker.close)
        return worker

    def invoke(self, worker, value):
        return worker.invoke(value['snapshotId'], value['nodes'][-1]['id'], 'invoke')

    def wait_marker(self, contents=None):
        deadline = time.monotonic()+2
        while time.monotonic() < deadline:
            if self.marker.exists() and (contents is None or self.marker.read_text() == contents):
                return
            time.sleep(.01)
        self.fail('Owned fixture did not enter its blocking call')

    def test_same_child_retains_snapshot_handles_then_refuses_replay(self):
        worker = self.worker()
        value = worker.inspect()
        process = worker.process
        self.assertEqual(self.invoke(worker, value), {'status': 'posted'})
        self.assertIs(worker.process, process)
        with self.assertRaises(Error) as caught:
            self.invoke(worker, value)
        self.assertEqual(caught.exception.code, 'input_rejected')
        self.assertIsNone(caught.exception.outcome)
        self.assertTrue(worker.close())
        self.assertIsNotNone(process.poll())

    def test_refresh_invalidates_previous_snapshot(self):
        worker = self.worker()
        first = worker.inspect()
        worker.inspect()
        with self.assertRaises(Error) as caught:
            self.invoke(worker, first)
        self.assertEqual(caught.exception.code, 'input_rejected')
        self.assertFalse(worker.closed.is_set())

    def test_hung_inspection_is_bounded_and_worker_cannot_restart_itself(self):
        worker = self.worker('hang-inspect', timeout=.6)
        started = time.monotonic()
        with self.assertRaises(Error) as caught:
            worker.inspect()
        self.assertLess(time.monotonic()-started, 2)
        self.assertEqual(caught.exception.code, 'worker_interrupted')
        self.assertIsNone(caught.exception.outcome)
        self.assertTrue(worker.closed.is_set())
        process = worker.process
        self.assertIsNotNone(process.poll())
        with self.assertRaises(Error):
            worker.inspect()
        self.assertIs(worker.process, process)

    def test_second_call_is_busy_instead_of_waiting_behind_native_provider(self):
        worker = self.worker('hang-inspect')
        errors = []
        def inspect():
            try:
                worker.inspect()
            except Error as error:
                errors.append(error)
        thread = threading.Thread(target=inspect)
        thread.start()
        try:
            self.wait_marker()
            started = time.monotonic()
            with self.assertRaises(Error) as caught:
                worker.inspect()
            self.assertEqual(caught.exception.code, 'input_busy')
            self.assertLess(time.monotonic()-started, .2)
        finally:
            self.assertTrue(worker.close())
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)

    def test_timed_out_invocation_is_unknown_and_is_not_replayed(self):
        worker = self.worker('hang-invoke')
        value = worker.inspect()
        # A loaded runner may exhaust a short deadline before dispatch, which
        # correctly has no unknown effect. Advance this worker's clock only
        # after the real child confirms it entered the native-shaped call.
        now, errors = [100.0], []
        def invoke():
            try: self.invoke(worker, value)
            except Error as error: errors.append(error)
        with patch('canaveral.guest.windows_worker.time', SimpleNamespace(monotonic=lambda: now[0])):
            thread = threading.Thread(target=invoke)
            thread.start()
            try:
                self.wait_marker('invoked\n')
                now[0] += worker.timeout + 1
                thread.join(2)
                self.assertFalse(thread.is_alive())
            finally:
                worker.close();thread.join(2)
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].outcome, 'unknown')
        self.assertFalse(errors[0].retryable)
        self.assertEqual(self.marker.read_text(), 'invoked\n')
        self.assertTrue(worker.close())
        with self.assertRaises(Error):
            self.invoke(worker, value)
        self.assertEqual(self.marker.read_text(), 'invoked\n')

    def test_native_uncertainty_preserves_typed_outcome_without_private_text(self):
        worker = self.worker('uncertain')
        value = worker.inspect()
        with self.assertRaises(Error) as caught:
            self.invoke(worker, value)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertNotIn('private', str(caught.exception))
        with self.assertRaises(Error) as replay:
            self.invoke(worker, value)
        self.assertEqual(replay.exception.code, 'input_rejected')
        self.assertEqual(self.marker.read_text(), 'invoked\n')

    def test_revocation_while_native_call_hangs_closes_owned_worker(self):
        worker = self.worker('hang-inspect', timeout=5)
        errors = []
        def inspect():
            try:
                worker.inspect()
            except Error as error:
                errors.append(error)
        thread = threading.Thread(target=inspect)
        thread.start()
        try:
            self.wait_marker()
            self.allowed = False
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertTrue(worker.closed.is_set())
            self.assertIsNotNone(worker.process.poll())
        finally:
            worker.close()
            thread.join(2)

    def test_pre_dispatch_revocation_never_creates_child(self):
        worker = self.worker()
        self.allowed = False
        with self.assertRaises(Error):
            worker.inspect()
        self.assertIsNone(worker.process)
        self.assertTrue(worker.close())

    def test_idle_revocation_stops_worker_without_another_api_call(self):
        worker = self.worker()
        worker.inspect()
        process = worker.process
        self.allowed = False
        worker.thread.join(2)
        self.assertFalse(worker.thread.is_alive())
        self.assertTrue(worker.closed.is_set())
        self.assertIsNotNone(process.poll())

    @unittest.skipIf(sys.platform == 'win32', 'POSIX signal fixture; Windows termination needs native proof')
    def test_ignored_terminate_escalates_only_the_owned_child_to_kill(self):
        worker = self.worker('ignore-terminate', timeout=.6)
        started = time.monotonic()
        with self.assertRaises(Error):
            worker.inspect()
        self.assertLess(time.monotonic()-started, 2)
        self.assertTrue(self.marker.exists())
        self.assertTrue(worker.close())
        self.assertIsNotNone(worker.process.poll())

    def test_unconfirmed_stop_is_false_and_retains_child_for_explicit_retry(self):
        worker = self.worker()
        worker.inspect()
        process = worker.process
        with patch.object(process, 'terminate', side_effect=OSError('private stop denied')):
            self.assertFalse(worker.close())
            self.assertIsNone(process.poll())
        self.assertTrue(worker.close())
        self.assertIs(worker.process, process)
        self.assertIsNotNone(process.poll())

    def test_invalid_acknowledgement_crash_and_oversize_poison_worker(self):
        for mode in ('oversized', 'truncated', 'mismatched', 'bad-snapshot', 'crash'):
            worker = self.worker(mode)
            with self.subTest(mode=mode), self.assertRaises(Error):
                worker.inspect()
            self.assertTrue(worker.closed.is_set())
            self.assertTrue(worker.close())
            self.assertIsNotNone(worker.process.poll())

    def test_invalid_action_acknowledgement_cannot_confirm_native_effect(self):
        for mode in ('bad-action', 'false-refusal'):
            worker = self.worker(mode)
            with self.subTest(mode=mode), self.assertRaises(Error) as caught:
                worker.invoke('snapshot', 'node', 'invoke')
            self.assertEqual(caught.exception.outcome, 'unknown')
            self.assertTrue(worker.closed.is_set())

    def test_packets_bound_lengths_and_reject_partial_or_nonobject_json(self):
        self.assertEqual(_read_packet(io.BytesIO(_packet({'a': 1}, 100)), 100), {'a': 1})
        for raw in (b'', b'\0', struct.pack('!I', 200), struct.pack('!I', 2)+b'{',
                    struct.pack('!I', 2)+b'[]'):
            with self.subTest(raw=raw), self.assertRaises((ValueError, EOFError)):
                _read_packet(io.BytesIO(raw), 100)
        with self.assertRaises(ValueError):
            _packet({'data': 'x'*200}, 100)

    def test_oversized_request_is_refused_before_launch(self):
        worker = self.worker()
        with self.assertRaises(Error):
            worker.invoke('x'*20000, 'node', 'invoke')
        self.assertIsNone(worker.process)
        self.assertTrue(worker.close())

    def test_child_that_never_reads_cannot_block_request_write_or_cancellation(self):
        worker = self.worker('never-read', timeout=.6)
        started = time.monotonic()
        with self.assertRaises(Error) as caught:
            worker.invoke('x'*10000, 'node', 'invoke')
        self.assertLess(time.monotonic()-started, 2)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertTrue(worker.close())
        self.assertIsNotNone(worker.process.poll())

    def test_late_process_creation_after_close_never_dispatches_and_is_reaped(self):
        entered, release = threading.Event(), threading.Event()
        real_popen = subprocess.Popen
        def delayed(*args, **kwargs):
            entered.set()
            release.wait(3)
            return real_popen(*args, **kwargs)
        worker = self.worker('mark-inspect', timeout=.2)
        errors = []
        def inspect():
            try:
                worker.inspect()
            except Error as error:
                errors.append(error)
        with patch('canaveral.guest.windows_worker.subprocess.Popen', side_effect=delayed):
            thread = threading.Thread(target=inspect)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertFalse(worker.close())  # Start is not yet confirmed stopped.
            finally:
                release.set()
                thread.join(3)
                worker.thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertTrue(worker.close())
        self.assertEqual(len(errors), 1)
        self.assertIsNone(errors[0].outcome)
        self.assertIsNotNone(worker.process.poll())
        self.assertFalse(self.marker.exists())

    def test_worker_constructor_validates_timeout_and_has_no_implicit_host_fallback(self):
        for timeout in (0, -1, float('nan'), 31, True):
            with self.assertRaises(Error):
                WindowsWorker(lambda: True, timeout=timeout, command=['fixture'])
        if sys.platform != 'win32':
            with self.assertRaises(Error) as caught:
                WindowsWorker(lambda: True)
            self.assertEqual(caught.exception.code, 'capability_unsupported')
