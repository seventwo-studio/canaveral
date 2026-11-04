"""Owned fixture subprocesses; native Windows pipe/filesystem proof is absent."""
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

from canaveral.guest.windows_file_worker import WindowsFileWorker
from canaveral.guest_chunk_files import GuestChunkFiles, CHUNK
from canaveral.model import Error


class WindowsFileWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.marker = Path(self.temp.name)/'read'
        self.allowed = True

    def worker(self, mode='normal', timeout=2):
        def resolve(path):
            if path == '/': return ()
            if path == '/data': return ('data',)
            raise Error('Unbound guest path.', 400)
        worker = WindowsFileWorker('C:', ('home',), resolve, lambda: self.allowed,
            timeout=timeout, command=[sys.executable, '-c',
                'import runpy,sys; path=sys.argv.pop(1); runpy.run_path(path,run_name="__main__")',
                str(Path(__file__).parent/'fixtures/windows_file_worker_fixture.py'), mode, str(self.marker)])
        self.addCleanup(worker.close)
        return worker

    def call(self, worker, route, **body):
        return worker('/v1/files/'+route, body)

    def begin(self, worker):
        identity = str(uuid.uuid4())
        self.assertEqual(self.call(worker, 'download/begin', id=identity, path='/data')['state'], 'reading')
        return identity

    def wait_marker(self):
        deadline = time.monotonic()+2
        while not self.marker.exists() and time.monotonic() < deadline: time.sleep(.01)
        self.assertTrue(self.marker.exists())

    def test_shared_adapter_multichunk_and_positive_root_shutdown(self):
        worker = self.worker()
        files = GuestChunkFiles(worker)
        self.assertEqual(files.list('/')['entries'][0]['name'], 'data')
        download = files.download('/data')
        received = bytearray()
        download.verify()
        while True:
            data = download.read(20000)
            if not data: break
            received.extend(data)
        self.assertEqual(received, bytes(range(256))*4100)
        download.verify()
        download.close()
        process = worker.process
        self.assertTrue(worker.shutdown())
        self.assertTrue(worker.cleanup_confirmed)
        self.assertIsNotNone(process.poll())
        self.assertFalse(worker.thread.is_alive())
        self.assertTrue(worker.shutdown())
        with self.assertRaises(Error): self.call(worker, 'list', path='/')
        self.assertIs(worker.process, process)

    def test_large_listing_is_not_limited_to_pipe_capacity(self):
        worker = self.worker('large-list')
        listing = self.call(worker, 'list', path='/')
        self.assertEqual(len(listing['entries']), 1000)
        self.assertTrue(worker.shutdown())

    def test_malformed_and_unbound_requests_never_launch_child(self):
        worker = self.worker()
        for route, body in [('download/begin', {'id': 'bad', 'path': '/data'}),
                            ('download/chunk', {'id': str(uuid.uuid4()), 'offset': True}),
                            ('download/begin', {'id': str(uuid.uuid4()), 'path': '/unbound'}),
                            ('list', {'path': '/', 'extra': 1}), ('upload/begin', {})]:
            with self.subTest(route=route), self.assertRaises(Error): self.call(worker, route, **body)
        self.assertIsNone(worker.process)
        self.assertTrue(worker.shutdown())
        self.assertTrue(worker.cleanup_confirmed)

    def test_busy_request_does_not_wait_behind_native_read(self):
        worker = self.worker('slow-read')
        identity = self.begin(worker)
        errors, results = [], []
        def read():
            try: results.append(self.call(worker, 'download/chunk', id=identity, offset=0))
            except Error as error: errors.append(error)
        thread = threading.Thread(target=read)
        thread.start()
        try:
            self.wait_marker()
            started = time.monotonic()
            with self.assertRaises(Error) as caught: self.call(worker, 'status', id=identity)
            self.assertEqual(caught.exception.code, 'input_busy')
            self.assertLess(time.monotonic()-started, .2)
            self.assertFalse(worker.shutdown())
        finally:
            self.marker.with_suffix('.release').touch()
            thread.join(3)
        self.assertEqual(errors, [])
        self.assertEqual(results[0]['offset'], CHUNK)
        self.assertTrue(worker.shutdown())

    def test_timed_out_read_never_reopens_or_replays_cursor(self):
        worker = self.worker('hang-read', timeout=.6)
        identity = self.begin(worker)
        started = time.monotonic()
        with self.assertRaises(Error) as caught: self.call(worker, 'download/chunk', id=identity, offset=0)
        self.assertLess(time.monotonic()-started, 2)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertFalse(caught.exception.retryable)
        self.assertTrue(worker.closed.is_set())
        self.assertFalse(worker.cleanup_confirmed)
        self.assertIsNotNone(worker.process.poll())
        self.assertEqual(self.marker.read_text(), '0\n')
        with self.assertRaises(Error): self.call(worker, 'download/chunk', id=identity, offset=0)
        self.assertEqual(self.marker.read_text(), '0\n')
        self.assertFalse(worker.shutdown())

    def test_active_revocation_stops_owned_child_without_late_data(self):
        worker = self.worker('hang-read', timeout=5)
        identity = self.begin(worker)
        errors = []
        def read():
            try: self.call(worker, 'download/chunk', id=identity, offset=0)
            except Error as error: errors.append(error)
        thread = threading.Thread(target=read)
        thread.start()
        try:
            self.wait_marker()
            self.allowed = False
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertEqual(errors[0].outcome, 'unknown')
            self.assertIsNotNone(worker.process.poll())
            self.assertFalse(worker.cleanup_confirmed)
        finally:
            worker.close()
            thread.join(2)

    def test_idle_revocation_stops_process_and_never_adopts_after_restore(self):
        worker = self.worker()
        self.begin(worker)
        process = worker.process
        self.allowed = False
        worker.thread.join(2)
        self.assertFalse(worker.thread.is_alive())
        self.assertIsNotNone(process.poll())
        self.allowed = True
        with self.assertRaises(Error): self.call(worker, 'list', path='/')
        self.assertIs(worker.process, process)
        self.assertFalse(worker.cleanup_confirmed)

    def test_pre_dispatch_revocation_creates_no_process(self):
        worker = self.worker()
        self.allowed = False
        with self.assertRaises(Error): self.call(worker, 'list', path='/')
        self.assertIsNone(worker.process)
        self.assertTrue(worker.shutdown())

    def test_unconfirmed_root_close_remains_unknown_after_forced_stop(self):
        worker = self.worker('uncertain-close')
        self.begin(worker)
        self.assertFalse(worker.shutdown())
        self.assertFalse(worker.cleanup_confirmed)
        with self.assertRaises(Error): self.call(worker, 'list', path='/')
        self.assertTrue(worker.close())
        self.assertFalse(worker.cleanup_confirmed)
        self.assertFalse(worker.shutdown())

    def test_explicit_shutdown_retries_only_retained_native_cleanup(self):
        worker = self.worker('retry-close')
        self.begin(worker)
        self.assertFalse(worker.shutdown())
        self.marker.with_suffix('.release').touch()
        self.assertTrue(worker.shutdown())
        self.assertTrue(worker.cleanup_confirmed)

    def test_constructor_failure_can_confirm_positively_unstarted_cleanup(self):
        worker = self.worker('constructor-failure')
        with self.assertRaises(Error): self.call(worker, 'list', path='/')
        self.assertFalse(worker.cleanup_confirmed)
        self.assertTrue(worker.shutdown())

    def test_bad_packets_poison_worker_and_redact_native_details(self):
        for mode in ('mismatch', 'oversize', 'truncated', 'bad-open', 'false-refusal'):
            worker = self.worker(mode)
            with self.subTest(mode=mode), self.assertRaises(Error) as caught: self.call(worker, 'list', path='/')
            self.assertEqual(caught.exception.outcome, 'unknown')
            self.assertNotIn('private', str(caught.exception))
            self.assertTrue(worker.closed.is_set())
            self.assertTrue(worker.close())
            self.assertFalse(worker.cleanup_confirmed)

    def test_bad_chunk_and_close_receipts_cannot_confirm_success(self):
        for mode in ('bad-chunk', 'bad-close'):
            worker = self.worker(mode)
            identity = self.begin(worker)
            with self.subTest(mode=mode), self.assertRaises(Error) as caught:
                if mode == 'bad-chunk': self.call(worker, 'download/chunk', id=identity, offset=0)
                else: worker.shutdown()
            self.assertEqual(caught.exception.outcome, 'unknown')
            self.assertTrue(worker.closed.is_set())
            self.assertFalse(worker.cleanup_confirmed)

    def test_crash_and_hung_start_cannot_claim_native_cleanup(self):
        for mode in ('crash-read', 'hang-open'):
            worker = self.worker(mode, timeout=.6)
            with self.subTest(mode=mode), self.assertRaises(Error):
                identity = self.begin(worker)
                self.call(worker, 'download/chunk', id=identity, offset=0)
            self.assertTrue(worker.close())
            self.assertFalse(worker.cleanup_confirmed)

    def test_independent_worker_can_read_while_another_native_read_stalls(self):
        first, second = self.worker('hang-read', timeout=5), self.worker()
        identity = self.begin(first)
        errors = []
        def read():
            try: self.call(first, 'download/chunk', id=identity, offset=0)
            except Error as error: errors.append(error)
        thread = threading.Thread(target=read)
        thread.start()
        try:
            self.wait_marker()
            self.assertEqual(self.call(second, 'list', path='/')['entries'][0]['name'], 'data')
            self.assertTrue(second.shutdown())
        finally:
            first.close()
            thread.join(2)
        self.assertEqual(len(errors), 1)

    def test_child_not_reading_large_request_cannot_block_api_or_cleanup(self):
        worker = self.worker('never-files', timeout=.6)
        worker.resolve = lambda path: ('data',)
        started = time.monotonic()
        with self.assertRaises(Error) as caught:
            self.call(worker, 'download/begin', id=str(uuid.uuid4()), path='/'+'x'*200000)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertLess(time.monotonic()-started, 2)
        self.assertTrue(worker.close())
        self.assertFalse(worker.thread.is_alive())
        self.assertFalse(worker.cleanup_confirmed)

    def test_native_cleanup_receipt_is_retained_while_process_stop_is_unconfirmed(self):
        worker = self.worker()
        self.begin(worker)
        process = worker.process
        with patch.object(process, 'terminate', side_effect=OSError('owned process stop denied')):
            self.assertFalse(worker.shutdown())
            self.assertTrue(worker.native_cleanup_confirmed)
            self.assertFalse(worker.cleanup_confirmed)
        self.assertTrue(worker.shutdown())
        self.assertTrue(worker.cleanup_confirmed)
        self.assertIsNotNone(process.poll())


if __name__ == '__main__': unittest.main()
